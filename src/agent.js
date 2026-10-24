/**
 * Orquestrador da Kirana.
 *
 * Fluxo de um turno:
 *   mensagem do usuário
 *     -> monta contexto (identidade + memória + histórico reparado)
 *     -> chama o gateway em streaming (modelo primário, fallback controlado)
 *     -> se o modelo pedir ferramentas de leitura, executa e volta ao modelo
 *     -> se pedir ferramenta de escrita, valida e cria uma AÇÃO PENDENTE
 *        (nada é executado até o usuário confirmar na interface)
 *     -> persiste tudo na sessão e emite eventos SSE
 */
import { randomUUID } from 'node:crypto';
import { buildSystemPrompt } from './prompts.js';
import { buildContextMessages } from './sessions.js';

export const EVENTS = {
  session: 'session',
  start: 'start',
  status: 'status',
  delta: 'delta',
  toolStart: 'tool_start',
  toolResult: 'tool_result',
  confirmation: 'confirmation',
  done: 'done',
  error: 'error',
};

class TurnError extends Error {
  constructor(message, code = 'turn_error', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function createAgent({ config, gateway, registry, sessions, memory, logger, catalog }) {
  const log = logger?.child?.('agent') ?? logger;
  let modelCache = { at: 0, value: null };

  /* ------------------------------- modelos -------------------------------- */

  async function resolveActiveModel() {
    const { primary, fallback, probe } = config.models;
    if (!probe) return { active: primary, fallback, available: [] };
    if (modelCache.value && Date.now() - modelCache.at < 5 * 60_000) return modelCache.value;

    try {
      const models = await gateway.models();
      const hasPrimary = models.includes(primary);
      const hasFallback = models.includes(fallback);
      const active = hasPrimary ? primary : hasFallback ? fallback : primary;
      const value = {
        active,
        fallback,
        available: models,
        degraded: !hasPrimary && hasFallback,
        note: !hasPrimary ? `Modelo primário "${primary}" não está na lista do gateway; usando "${active}".` : null,
      };
      modelCache = { at: Date.now(), value };
      if (value.degraded) log.warn('Modelo primário indisponível', { primary, active });
      return value;
    } catch (error) {
      log.warn('Não foi possível listar modelos do gateway; seguindo com a configuração', { code: error?.code });
      const value = { active: primary, fallback, available: [], degraded: false, note: null };
      modelCache = { at: Date.now(), value };
      return value;
    }
  }

  /* ------------------------------- contexto ------------------------------- */

  function buildApiMessages(session, { activeToolsDescription }) {
    const system = buildSystemPrompt({
      memoryItems: memory.promptItems(config.agent.memoryMaxChars),
      activeTools: activeToolsDescription,
      catalogMeta: catalog.meta,
    });
    const history = buildContextMessages(session.messages, config.agent.historyLimit);
    return [{ role: 'system', content: system }, ...history.map(toApiMessage)];
  }

  function toolResultContent(payload) {
    const json = JSON.stringify(payload);
    if (json.length <= config.agent.toolResultMaxChars) return json;
    return `${json.slice(0, config.agent.toolResultMaxChars)}… (resultado truncado)`;
  }

  /* --------------------------- chamada ao modelo -------------------------- */

  async function callModel({ messages, tools, signal, emit, temperatureOverride }) {
    const { active, fallback } = await resolveActiveModel();
    const candidates = [active];
    if (config.models.allowFallback && fallback && fallback !== active) candidates.push(fallback);

    let lastError;
    for (let index = 0; index < candidates.length; index += 1) {
      const model = candidates[index];
      if (index > 0) {
        emit({ type: EVENTS.status, stage: 'retry', label: 'O modelo principal não respondeu. Tentando o modelo alternativo…' });
        log.warn('Fallback de modelo acionado', { from: candidates[index - 1], to: model, reason: lastError?.code });
      }
      try {
        const result = await gateway.chatStream({
          messages,
          model,
          tools,
          signal,
          temperature: temperatureOverride ?? config.agent.temperature,
          onDelta: (text) => emit({ type: EVENTS.delta, text }),
        });
        return { ...result, model, requestedModel: active, fallbackUsed: index > 0 };
      } catch (error) {
        lastError = error;
        const canFallback =
          index + 1 < candidates.length &&
          error?.code !== 'aborted' &&
          error?.emittedAnything !== true &&
          error?.retryable === true;
        if (!canFallback) throw error;
      }
    }
    throw lastError;
  }

  /* ------------------------------ ferramentas ----------------------------- */

  function introspectToolCall(call) {
    const name = call.function?.name;
    const tool = registry.get(name);
    const validation = registry.validate(name, call.function?.arguments);
    return { name, tool, validation };
  }

  async function runReadTool(call, ctx, cache) {
    const { name } = introspectToolCall(call);
    const key = `${name}:${JSON.stringify(call.function?.arguments)}`;
    if (cache.has(key)) {
      return { content: cache.get(key), ok: true, name, cached: true };
    }
    const validation = registry.validate(name, call.function?.arguments);
    if (!validation.ok) {
      const payload = { ok: false, erro: { codigo: 'invalid_args', mensagem: 'Argumentos inválidos.', detalhes: validation.errors } };
      const content = toolResultContent(payload);
      cache.set(key, content);
      return { content, ok: false, name, errorCode: 'invalid_args', details: validation.errors };
    }
    const result = await registry.runRead(name, validation.args, ctx);
    const payload = result.ok
      ? { ok: true, dados: result.data }
      : { ok: false, erro: { codigo: result.error.code, mensagem: result.error.message, detalhes: result.error.details } };
    const content = toolResultContent(payload);
    cache.set(key, content);
    return { content, ok: result.ok, name, errorCode: result.ok ? null : result.error.code };
  }

  /* ------------------------- ações pendentes (escrita) -------------------- */

  function clearPendingAction(session, reason) {
    const pending = session.pendingAction;
    if (!pending) return;
    const target = session.messages.find((m) => m.role === 'tool' && m.toolCallId === pending.toolCallId);
    if (target) {
      target.content = toolResultContent({
        ok: false,
        status: 'cancelada',
        motivo: reason,
      });
    }
    session.pendingAction = null;
    sessions.save(session);
  }

  function createPendingAction(session, { name, args, toolCallId }) {
    const tool = registry.get(name);
    const action = {
      id: `act_${randomUUID().slice(0, 8)}`,
      tool: name,
      toolCallId,
      args,
      title: tool.title || name,
      summary: registry.describe(name, args),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + config.agent.confirmationTtlMs).toISOString(),
    };
    session.pendingAction = action;
    return action;
  }

  /* -------------------------------- turno --------------------------------- */

  async function runTurn({ session, text, emit, signal, temperatureOverride }) {
    const clean = String(text ?? '').trim();
    if (!clean) throw new TurnError('Mensagem vazia.', 'empty_message');
    if (clean.length > 8000) throw new TurnError('Mensagem acima de 8000 caracteres.', 'message_too_long');

    clearPendingAction(session, 'o usuário continuou a conversa sem confirmar a ação anterior');
    sessions.append(session, { role: 'user', content: clean });

    const turnStartedAt = Date.now();
    const ctx = { sessionId: session.id, memory, sessions, config, catalog, logger };
    const toolCache = new Map();
    const writeToolNames = new Set(registry.writeTools().map((t) => t.name));
    let allowWriteTools = true;
    let rounds = 0;
    let toolCallsTotal = 0;
    let firstTtft = null;
    let activeModel = null;
    let fallbackUsed = false;
    let aborted = false;
    let pendingAnnounced = null;

    try {
      while (rounds <= config.agent.maxToolRounds) {
        rounds += 1;

        const toolsForRound = registry.openAISchemas().filter((schema) => allowWriteTools || !writeToolNames.has(schema.function.name));
        const activeTools = registry
          .list()
          .filter((t) => allowWriteTools || t.kind !== 'write')
          .map((t) => ({ name: t.name, kind: t.kind, description: t.description.split('. ')[0] }));

        const messages = buildApiMessages(session, { activeToolsDescription: activeTools });

        const result = await callModel({ messages, tools: toolsForRound, signal, emit, temperatureOverride });
        activeModel = result.model;
        fallbackUsed = fallbackUsed || result.fallbackUsed;
        if (firstTtft === null && Number.isFinite(result.ttftMs)) firstTtft = result.ttftMs;

        emit({ type: EVENTS.start, model: result.model, requested: result.requestedModel, fallbackUsed: result.fallbackUsed });

        sessions.append(session, {
          role: 'assistant',
          content: result.text || '',
          toolCalls: result.toolCalls.length ? result.toolCalls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })) : undefined,
          model: result.model,
          ttftMs: result.ttftMs,
          usage: result.usage || undefined,
        });

        if (!result.toolCalls.length) break;

        if (rounds > config.agent.maxToolRounds) {
          sessions.append(session, {
            role: 'tool',
            toolCallId: result.toolCalls[0].id,
            name: result.toolCalls[0].function.name,
            content: toolResultContent({ ok: false, erro: { codigo: 'too_many_rounds', mensagem: 'Limite de chamadas de ferramenta atingido nesta mensagem.' } }),
          });
          break;
        }

        for (const call of result.toolCalls) {
          if (signal?.aborted) break;
          toolCallsTotal += 1;
          const name = call.function?.name;
          const tool = registry.get(name);

          if (!tool) {
            const content = toolResultContent({ ok: false, erro: { codigo: 'unknown_tool', mensagem: `Ferramenta desconhecida: ${name}` } });
            sessions.append(session, { role: 'tool', toolCallId: call.id, name, content });
            continue;
          }

          emit({ type: EVENTS.toolStart, name, title: tool.title, kind: tool.kind });

          if (tool.kind === 'read') {
            const out = await runReadTool(call, ctx, toolCache);
            sessions.append(session, { role: 'tool', toolCallId: call.id, name, content: out.content });
            emit({
              type: EVENTS.toolResult,
              name,
              title: tool.title,
              ok: out.ok,
              cached: Boolean(out.cached),
              errorCode: out.errorCode || null,
            });
            continue;
          }

          // Ferramenta de escrita: valida agora, executa só após confirmação.
          const validation = registry.validate(name, call.function?.arguments);
          if (!validation.ok) {
            const content = toolResultContent({
              ok: false,
              erro: { codigo: 'invalid_args', mensagem: 'Argumentos inválidos. Peça ao usuário os dados que faltam ou corrija.', detalhes: validation.errors },
            });
            sessions.append(session, { role: 'tool', toolCallId: call.id, name, content });
            emit({ type: EVENTS.toolResult, name, title: tool.title, ok: false, errorCode: 'invalid_args', details: validation.errors });
            continue;
          }

          if (session.pendingAction) {
            const content = toolResultContent({
              ok: false,
              erro: { codigo: 'confirmation_pending', mensagem: 'Já existe uma ação aguardando confirmação. Aguarde a decisão do usuário.' },
            });
            sessions.append(session, { role: 'tool', toolCallId: call.id, name, content });
            continue;
          }

          const action = createPendingAction(session, { name, args: validation.args, toolCallId: call.id });
          sessions.append(session, {
            role: 'tool',
            toolCallId: call.id,
            name,
            content: toolResultContent({
              ok: false,
              status: 'aguardando_confirmacao',
              action_id: action.id,
              mensagem:
                'Nada foi executado ainda. A interface mostrou um pedido de confirmação ao usuário. Diga em uma frase que você preparou a ação e que ela só será concluída após a confirmação dele.',
            }),
          });
          emit({ type: EVENTS.toolResult, name, title: tool.title, ok: false, errorCode: 'confirmation_required' });
          emit({
            type: EVENTS.confirmation,
            action: {
              id: action.id,
              tool: action.tool,
              title: action.title,
              summary: action.summary,
              expiresAt: action.expiresAt,
            },
          });
          pendingAnnounced = action;
          // A partir daqui só ferramentas de leitura, para não criar ações em cascata.
          allowWriteTools = false;
        }
      }

