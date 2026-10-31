/**
 * Motor do Gateway — identificação real, catálogo por capacidade e política de
 * execução (roteamento, timeout, circuit breaker, retry limitado, fallback sem
 * loop e bloqueio de custo pago).
 *
 * ── Por que este módulo existe ──────────────────────────────────────────────
 * O v0.4.0 fazia o essencial bem: falava com o upstream, repassava o stream e
 * media latência. Mas ele não respondia à pergunta "qual motor REALMENTE
 * respondeu?". O nome do modelo era **repetido de volta** (`model: request.model`)
 * e nunca lido da resposta do provedor. Ou seja: `gpt-6-luna` no cliente era o
 * nome PEDIDO, não uma identificação observada.
 *
 * Aqui a separação é explícita e não negociável:
 *   model_requested  → o que o cliente pediu (ou o primário, se não pediu nada)
 *   model_selected   → o que a política escolheu executar
 *   model_reported   → o que o PROVEDOR declarou ter usado (`response.model`)
 *   provider         → quem executou (ex.: `siwc-responses` → api.openai.com)
 *   identity_verified→ só true quando o provedor informou o modelo
 *
 * ── Princípios (do pedido do responsável) ──────────────────────────────────
 * 1. O modelo primário é preservado para texto, conversa, raciocínio e
 *    planejamento. Não trocamos de modelo só porque outro está disponível.
 * 2. Modelo alternativo só entra por: pedido explícito do usuário; capacidade
 *    que o primário não tem; falha comprovada do primário; tarefa especializada
 *    previamente aprovada.
 * 3. Nenhum loop de fallback: a cadeia é uma lista ordenada e sem repetição, e
 *    cada modelo é tentado no máximo uma vez.
 * 4. Custo pago é bloqueado por padrão (`cost_policy: plan-only`).
 * 5. Toda decisão é registrada — inclusive quando nada é executado.
 *
 * ── Compatibilidade ────────────────────────────────────────────────────────
 * Tudo é opt-in por configuração. Sem `KIRANA_ROUTING`/`KIRANA_FALLBACK_MODEL`,
 * o resultado é idêntico ao v0.4.0: o modelo pedido é o modelo executado e não
 * existe fallback. A suíte de regressão do v0.4.0 continua passando.
 */

/** Classes de custo. `plan` = uso do plano já contratado; `paid` = cobrança por chamada. */
export const COST = Object.freeze({ PLAN: 'plan', FREE: 'free', PAID: 'paid' });

/** Códigos de recusa — todos com mensagem acionável e `retryable` explícito. */
export const ENGINE_ERRORS = Object.freeze({
  MODEL_NOT_ALLOWED: 'model_not_allowed',
  COST_BLOCKED: 'cost_blocked',
  CAPABILITY_UNAVAILABLE: 'capability_unavailable',
  NO_CANDIDATE: 'no_candidate_available',
  ALL_FAILED: 'all_candidates_failed',
  TIMEOUT: 'engine_timeout',
});

const DEFAULT_TIMEOUTS = Object.freeze({
  /** Tentativa única de modelo (o v0.4.0 usava 180 s fixos no upstream). */
  attemptMs: 180_000,
  /** Model discovery. */
  discoveryMs: 30_000,
});

const DEFAULT_RETRY = Object.freeze({
  /** Tentativas POR MODELO. 1 = sem repetição do mesmo modelo. */
  attemptsPerModel: 1,
  /** Modelos distintos na cadeia de fallback (2 = primário + 1 alternativa). */
  maxFallbackHops: 1,
});

/**
 * Circuit breaker por modelo. Fecha a porta depois de N falhas consecutivas e
 * reabre em "meio-aberto" após `resetMs`, permitindo UMA tentativa de sondagem.
 * Não guarda estado em disco: reiniciar o Gateway zera (é o comportamento
 * seguro — não herdar um "aberto" de uma sessão antiga).
 */
