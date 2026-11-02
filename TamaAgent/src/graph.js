/**
 * Orquestração do turno com LangGraph (@langchain/langgraph).
 *
 * Papel deste módulo: **controle de fluxo**, somente isso.
 *   START → prepare → model → (tools → prepare)* → finalize → END
 *                      └─────────────→ overflow → finalize
 *
 * As capacidades continuam onde estavam na Fase 1:
 *   - transporte/contrato do gateway .......... src/gateway.js + payload.js + contract.js
 *   - ferramentas e permissões ................ src/tools/*
 *   - histórico e persistência ................ src/sessions.js
 *   - identidade .............................. src/prompts.js
 *
 * O grafo não conhece HTTP, não monta payload e não fala com o gateway:
 * recebe um objeto `io` com as primitivas do agente. Assim o contrato do
 * Gateway v0.2.0 continua garantido em um único lugar.
 *
 * Estado por turno (não persistido): o grafo é sem checkpointer porque a
 * persistência real de conversa é a sessão em disco (src/sessions.js). O
 * `trace` registra os nós executados e é usado como evidência nos testes.
 */
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';

const TurnState = Annotation.Root({
  /** Primitivas do turno: emit, signal, session, ctx (não serializável de propósito). */
  io: Annotation(),
  rounds: Annotation(),
  messages: Annotation(),
  /** Nome do canal não pode coincidir com o nome do nó `tools`. */
  toolSchemas: Annotation(),
  activeTools: Annotation(),
  result: Annotation(),
  allowWrite: Annotation(),
  toolCallsTotal: Annotation(),
  firstTtft: Annotation(),
  activeModel: Annotation(),
  fallbackUsed: Annotation(),
  pendingAnnounced: Annotation(),
  /**
   * Fase 5: estado da tarefa (solicitação) carregado a cada rodada.
   * O nome do canal não pode coincidir com o nome do nó (limite do LangGraph:
   * `task` já é nó), por isso `taskState`.
   */
  taskState: Annotation(),
  error: Annotation(),
  trace: Annotation(),
});

const bump = (trace, node) => [...(trace ?? []), node];

/**
 * Cria o grafo de um turno.
 *
 * @param {object} primitives
 * @param {(state) => object} primitives.prepareRound   monta mensagens + ferramentas da rodada
 * @param {(args) => Promise<object>} primitives.callModel  chama o gateway (com fallback)
 * @param {(call, state) => Promise<object>} primitives.runReadTool  executa ferramenta de leitura
 * @param {(call) => object} primitives.requestWrite    cria ação pendente (não executa)
 * @param {(state) => void} primitives.finalize         métricas + evento done
 */
