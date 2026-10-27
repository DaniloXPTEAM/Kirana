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
import { buildKnowledgePrompt } from './knowledge/index.js';
import { buildContextMessages } from './sessions.js';
import { validateGatewayPayload } from './contract.js';
import { createTurnGraph, initialTurnState } from './graph.js';
import { canonicalToolName } from './tools/names.js';

export const EVENTS = {
  session: 'session',
  start: 'start',
  status: 'status',
  delta: 'delta',
  toolStart: 'tool_start',
  toolResult: 'tool_result',
  // Ferramenta de FRONTEND (declarada pelo site): o modelo pede, o navegador
  // executa. A Kirana não executa nada nesse caso — só repassa a chamada.
  externalTool: 'external_tool',
  confirmation: 'confirmation',
  // Fase 4: diretiva para o NAVEGADOR (abrir página, pedir dados ao visitante).
  // O servidor só autoriza; quem executa é a interface do site.
  siteAction: 'site_action',
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

export function createAgent({ config, gateway, registry, sessions, memory, logger, catalog, siteContext = null, requests = null }) {
  const log = logger?.child?.('agent') ?? logger;
  /** 'langgraph' (padrão) ou 'legacy' — permite rollback e teste de paridade. */
  const orchestrator = config.agent.orchestrator === 'legacy' ? 'legacy' : 'langgraph';
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

  /**
   * Bloco do site integrado (Fase 4).
   *
   * Diz ao modelo ONDE ele está atendendo e QUAL página o visitante vê, além de
   * lembrar as regras de permissão. Fica separado do bloco de ferramentas porque
   * muda a cada turno (o visitante navega) e não deve invalidar cache de prompt.
   */
  function buildSiteBlock(session) {
    if (!siteContext) return '';
    const site = siteContext.site(session?.siteId ?? '');
    if (!site) return '';
    const current = siteContext.currentContext(site.id, session?.siteState ?? {});
    const knowledge = siteContext.knowledgeFor(site.id);
    const lines = [
      `## Site em que você está atendendo`,
      '',
      `Você é a agente residente do site **${site.name}** (${site.siteUrl ?? 'URL não informada'}).`,
      `Página atual do visitante: ${current.page ? `**${current.page.title}** (${current.page.path})` : 'não informada'}.`,
    ];
    if (current.page?.summary) lines.push(`Resumo da página: ${current.page.summary}`);
    if (current.service) lines.push(`Solução em foco: ${current.service.title} (${current.service.serviceId}).`);
    // Fase 5: a tarefa em andamento faz parte do contexto do site. Sem isso a
    // Kirana repetiria perguntas já respondidas depois de uma navegação.
    const task = requests?.store?.activeFor(session?.id) ?? null;
    if (task) {
      const dados = Object.entries(task.data ?? {})
        .filter(([, value]) => value != null && value !== '')
        .map(([key, value]) => `${key}=${String(value).slice(0, 120)}`)
        .join('; ');
      lines.push(
        '',
        '## Solicitação em andamento',
        `- Identificador: **${task.id}** (serviço: ${task.serviceTitle ?? task.serviceId}).`,
        `- Estado: **${task.state}**.`,
        `- Dados já informados: ${dados || 'nenhum ainda'}.`,
        `- Arquivos anexados: ${(task.files ?? []).length}.`,
        '- Não peça de novo o que já está acima. Use `validate_service_request` para ver o que falta.',
        '- O envio só acontece com `submit_service_request` aprovado pelo visitante; sem endpoint autorizado a solicitação continua rascunho.',
      );
    }
    if (knowledge && !knowledge.empty) {
      lines.push('', buildKnowledgePrompt(knowledge, site));
      lines.push(
        '',
        'Regras de conduta no site:',
        '- Consulte as ferramentas antes de afirmar qualquer informação do site.',
        '- Preços, prazos e clientes NÃO são publicados: diga isso em vez de estimar.',
        '- Navegação só em páginas autorizadas; a ação é executada pelo navegador do visitante.',
        '- Ações com efeito exigem confirmação na tela; você nunca envia formulário sozinha.',
        site.uploads?.enabled === true
          ? '- Upload de arquivo está disponível: use `request_file_upload` e deixe o visitante escolher o arquivo. O servidor valida tipo, tamanho e conteúdo; nada é executado.'
          : '- Upload de arquivo não está disponível: oriente o uso do formulário/WhatsApp oficial.',
      );
    }
    return lines.join('\n');
  }

  function buildApiMessages(session, { activeToolsDescription, contextNote }) {
    const system = buildSystemPrompt({
      memoryItems: memory.promptItems(config.agent.memoryMaxChars),
      activeTools: activeToolsDescription,
      catalogMeta: catalog.meta,
      siteBlock: buildSiteBlock(session),
    }) + (contextNote ? `\n\n${contextNote}` : '');
    const history = buildContextMessages(session.messages, config.agent.historyLimit);
    const messages = [{ role: 'system', content: system }, ...history.map(toApiMessage)];

    // Invariante do agente: conversa sempre começa pela identidade da Kirana.
    // checkToolPairing: barreira adicional contra continuação com `tool_calls`
    // sem resultado — a Responses API recusa com 400 (defeito de 27/10/2026).
    // Uma ação pendente de confirmação é estado intermediário legítimo e fica
    // isenta, assim como qualquer chamada declarada em `pendingToolCallIds`.
    const pendingToolCallIds = session.pendingAction?.toolCallId ? [session.pendingAction.toolCallId] : [];
    const problems = validateGatewayPayload(
      { model: 'validacao-interna', messages, stream: true },
      { allowOptInFields: true, requireSystemPrompt: true, checkToolPairing: true, pendingToolCallIds },
    );
    if (problems.length) {
      throw Object.assign(new Error(`Contexto inválido para o gateway: ${problems.map((p) => `${p.path}: ${p.message}`).join(' | ')}`), {
        code: 'gateway_contract_error',
      });
    }
    return messages;
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
          // Só é enviado ao gateway se KIRANA_SEND_TEMPERATURE=true.
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

  /**
   * Resolve a chamada vinda do modelo para a ferramenta registrada.
   *
   * `rawName` é o que o Gateway devolveu (pode vir como `gateway.<nome>`);
   * `name` é o nome canônico usado no registro, na interface e nos testes.
   * Os dois são guardados porque a mensagem de assistente precisa repetir o
   * nome que o gateway espera na próxima requisição.
   */
  function introspectToolCall(call, externalToolMap = null) {
    const rawName = call.function?.name;
    const canonical = canonicalToolName(rawName);
    const tool = registry.get(rawName) ?? registry.get(canonical);
    // Ferramenta de FRONTEND (declarada pelo site via AG-UI): o mapa é a fonte
    // de verdade. O Gateway prefixa o nome do mesmo jeito, então a busca aceita
    // `gateway.<nome>` e `<nome>` — e o evento sai com o nome do site, porque é
    // esse nome que o navegador conhece.
    const external = !tool ? (externalToolMap?.get(rawName) ?? externalToolMap?.get(canonical) ?? null) : null;
    // Nome exibido/registrado: o da ferramenta da Kirana, o declarado pelo site
    // ou, para nome desconhecido, o canônico (nunca `gateway.<nome>` na tela).
    const name = tool ? tool.name : external ? external.schema.function.name : canonical || rawName;
    const validation = tool ? registry.validate(name, call.function?.arguments) : null;
    return { rawName, canonical, name, tool, external, validation };
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
    // `data` também é devolvido para o chamador poder reagir (ex.: site_action).
    return { content, ok: result.ok, name, data: result.data, errorCode: result.ok ? null : result.error.code };
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

  /* ---------------------- primitivas do orquestrador ---------------------- */

  /**
   * Monta as mensagens e as ferramentas de uma rodada.
   * Chamado pelo nó `prepare` do grafo LangGraph.
   */
  function prepareRound(state) {
    const { session } = state.io;
    const allowWrite = state.allowWrite !== false;
    const writeToolNames = new Set(registry.writeTools().map((t) => t.name));

    const tools = registry.openAISchemas().filter((schema) => allowWrite || !writeToolNames.has(schema.function.name));

    // Ferramentas de frontend declaradas pelo site (AG-UI). Somam-se às da
    // Kirana; nunca as substituem e nunca são executadas no servidor.
    const externalSchemas = Array.isArray(state.io.externalTools) ? state.io.externalTools : [];
    for (const schema of externalSchemas) {
      if (!schema?.function?.name) continue;
      if (tools.some((t) => t.function.name === schema.function.name)) continue;
      tools.push(schema);
    }

    const activeTools = registry
      .list()
      .filter((t) => allowWrite || t.kind !== 'write')
      .map((t) => ({ name: t.name, kind: t.kind, description: t.description.split('. ')[0] }));

    for (const schema of externalSchemas) {
      if (!schema?.function?.name) continue;
      activeTools.push({
        name: schema.function.name,
        kind: 'frontend',
        description: schema.function.description.split('. ')[0],
      });
    }

    const messages = buildApiMessages(session, { activeToolsDescription: activeTools, contextNote: state.io.contextNote });
    return { messages, toolSchemas: tools, activeTools };
  }

  /** Chamada ao modelo com fallback + evento `start` (usada pelo nó `model`). */
  async function orchestratorCallModel({ messages, tools, signal, emit, io }) {
    const result = await callModel({
      messages,
      tools,
      signal,
      emit,
      temperatureOverride: io?.temperatureOverride,
    });
    emit({ type: EVENTS.start, model: result.model, requested: result.requestedModel, fallbackUsed: result.fallbackUsed });
    return result;
  }

  function persistAssistant(result, io) {
    sessions.append(io.session, {
      role: 'assistant',
      content: result.text || '',
      toolCalls: result.toolCalls.length
        ? result.toolCalls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }))
        : undefined,
      model: result.model,
      ttftMs: result.ttftMs,
      usage: result.usage || undefined,
    });
  }

  function persistToolMessage(call, content, io) {
    sessions.append(io.session, { role: 'tool', toolCallId: call.id, name: call.function?.name, content });
  }

  /**
   * Executa (ou prepara) uma chamada de ferramenta.
   * Leitura roda de imediato; escrita só cria ação pendente.
   */
  async function handleToolCall({ call, io, allowWrite, pendingActionExists, emit }) {
    // O Gateway v0.4.x devolve `gateway.<nome>`; tudo daqui para baixo usa o
    // nome canônico (registro, interface, site_action, HITL).
    const { name, tool: resolved, external } = introspectToolCall(call, io.externalToolMap);
    const tool = resolved;

    // Ferramenta de frontend: a Kirana apenas anuncia a chamada. Quem executa
    // é a interface do site, via CopilotKit/AG-UI. Nada roda no backend.
    const externalTool = external;
    if (externalTool) {
      const validation = externalTool.validate(call.function?.arguments);
      if (!validation.ok) {
        emit({ type: EVENTS.toolResult, name, title: name, ok: false, errorCode: 'invalid_args', external: true });
        return {
          content: toolResultContent({
            ok: false,
            erro: {
              codigo: 'invalid_args',
              mensagem: 'Argumentos inválidos para a ação da interface. Corrija e peça de novo.',
              detalhes: validation.errors,
            },
          }),
        };
      }
      emit({ type: EVENTS.toolStart, name, title: name, kind: 'frontend' });
      emit({
        type: EVENTS.externalTool,
        callId: call.id,
        name,
        args: validation.args,
        requiresConfirmation: Boolean(externalTool.requiresConfirmation),
      });
      emit({ type: EVENTS.toolResult, name, title: name, ok: true, external: true });
      return {
        content: toolResultContent({
          ok: true,
          status: 'delegada_para_interface',
          mensagem:
            'A ação foi entregue à interface do site, que a executa no navegador. Se ela exigir confirmação, a interface mostra os dados e aguarda o usuário. Não diga que foi concluída antes do resultado da interface.',
        }),
      };
    }

    if (!tool) {
      emit({ type: EVENTS.toolResult, name, title: name, ok: false, errorCode: 'unknown_tool' });
      return {
        content: toolResultContent({
          ok: false,
          erro: {
            codigo: 'unknown_tool',
            mensagem: `A ferramenta "${name}" não está registrada nesta instalação da Kirana. Nenhuma ação foi executada.`,
            // O modelo precisa saber o que EXISTE para escolher outro caminho
            // em vez de inventar que "a consulta falhou".
            disponiveis: registry.names(),
            orientacao:
              'Use apenas as ferramentas listadas em disponiveis. A Kirana não tem acesso à internet nem pesquisa web: ' +
              'para assuntos do site Opportunity AI use list_services, explain_service, explain_current_page e get_site_context ' +
              '(conhecimento real capturado do site).',
          },
        }),
      };
    }

    if (tool.kind === 'write' && !allowWrite) {
      return {
        content: toolResultContent({
          ok: false,
          erro: { codigo: 'write_not_allowed', mensagem: 'Ações de escrita não estão disponíveis nesta rodada (já houve uma ação pendente).' },
        }),
      };
    }

    emit({ type: EVENTS.toolStart, name, title: tool.title, kind: tool.kind });

    if (tool.kind === 'read') {
      const out = await runReadTool(call, io.ctx, io.toolCache);
      emit({
        type: EVENTS.toolResult,
        name,
        title: tool.title,
        ok: out.ok,
        cached: Boolean(out.cached),
        errorCode: out.errorCode || null,
        // Só ferramentas marcadas expõem o resultado bruto (conteúdo público do
        // site). Ferramentas internas continuam mandando apenas o status.
        ...(tool.expose && out.data ? { data: out.data } : {}),
      });
      // Diretiva para o navegador (abrir página / pedir dados). O servidor só
      // autorizou: quem executa é o cliente, e ele confirma o resultado depois.
      const action = out.data?.siteAction;
      if (action && typeof action === 'object' && !out.cached) {
        emit({ type: EVENTS.siteAction, tool: name, action });
      }
      return { content: out.content };
    }

    // Ferramenta de escrita: valida agora, executa só após confirmação.
    const validation = registry.validate(name, call.function?.arguments);
    if (!validation.ok) {
      emit({ type: EVENTS.toolResult, name, title: tool.title, ok: false, errorCode: 'invalid_args', details: validation.errors });
      return {
        content: toolResultContent({
          ok: false,
          erro: { codigo: 'invalid_args', mensagem: 'Argumentos inválidos. Peça ao usuário os dados que faltam ou corrija.', detalhes: validation.errors },
        }),
      };
    }

    if (pendingActionExists || io.session.pendingAction) {
      return {
        content: toolResultContent({
          ok: false,
          erro: { codigo: 'confirmation_pending', mensagem: 'Já existe uma ação aguardando confirmação. Aguarde a decisão do usuário.' },
        }),
      };
    }

    const action = createPendingAction(io.session, { name, args: validation.args, toolCallId: call.id });
    emit({ type: EVENTS.toolResult, name, title: tool.title, ok: false, errorCode: 'confirmation_required' });
    emit({
      type: EVENTS.confirmation,
      action: { id: action.id, tool: action.tool, title: action.title, summary: action.summary, expiresAt: action.expiresAt },
    });

    return {
      pending: action,
      content: toolResultContent({
        ok: false,
        status: 'aguardando_confirmacao',
        action_id: action.id,
        mensagem:
          'Nada foi executado ainda. A interface mostrou um pedido de confirmação ao usuário. Diga em uma frase que você preparou a ação e que ela só será concluída após a confirmação dele.',
      }),
    };
  }

  /** Métricas + evento `done` (nó `finalize`). */
  function finalizeTurnState(state) {
    const { emit, session } = state.io;
    const responseMs = Date.now() - state.io.startedAt;
    const pending = state.pendingAnnounced;

    sessions.recordMetrics(session, {
      ttftMs: state.firstTtft,
      totalMs: responseMs,
      toolCalls: state.toolCallsTotal ?? 0,
    });

    emit({
      type: EVENTS.done,
      model: state.activeModel || config.models.primary,
      fallbackUsed: Boolean(state.fallbackUsed),
      ttftMs: state.firstTtft,
      totalMs: responseMs,
      rounds: state.rounds,
      toolCalls: state.toolCallsTotal ?? 0,
      pendingAction: pending ? { id: pending.id, tool: pending.tool, summary: pending.summary, expiresAt: pending.expiresAt } : null,
      orchestrator,
    });

    return { responseMs };
  }

  /* ---------------------------------- grafo -------------------------------- */

  const turnGraph = createTurnGraph({
    prepareRound,
    callModel: orchestratorCallModel,
    handleToolCall,
    persistAssistant,
    persistToolMessage,
    finalize: finalizeTurnState,
    toolResultContent,
    maxToolRounds: () => config.agent.maxToolRounds,
    // Fase 5: o grafo carrega o estado da tarefa a cada rodada.
    loadTask: (state) => {
      const active = requests?.store?.activeFor(state?.io?.session?.id ?? '') ?? null;
      if (!active) return null;
      return { id: active.id, state: active.state, serviceId: active.serviceId, files: (active.files ?? []).length, fields: Object.keys(active.data ?? {}) };
    },
  });

  /* -------------------------------- turno --------------------------------- */

  function handleTurnError(error, { session, startedAt, firstTtft, toolCallsTotal, activeModel, emit }) {
    const aborted = error?.code === 'aborted' || error?.name === 'AbortError';
    const mapped = mapError(error, config);

    sessions.recordMetrics(session, {
      ttftMs: firstTtft,
      totalMs: Date.now() - startedAt,
      aborted,
      error: !aborted,
      toolCalls: toolCallsTotal,
    });

    if (aborted) {
      const last = [...session.messages].reverse().find((m) => m.role === 'assistant');
      if (last) {
        if (!last.content) last.content = '';
        last.aborted = true;
      }
      sessions.save(session);
      log.info('Geração interrompida pelo usuário', { sessionId: session.id });
      emit({ type: EVENTS.done, aborted: true, model: activeModel, totalMs: Date.now() - startedAt });
      return { ok: false, aborted: true };
    }

    log.error('Falha no turno', { code: error?.code, message: error?.message });
    emit({ type: EVENTS.error, ...mapped });
    return { ok: false, error: mapped };
  }

  async function runTurn({ session, text, emit, signal, temperatureOverride, externalTools, contextNote }) {
    const clean = String(text ?? '').trim();
    if (!clean) throw new TurnError('Mensagem vazia.', 'empty_message');
    if (clean.length > 8000) throw new TurnError('Mensagem acima de 8000 caracteres.', 'message_too_long');

    clearPendingAction(session, 'o usuário continuou a conversa sem confirmar a ação anterior');
    sessions.append(session, { role: 'user', content: clean });

    const startedAt = Date.now();
    const externalList = Array.isArray(externalTools) ? externalTools : [];
    const io = {
      emit,
      signal,
      session,
      temperatureOverride,
      startedAt,
      ctx: {
        sessionId: session.id,
        memory,
        sessions,
        config,
        catalog,
        logger,
        // Fase 4: o site vem da sessão (não do modelo) e a página, do navegador.
        siteId: session.siteId ?? null,
        siteState: session.siteState ?? null,
      },
      toolCache: new Map(),
      contextNote: contextNote || null,
      externalTools: externalList.map((t) => t.schema).filter(Boolean),
      externalToolMap: new Map(externalList.map((t) => [t.schema.function.name, t])),
    };

    try {
      const state = await turnGraph.invoke(initialTurnState({ io }));

      const responseMs = Date.now() - startedAt;
      log.debug?.('Turno concluído', { orchestrator, nos: state.trace?.join(' → '), rounds: state.rounds, ms: responseMs });

      return {
        ok: true,
        model: state.activeModel,
        ttftMs: state.firstTtft,
        totalMs: responseMs,
        orchestrator,
        trace: state.trace,
      };
    } catch (error) {
      // O grafo propaga o erro original (GatewayError, abort, etc.):
      // o tratamento é o mesmo de antes, sem perda de informação.
      return handleTurnError(error, {
        session,
        startedAt,
        firstTtft: null,
        toolCallsTotal: 0,
        activeModel: null,
        emit,
      });
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

    const ctx = {
      sessionId: session.id,
      memory,
      sessions,
      config,
      catalog,
      logger,
      // Fase 4: as ferramentas do site precisam saber o site e a página atual.
      siteId: session.siteId ?? null,
      siteState: session.siteState ?? null,
    };
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

    // Fase 4: a interface do site também precisa saber que a autorização saiu.
    // A ação em si continua sendo executada pelo site (formulário), não aqui.
    const granted = result.data?.siteAction;
    if (granted && typeof granted === 'object') {
      emit({ type: EVENTS.siteAction, tool: action.tool, action: granted });
    }

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
    // `content` sempre string: gateways estritos recusam null em mensagens com
    // tool_calls (e é o formato que a allowlist de payload garante na saída).
    const base = { role: 'assistant', content: typeof message.content === 'string' ? message.content : '' };
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
    gateway_contract_error: {
      message:
        'O backend montou uma requisição incompatível com o gateway e bloqueou o envio (proteção local). Envie esta mensagem para a equipe técnica com a saída de diagnostico.bat.',
      recoverable: false,
    },
    unsupported_parameter: {
      message:
        'O gateway recusou um campo da requisição que não faz parte do contrato dele. O backend já tentou remover o campo automaticamente; se o erro persistir, rode diagnostico.bat e verifique a versão do gateway.',
      recoverable: false,
    },
    gateway_http: { message: 'O gateway retornou um erro. Veja os logs do backend para o detalhe técnico.', recoverable: true },
    rate_limited: { message: 'Muitas mensagens em pouco tempo. Aguarde alguns segundos e tente de novo.', recoverable: true },
  };
  const found = map[code] || { message: 'Algo deu errado ao processar sua mensagem.', recoverable: true };
  return { code, message: found.message, recoverable: found.recoverable, status: error?.status || 500 };
}