export class CircuitBreaker {
  #state = new Map();

  constructor({ failureThreshold = 3, resetMs = 30_000, now = Date.now } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetMs = resetMs;
    this.now = now;
  }

  #entry(model) {
    let entry = this.#state.get(model);
    if (!entry) {
      entry = { failures: 0, openedAt: 0, probing: false };
      this.#state.set(model, entry);
    }
    return entry;
  }

  /** Pode tentar este modelo agora? */
  allow(model) {
    const entry = this.#entry(model);
    if (entry.failures < this.failureThreshold) return true;
    const elapsed = this.now() - entry.openedAt;
    if (elapsed < this.resetMs) return false;
    // Meio-aberto: uma única sondagem por janela.
    if (entry.probing) return false;
    entry.probing = true;
    return true;
  }

  record(model, ok) {
    const entry = this.#entry(model);
    if (ok) {
      entry.failures = 0;
      entry.openedAt = 0;
      entry.probing = false;
      return;
    }
    entry.failures += 1;
    entry.probing = false;
    if (entry.failures >= this.failureThreshold) entry.openedAt = this.now();
  }

  status(model) {
    const entry = this.#state.get(model);
    if (!entry) return { model, state: 'closed', failures: 0 };
    const open = entry.failures >= this.failureThreshold && this.now() - entry.openedAt < this.resetMs;
    return { model, state: open ? 'open' : entry.failures >= this.failureThreshold ? 'half_open' : 'closed', failures: entry.failures };
  }

  reset() {
    this.#state.clear();
  }
}

/**
 * Catálogo de capacidades — três estados que NÃO podem ser confundidos:
 *   `declared`     → o modelo/documentação diz que suporta (não testamos)
 *   `tested`       → passou num teste registrado (com data e origem)
 *   `unavailable`  → testado e reprovado, ou sem adaptador
 *
 * Qualquer capacidade sem entrada é tratada como `unknown` — e `unknown` nunca
 * é promovido a `tested` por inferência.
 */
export class CapabilityCatalog {
  #byModel = new Map();

  declare(model, { provider, cost = COST.PLAN, capabilities = {}, notes = null } = {}) {
    if (typeof model !== 'string' || !model.trim()) throw new TypeError('declare() exige um identificador de modelo.');
    if (!Object.values(COST).includes(cost)) throw new TypeError(`Custo desconhecido: ${cost}`);
    const declared = Object.fromEntries(Object.entries(capabilities).map(([name, value]) => [name, value === true]));
    this.#byModel.set(model, {
      model,
      provider: provider || null,
      cost,
      declared,
      tested: {},
      unavailable: {},
      notes,
    });
    return this;
  }

  /** Registra resultado de teste. `ok === false` marca indisponível de forma permanente. */
  recordTest(model, capability, { ok, at = new Date().toISOString(), detail = null, source = 'local' } = {}) {
    const entry = this.#byModel.get(model);
    if (!entry) throw new TypeError(`Modelo não declarado: ${model}`);
    if (ok) {
      entry.tested[capability] = { at, detail, source };
      delete entry.unavailable[capability];
    } else {
      entry.unavailable[capability] = { at, detail, source };
      delete entry.tested[capability];
    }
    return this;
  }

  /** `tested` | `declared` | `unavailable` | `unknown` — nesta ordem de confiança. */
  statusFor(model, capability) {
    const entry = this.#byModel.get(model);
    if (!entry) return 'unknown';
    if (entry.unavailable[capability]) return 'unavailable';
    if (entry.tested[capability]) return 'tested';
    if (entry.declared[capability]) return 'declared';
    return 'unknown';
  }

  /**
   * Suporta? `tested` e `declared` contam como suporte; `unavailable` e
   * `unknown` não. Quem precisa de garantia usa `requires: 'tested'`.
   */
  supports(model, capability, { requires = 'declared' } = {}) {
    const status = this.statusFor(model, capability);
    if (status === 'tested') return true;
    if (requires === 'tested') return false;
    return status === 'declared';
  }

  get(model) {
    const entry = this.#byModel.get(model);
    if (!entry) return null;
    const capabilities = new Set([...Object.keys(entry.declared), ...Object.keys(entry.tested), ...Object.keys(entry.unavailable)]);
    return {
      model: entry.model,
      provider: entry.provider,
      cost: entry.cost,
      notes: entry.notes,
      capabilities: Object.fromEntries([...capabilities].sort().map((name) => [name, this.statusFor(entry.model, name)])),
    };
  }

  list() {
    return [...this.#byModel.keys()].map((model) => this.get(model));
  }
}