      const responseMs = Date.now() - turnStartedAt;
      sessions.recordMetrics(session, {
        ttftMs: firstTtft,
        totalMs: responseMs,
        toolCalls: toolCallsTotal,
      });

      emit({
        type: EVENTS.done,
        model: activeModel || (await resolveActiveModel()).active,
        fallbackUsed,
        ttftMs: firstTtft,
        totalMs: responseMs,
        rounds,
        toolCalls: toolCallsTotal,
        pendingAction: pendingAnnounced
          ? { id: pendingAnnounced.id, tool: pendingAnnounced.tool, summary: pendingAnnounced.summary, expiresAt: pendingAnnounced.expiresAt }
          : null,
      });

      return { ok: true, model: activeModel, ttftMs: firstTtft, totalMs: responseMs };
    } catch (error) {
      aborted = error?.code === 'aborted' || error?.name === 'AbortError';
      const mapped = mapError(error, config);
      sessions.recordMetrics(session, {
        ttftMs: firstTtft,
        totalMs: Date.now() - turnStartedAt,
        aborted,
        error: !aborted,
        toolCalls: toolCallsTotal,
      });
      if (aborted) {
        const last = [...session.messages].reverse().find((m) => m.role === 'assistant');
        if (last && !last.content) last.content = '';
        if (last) last.aborted = true;
        sessions.save(session);
        log.info('Geração interrompida pelo usuário', { sessionId: session.id });
        emit({ type: EVENTS.done, aborted: true, model: activeModel, totalMs: Date.now() - turnStartedAt });
        return { ok: false, aborted: true };
      }
      log.error('Falha no turno', { code: error?.code, message: error?.message });
      emit({ type: EVENTS.error, ...mapped });
      return { ok: false, error: mapped };
    }
  }

  /* --------------------------- confirmação de ação ------------------------ */

  async function resolveConfirmation({ session, actionId, approve, emit, signal }) {
    const action = session.pendingAction;
    if (!action) throw new TurnError('Não há ação aguardando confirmação.', 'no_pending_action', 409);
    if (action.id !== actionId) throw new TurnError('A ação informada não é a ação pendente.', 'action_mismatch', 409);
    if (new Date(action.expiresAt).getTime() < Date.now()) {
      clearPendingAction(session, 'a confirmação expirou');
      throw new TurnError('Esta confirmação expirou. Peça a ação novamente.', 'action_expired', 410);
    }

    const toolMessage = session.messages.find((m) => m.role === 'tool' && m.toolCallId === action.toolCallId);
    session.pendingAction = null;

    const ctx = { sessionId: session.id, memory, sessions, config, catalog, logger };
    const startedAt = Date.now();

    if (!approve) {
      if (toolMessage) {
        toolMessage.content = toolResultContent({ ok: false, status: 'recusada_pelo_usuario', mensagem: 'O usuário recusou esta ação. Nada foi gravado.' });
      }
      const message = sessions.append(session, {
        role: 'assistant',
        content: 'Tudo bem, não registrei nada. Se quiser, posso ajustar alguma informação ou seguir por outro caminho.',
        model: 'local',
      });
      sessions.save(session);
      emit({
        type: EVENTS.done,
        resolved: 'declined',
        messageId: message.id,
        model: 'local',
        totalMs: Date.now() - startedAt,
      });
      return { ok: true, resolved: 'declined' };
    }

    emit({ type: EVENTS.status, stage: 'tool', label: `Executando ${registry.get(action.tool)?.title || action.tool}…` });
    const result = await registry.runWrite(action.tool, action.args, ctx);

    if (toolMessage) {
      toolMessage.content = toolResultContent(
        result.ok
          ? { ok: true, dados: result.data, executado_em: new Date().toISOString() }
          : { ok: false, erro: { codigo: result.error.code, mensagem: result.error.message, detalhes: result.error.details } },
      );
    }
    sessions.save(session);

    emit({
      type: EVENTS.toolResult,
      name: action.tool,
      title: registry.get(action.tool)?.title,
      ok: result.ok,
      errorCode: result.ok ? null : result.error.code,
      executed: true,
    });

    // Pede ao modelo uma resposta natural sobre o resultado, usando só leitura.
    try {
      const readOnlyNames = new Set(registry.readTools().map((t) => t.name));
      const tools = registry.openAISchemas().filter((s) => readOnlyNames.has(s.function.name));
      const activeTools = registry.readTools().map((t) => ({ name: t.name, kind: 'read', description: t.description.split('. ')[0] }));
      const messages = buildApiMessages(session, { activeToolsDescription: activeTools });
      const finish = await callModel({ messages, tools, signal, emit });
      sessions.append(session, {
        role: 'assistant',
        content: finish.text || '',
        toolCalls: finish.toolCalls.length ? finish.toolCalls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })) : undefined,
        model: finish.model,
        ttftMs: finish.ttftMs,
      });
      for (const call of finish.toolCalls) {
        // Chamadas extras após a execução: apenas registradas, sem executar escrita.
        sessions.append(session, {
          role: 'tool',
          toolCallId: call.id,
          name: call.function?.name,
          content: toolResultContent({ ok: false, erro: { codigo: 'not_allowed_after_confirmation', mensagem: 'Nenhuma ferramenta é executada automaticamente após uma confirmação.' } }),
        });
      }
      sessions.recordMetrics(session, { ttftMs: finish.ttftMs, totalMs: Date.now() - startedAt });
      emit({
        type: EVENTS.done,
        resolved: 'approved',
        executed: result.ok,
        model: finish.model,
        ttftMs: finish.ttftMs,
        totalMs: Date.now() - startedAt,
      });
      return { ok: true, resolved: 'approved', executed: result.ok };
    } catch (error) {
      const mapped = mapError(error, config);
      sessions.recordMetrics(session, { totalMs: Date.now() - startedAt, error: mapped.code !== 'aborted' });
      emit({ type: EVENTS.error, ...mapped, executed: result.ok });
      return { ok: false, error: mapped, executed: result.ok };
    }
  }

  return {
    runTurn,
    resolveConfirmation,
    resolveActiveModel,
    invalidateModelCache: () => {
      modelCache = { at: 0, value: null };
    },
  };
}