export function createTurnGraph(primitives) {
  const { prepareRound, callModel, handleToolCall, persistAssistant, persistToolMessage, finalize } = primitives;

  /* ------------------------------- nós ---------------------------------- */

  async function prepare(state) {
    const rounds = (state.rounds ?? 0) + 1;
    const prepared = prepareRound({ ...state, rounds });
    return {
      ...prepared, // { messages, toolSchemas, activeTools }
      rounds,
      trace: bump(state.trace, 'prepare'),
    };
  }

  /**
   * Nó `task` — estado da tarefa (Fase 5).
   *
   * Por que no grafo e não no prompt: o briefing pede que o LangGraph mantenha o
   * estado da tarefa. Aqui ele é **carregado a cada rodada** (o visitante pode
   * ter anexado um arquivo, corrigido um dado ou cancelado no meio do turno) e
   * viaja no estado até o nó `model`, que o injeta no contexto. A persistência
   * real é o store de solicitações; o grafo só carrega e transporta.
   */
  async function task(state) {
    if (typeof primitives.loadTask !== 'function') return {};
    let snapshot = null;
    try {
      snapshot = await primitives.loadTask(state);
    } catch (error) {
      primitives.logger?.warn?.('Falha ao carregar estado da tarefa', { message: error?.message });
    }
    return {
      taskState: snapshot ?? null,
      trace: bump(state.trace, 'task'),
    };
  }

  async function model(state) {
    const { emit, signal } = state.io;
    const result = await callModel({
      messages: state.messages,
      tools: state.toolSchemas,
      signal,
      emit,
      io: state.io,
    });

    persistAssistant(result, state.io);

    return {
      result,
      activeModel: result.model,
      fallbackUsed: Boolean(state.fallbackUsed || result.fallbackUsed),
      firstTtft: state.firstTtft ?? (Number.isFinite(result.ttftMs) ? result.ttftMs : null),
      trace: bump(state.trace, 'model'),
    };
  }

  async function tools(state) {
    const { emit, signal, ctx } = state.io;
    const calls = state.result?.toolCalls ?? [];
    let toolCallsTotal = state.toolCallsTotal ?? 0;
    let pending = state.pendingAnnounced ?? null;
    let allowWrite = state.allowWrite !== false;

    for (const call of calls) {
      if (signal?.aborted) break;
      toolCallsTotal += 1;

      const handled = await handleToolCall({
        call,
        io: state.io,
        allowWrite,
        pendingActionExists: Boolean(pending),
        emit,
      });

      if (handled?.content !== undefined) persistToolMessage(call, handled.content, state.io);
      if (handled.pending) {
        pending = handled.pending;
        // Depois de criar uma ação, só leitura nas rodadas seguintes (sem cascata).
        allowWrite = false;
      }
    }

    return {
      toolCallsTotal,
      pendingAnnounced: pending,
      allowWrite,
      trace: bump(state.trace, 'tools'),
    };
  }

  /** Limite de rodadas atingido: responde TODAS as chamadas e encerra. */
  async function overflow(state) {
    const { emit } = state.io;
    const calls = state.result?.toolCalls ?? [];
    for (const call of calls) {
      persistToolMessage(
        call,
        primitives.toolResultContent({
          ok: false,
          erro: { codigo: 'too_many_rounds', mensagem: 'Limite de chamadas de ferramenta atingido nesta mensagem.' },
        }),
        state.io,
      );
    }
    emit?.({ type: 'status', stage: 'tool', label: 'Limite de ferramentas atingido nesta mensagem.' });
    return {
      toolCallsTotal: (state.toolCallsTotal ?? 0) + calls.length,
      trace: bump(state.trace, 'overflow'),
    };
  }

  async function done(state) {
    finalize(state);
    return { trace: bump(state.trace, 'finalize') };
  }

  /* ------------------------------ arestas -------------------------------- */

  const routeAfterModel = (state) => {
    if (state.error) return 'finalize';
    const calls = state.result?.toolCalls ?? [];
    if (!calls.length) return 'finalize';
    if ((state.rounds ?? 0) > primitives.maxToolRounds()) return 'overflow';
    return 'tools';
  };

  /* ------------------------------ o grafo -------------------------------- */

  return new StateGraph(TurnState)
    .addNode('prepare', prepare)
    .addNode('task', task)
    .addNode('model', model)
    .addNode('tools', tools)
    .addNode('overflow', overflow)
    .addNode('finalize', done)
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'task')
    .addEdge('task', 'model')
    .addConditionalEdges('model', routeAfterModel, {
      tools: 'tools',
      overflow: 'overflow',
      finalize: 'finalize',
    })
    .addEdge('tools', 'prepare')
    .addEdge('overflow', 'finalize')
    .addEdge('finalize', END)
    .compile();
}

/** Estado inicial de um turno. */
export function initialTurnState({ io, allowWrite = true }) {
  return {
    io,
    rounds: 0,
    messages: [],
    toolSchemas: [],
    activeTools: [],
    result: null,
    allowWrite,
    toolCallsTotal: 0,
    firstTtft: null,
    activeModel: null,
    fallbackUsed: false,
    pendingAnnounced: null,
    error: null,
    trace: [],
  };
}