/**
 * Escolhe a cadeia de execução. Função pura (menos o breaker): devolve
 * `{ chain, decision }` onde `chain` é a lista ORDENADA e SEM REPETIÇÃO de
 * modelos a tentar, e `decision` explica o porquê em texto auditável.
 *
 * Regras, na ordem em que são aplicadas:
 *   1. pedido explícito do usuário vence tudo — mas custo pago é checado antes;
 *   2. capacidade não suportada pelo primário → candidato especializado aprovado;
 *   3. caso normal → primário (sempre primeiro, nunca trocado por disponibilidade);
 *   4. fallback só entra se configurado E se o erro do primário for de infraestrutura.
 */
export function selectChain({
  capability = 'text.chat',
  primary,
  fallback = null,
  requestedModel = null,
  explicit = false,
  specialized = {},
  catalog,
  costPolicy = 'plan-only',
  maxFallbackHops = DEFAULT_RETRY.maxFallbackHops,
  breaker = null,
} = {}) {
  const decision = { capability, reason: null, skipped: [], requested_model: requestedModel || null, explicit: Boolean(explicit) };

  const blocked = (code, message, extra = {}) => ({
    chain: [],
    decision: { ...decision, ...extra, blocked: { code, message } },
  });
  const allowedByCost = (model) => {
    const entry = catalog?.get(model);
    const cost = entry?.cost ?? COST.PLAN;
    if (costPolicy === 'plan-only' && cost === COST.PAID) {
      return { ok: false, cost };
    }
    return { ok: true, cost };
  };

  /* 1. Pedido explícito ---------------------------------------------------- */
  if (explicit && requestedModel) {
    const cost = allowedByCost(requestedModel);
    if (!cost.ok) {
      return blocked(ENGINE_ERRORS.COST_BLOCKED, `O modelo "${requestedModel}" é de custo pago e a política atual é "${costPolicy}". Peça autorização explícita antes de usar.`, { model: requestedModel, cost: cost.cost });
    }
    if (catalog && catalog.statusFor(requestedModel, capability) === 'unavailable') {
      return blocked(ENGINE_ERRORS.CAPABILITY_UNAVAILABLE, `O modelo "${requestedModel}" foi testado e NÃO suporta "${capability}".`, { model: requestedModel });
    }
    if (breaker && !breaker.allow(requestedModel)) {
      return blocked(ENGINE_ERRORS.NO_CANDIDATE, `O modelo "${requestedModel}" está temporariamente bloqueado pelo circuit breaker após falhas seguidas.`, { model: requestedModel });
    }
    return {
      chain: [requestedModel],
      decision: { ...decision, reason: 'pedido_explicito_do_usuario', selected_model: requestedModel, cost: cost.cost },
    };
  }

  /* 2. Capacidade que o primário não tem ---------------------------------- */
  const approved = Array.isArray(specialized[capability]) ? specialized[capability] : [];
  // `text.chat` é a capacidade BASELINE do próprio Gateway (contrato), não uma
  // alegação sobre o modelo. Para ela, ausência de catálogo não bloqueia.
  const baseline = capability === 'text.chat';
  const primarySupports = baseline || !catalog || catalog.supports(primary, capability);
  if (!primarySupports) {
    const usable = approved.filter((model) => {
      const cost = allowedByCost(model);
      if (!cost.ok) {
        decision.skipped.push({ model, reason: ENGINE_ERRORS.COST_BLOCKED });
        return false;
      }
      if (catalog.statusFor(model, capability) === 'unavailable') {
        decision.skipped.push({ model, reason: ENGINE_ERRORS.CAPABILITY_UNAVAILABLE });
        return false;
      }
      if (breaker && !breaker.allow(model)) {
        decision.skipped.push({ model, reason: 'circuit_open' });
        return false;
      }
      return true;
    });
    if (!usable.length) {
      return blocked(
        ENGINE_ERRORS.CAPABILITY_UNAVAILABLE,
        `Nenhum modelo aprovado executa "${capability}". O primário "${primary}" não declara suporte e não há especializado aprovado disponível.`,
        { capability, approved_count: approved.length },
      );
    }
    return {
      chain: usable.slice(0, 1 + maxFallbackHops),
      decision: { ...decision, reason: 'capacidade_especializada_aprovada', selected_model: usable[0], approved },
    };
  }

  /* 3. Caminho normal: o primário, sempre primeiro ------------------------- */
  const primaryCost = allowedByCost(primary);
  if (!primaryCost.ok) {
    return blocked(ENGINE_ERRORS.COST_BLOCKED, `O primário "${primary}" é de custo pago e a política é "${costPolicy}".`, { model: primary });
  }
  if (breaker && !breaker.allow(primary)) {
    // Primário bloqueado por falhas: é falha comprovada → fallback é legítimo.
    const chain = (fallback ? [fallback] : []).filter((model) => {
      const cost = allowedByCost(model);
      if (!cost.ok) return false;
      if (catalog && catalog.statusFor(model, capability) === 'unavailable') return false;
      return !breaker || breaker.allow(model);
    });
    if (!chain.length) {
      return blocked(ENGINE_ERRORS.NO_CANDIDATE, `O primário "${primary}" está bloqueado por falhas e não há alternativa utilizável.`, { model: primary });
    }
    return {
      chain: chain.slice(0, maxFallbackHops),
      decision: { ...decision, reason: 'primario_bloqueado_por_falhas', selected_model: chain[0], primary },
    };
  }

  const chain = [primary];
  if (fallback && fallback !== primary && maxFallbackHops > 0) {
    const cost = allowedByCost(fallback);
    const usable = cost.ok && (!catalog || catalog.statusFor(fallback, capability) !== 'unavailable') && (!breaker || breaker.allow(fallback));
    if (usable) chain.push(fallback);
    else decision.skipped.push({ model: fallback, reason: cost.ok ? 'unavailable_or_breaker' : ENGINE_ERRORS.COST_BLOCKED });
  }

  return {
    chain,
    decision: { ...decision, reason: 'modelo_primario_preservado', selected_model: primary, primary, fallback_available: chain.length > 1 },
  };
}