/* -------------------------------------------------------------------------- */

function toApiMessage(message) {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content ?? '' };
  }
  if (message.role === 'assistant') {
    const base = { role: 'assistant', content: message.content || (message.toolCalls?.length ? null : '') };
    if (message.toolCalls?.length) {
      base.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) },
      }));
    }
    return base;
  }
  return { role: message.role, content: message.content ?? '' };
}

export function mapError(error, config = {}) {
  const code = error?.code || 'internal_error';
  const map = {
    aborted: { message: 'Geração interrompida.', recoverable: true },
    gateway_not_configured: {
      message: 'O backend ainda não tem a chave do gateway configurada. Preencha KIRANA_GATEWAY_API_KEY no arquivo .env e reinicie.',
      recoverable: false,
    },
    gateway_unreachable: {
      message: `Não consegui falar com o gateway em ${config.gateway?.url || 'endereço local'}. Verifique se ele está em execução (GET /health) e tente de novo.`,
      recoverable: true,
    },
    gateway_auth: {
      message: 'O gateway recusou a chave de API. Confira KIRANA_GATEWAY_API_KEY e a autorização da conta.',
      recoverable: false,
    },
    model_unavailable: {
      message: 'O modelo configurado não está disponível no gateway agora. Tente novamente ou ajuste KIRANA_PRIMARY_MODEL.',
      recoverable: true,
    },
    first_token_timeout: {
      message: 'A resposta demorou demais para começar. Tente novamente; se persistir, verifique o gateway.',
      recoverable: true,
    },
    request_timeout: { message: 'A resposta passou do tempo limite. Tente novamente.', recoverable: true },
    gateway_stream_error: { message: 'O streaming falhou no meio da resposta. Tente novamente.', recoverable: true },
    gateway_http: { message: 'O gateway retornou um erro. Veja os logs do backend para o detalhe técnico.', recoverable: true },
    rate_limited: { message: 'Muitas mensagens em pouco tempo. Aguarde alguns segundos e tente de novo.', recoverable: true },
  };
  const found = map[code] || { message: 'Algo deu errado ao processar sua mensagem.', recoverable: true };
  return { code, message: found.message, recoverable: found.recoverable, status: error?.status || 500 };
}