/** Erros que justificam tentar OUTRO modelo. Auth e pedido inválido, nunca. */
export function isFallbackEligible(error) {
  const code = String(error?.code || '');
  if (!code) return Boolean(error?.retryable);
  if (/auth|invalid|model_not_available|request_too_large|response_too_large|unsupported/.test(code)) return false;
  return Boolean(error?.retryable) || /timeout|connection|upstream|overload|rate_limit|interrupted|incomplete/.test(code);
}

/**
 * Executor: percorre a cadeia respeitando timeout por tentativa, breaker e
 * tentativas limitadas. Devolve sempre um registro de execução — inclusive no
 * fracasso — para alimentar `/v1/runs`.
 */
export async function executeChain({
  chain,
  call,
  breaker = null,
  timeoutMs = DEFAULT_TIMEOUTS.attemptMs,
  attemptsPerModel = DEFAULT_RETRY.attemptsPerModel,
  signal = null,
  now = Date.now,
  onAttempt = null,
} = {}) {
  const attempts = [];
  const started = now();
  const seen = new Set(); // trava dura contra loop de fallback

  for (const model of chain) {
    if (seen.has(model)) continue; // nunca o mesmo modelo duas vezes
    seen.add(model);
    if (breaker && !breaker.allow(model)) {
      attempts.push({ model, outcome: 'skipped', code: 'circuit_open', durationMs: 0 });
      continue;
    }
    for (let attempt = 1; attempt <= Math.max(1, attemptsPerModel); attempt += 1) {
      const attemptStart = now();
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
      // O timeout precisa valer MESMO se o chamador ignorar o `signal`: por isso
      // a corrida é explícita, e o abort só serve para interromper o trabalho.
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          abort();
          reject(Object.assign(new Error(`A tentativa com "${model}" excedeu ${timeoutMs} ms.`), { code: ENGINE_ERRORS.TIMEOUT, retryable: true }));
        }, timeoutMs);
      });
      try {
        const result = await Promise.race([call({ model, attempt, signal: controller.signal }), timeoutPromise]);
        clearTimeout(timer);
        breaker?.record(model, true);
        attempts.push({ model, attempt, outcome: 'ok', durationMs: now() - attemptStart });
        onAttempt?.({ model, outcome: 'ok' });
        return {
          ok: true,
          model,
          result,
          attempts,
          totalMs: now() - started,
          fallbackUsed: attempts.filter((a) => a.outcome === 'ok').length + attempts.filter((a) => a.outcome === 'failed').length > 1,
        };
      } catch (error) {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted && !(signal?.aborted);
        const code = timedOut ? ENGINE_ERRORS.TIMEOUT : error?.code || 'attempt_failed';
        const fallbackOk = isFallbackEligible({ ...error, code });
        breaker?.record(model, !fallbackOk); // falha "de culpa do modelo" conta para o breaker
        attempts.push({ model, attempt, outcome: 'failed', code, durationMs: now() - attemptStart, eligible_for_fallback: fallbackOk });
        onAttempt?.({ model, outcome: 'failed', code });
        if (!fallbackOk) {
          // Erro do pedido não melhora em outro modelo: não mascara.
          return { ok: false, model, error, code, attempts, totalMs: now() - started, fallbackUsed: false, stopReason: 'erro_nao_recuperavel' };
        }
        // Última tentativa deste modelo esgotada → próximo da cadeia.
      }
    }
  }

  const last = attempts.at(-1);
  return {
    ok: false,
    model: last?.model || null,
    code: last?.code || ENGINE_ERRORS.ALL_FAILED,
    attempts,
    totalMs: now() - started,
    fallbackUsed: attempts.some((a) => a.outcome === 'failed'),
    stopReason: 'cadeia_esgotada',
  };
}

/**
 * Histórico de execução em memória (ring buffer) — o que a Tama IA consulta em
 * `/v1/runs`. Não guarda conteúdo de mensagem por padrão (só metadados), para
 * não virar log de conversa em disco.
 */
export class RunLog {
  #runs = [];
  constructor({ limit = 200, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.now = now;
    this.seq = 0;
  }

  record(entry) {
    this.seq += 1;
    const run = {
      id: `run_${String(this.seq).padStart(6, '0')}`,
      at: new Date(this.now()).toISOString(),
      ...entry,
    };
    this.#runs.push(run);
    if (this.#runs.length > this.limit) this.#runs.shift();
    return run;
  }

  list({ limit = 50 } = {}) {
    return this.#runs.slice(-Math.max(1, Math.min(limit, this.limit))).reverse();
  }

  get(id) {
    return this.#runs.find((run) => run.id === id) || null;
  }

  get size() {
    return this.#runs.length;
  }
}

export const ENGINE_DEFAULTS = Object.freeze({
  timeouts: DEFAULT_TIMEOUTS,
  retry: DEFAULT_RETRY,
  costPolicy: 'plan-only',
  breaker: { failureThreshold: 3, resetMs: 30_000 },
});
