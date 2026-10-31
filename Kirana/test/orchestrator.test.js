/**
 * Orquestração com LangGraph — testes do grafo em si e paridade com o loop
 * da Fase 1 (`KIRANA_ORCHESTRATOR=legacy`).
 *
 * Objetivo: provar que a troca do orquestrador não mudou comportamento
 * observável (eventos SSE, ordem, ferramentas, confirmação, fallback).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTurnGraph, initialTurnState } from '../src/graph.js';
import { loadConfig } from '../src/config.js';
import { startFakeGateway, startKirana, postSse } from './helpers.js';

/* -------------------------------------------------------------------------- */
/* 1. O grafo isolado (sem HTTP, sem gateway)                                 */
/* -------------------------------------------------------------------------- */

function makeGraph({ toolCallRounds = 0, maxRounds = 4, resultText = 'resposta' } = {}) {
  const calls = [];
  let round = 0;

  const graph = createTurnGraph({
    prepareRound: (state) => {
      calls.push(`prepare:${state.rounds}`);
      return { messages: [{ role: 'user', content: 'x' }], toolSchemas: [], activeTools: [] };
    },
    callModel: async ({ io }) => {
      calls.push('model');
      round += 1;
      const toolCalls =
        round <= toolCallRounds
          ? [{ id: `call_${round}`, type: 'function', function: { name: 'consultar_servicos', arguments: '{}' } }]
          : [];
      return { text: toolCalls.length ? '' : resultText, toolCalls, model: 'gpt-6-luna', ttftMs: 100, fallbackUsed: false };
    },
    handleToolCall: async ({ call }) => {
      calls.push(`tool:${call.function.name}`);
      ioEmit.buffer.push({ type: 'tool_result', name: call.function.name });
      return { content: '{"ok":true}' };
    },
    persistAssistant: () => calls.push('persist:assistant'),
    persistToolMessage: () => calls.push('persist:tool'),
    finalize: (state) => {
      calls.push('finalize');
      ioEmit.buffer.push({ type: 'done', rounds: state.rounds, toolCalls: state.toolCallsTotal });
      return { responseMs: 1 };
    },
    toolResultContent: (payload) => JSON.stringify(payload),
    maxToolRounds: () => maxRounds,
  });

  const ioEmit = { buffer: [], emit: (event) => ioEmit.buffer.push(event) };
  return { graph, calls, events: ioEmit.buffer, io: { emit: ioEmit.emit, session: { pendingAction: null }, ctx: {}, toolCache: new Map(), startedAt: Date.now() } };
}

test('grafo sem ferramenta: prepare → model → finalize', async () => {
  const { graph, calls, io } = makeGraph({ toolCallRounds: 0 });
  await graph.invoke(initialTurnState({ io }));
  assert.deepEqual(calls.filter((c) => c === 'model' || c === 'finalize'), ['model', 'finalize']);
  assert.equal(calls[0], 'prepare:1');
});

test('grafo com uma ferramenta: volta para prepare e chama o modelo de novo', async () => {
  const { graph, calls, io } = makeGraph({ toolCallRounds: 1 });
  const state = await graph.invoke(initialTurnState({ io }));
  assert.deepEqual(calls.filter((c) => c.startsWith('prepare')), ['prepare:1', 'prepare:2']);
  assert.equal(calls.filter((c) => c === 'model').length, 2);
  assert.ok(calls.includes('tool:consultar_servicos'));
  assert.deepEqual(state.trace, ['prepare', 'model', 'tools', 'prepare', 'model', 'finalize']);
});

test('grafo respeita o limite de rodadas (overflow) e encerra', async () => {
  const { graph, calls, io } = makeGraph({ toolCallRounds: 10, maxRounds: 1 });
  const state = await graph.invoke(initialTurnState({ io }));
  assert.ok(state.trace.includes('overflow'), `trace: ${state.trace.join(' → ')}`);
  assert.equal(state.trace.at(-1), 'finalize');
  assert.equal(calls.filter((c) => c === 'model').length, 2, 'não deve passar de maxRounds + 1 chamadas');
});

test('grafo registra métricas de ferramentas no estado final', async () => {
  const { graph, io } = makeGraph({ toolCallRounds: 2 });
  const state = await graph.invoke(initialTurnState({ io }));
  assert.equal(state.toolCallsTotal, 2);
  assert.equal(state.firstTtft, 100);
  assert.equal(state.activeModel, 'gpt-6-luna');
});

test('erro na chamada do modelo propaga (o agente trata fora do grafo)', async () => {
  const graph = createTurnGraph({
    prepareRound: () => ({ messages: [], toolSchemas: [], activeTools: [] }),
    callModel: async () => {
      throw Object.assign(new Error('falhou'), { code: 'gateway_unreachable' });
    },
    handleToolCall: async () => ({}),
    persistAssistant: () => {},
    persistToolMessage: () => {},
    finalize: () => {},
    toolResultContent: (p) => JSON.stringify(p),
    maxToolRounds: () => 4,
  });

  await assert.rejects(
    () => graph.invoke(initialTurnState({ io: { emit: () => {}, ctx: {}, toolCache: new Map(), startedAt: Date.now() } })),
    (error) => error.code === 'gateway_unreachable',
  );
});

/* -------------------------------------------------------------------------- */
/* 2. Paridade ponta a ponta: langgraph x legacy                              */
/* -------------------------------------------------------------------------- */

async function runConversation(orchestrator) {
  let calls = 0;
  const gateway = await startFakeGateway({
    script: ({ body }) => {
      calls += 1;
      const hasToolResult = body.messages.some((m) => m.role === 'tool');
      if (calls === 1) return { toolCalls: [{ name: 'consultar_servicos', args: { consulta: 'whatsapp' } }] };
      if (hasToolResult) return { text: 'Encontrei o serviço de atendimento digital.' };
      return { text: 'Resposta simples.' };
    },
  });

  const kirana = await startKirana({
    gatewayUrl: gateway.url,
    env: { KIRANA_ORCHESTRATOR: orchestrator, KIRANA_MODEL_PROBE: 'false' },
  });

  try {
    const session = await (await fetch(`${kirana.base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })).json();

    const turn1 = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Quais serviços vocês têm?' });
    const turn2 = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Obrigado' });

    const shape = (run) =>
      run.events.map((event) => {
        if (event.type === 'done') return `done:model=${event.model}:toolCalls=${event.toolCalls}`;
        if (event.type === 'delta') return 'delta';
        return event.type;
      });

    return {
      turn1: shape(turn1).filter((e) => e !== 'delta').join(','),
      turn2: shape(turn2).filter((e) => e !== 'delta').join(','),
      text1: turn1.events.filter((e) => e.type === 'delta').map((e) => e.text).join(''),
      text2: turn2.events.filter((e) => e.type === 'delta').map((e) => e.text).join(''),
      done1: turn1.events.find((e) => e.type === 'done'),
      done2: turn2.events.find((e) => e.type === 'done'),
      requests: gateway.requests.length,
      sessionId: session.id,
    };
  } finally {
    await kirana.close();
    await gateway.close();
  }
}

test('langgraph e legacy produzem o mesmo fluxo observável', async () => {
  const graph = await runConversation('langgraph');
  const legacy = await runConversation('legacy');

  assert.equal(graph.turn1, legacy.turn1, 'sequência de eventos do turno 1 difere');
  assert.equal(graph.turn2, legacy.turn2, 'sequência de eventos do turno 2 difere');
  assert.equal(graph.text1, legacy.text1, 'texto do turno 1 difere');
  assert.equal(graph.text2, legacy.text2, 'texto do turno 2 difere');
  assert.equal(graph.done1.toolCalls, legacy.done1.toolCalls);
  assert.equal(graph.done2.toolCalls, legacy.done2.toolCalls);
  assert.equal(graph.requests, legacy.requests, 'número de chamadas ao gateway difere');
});

test('o evento done informa qual orquestrador executou (evidência, não suposição)', async () => {
  const graph = await runConversation('langgraph');
  const legacy = await runConversation('legacy');
  assert.equal(graph.done1.orchestrator, 'langgraph');
  assert.equal(legacy.done1.orchestrator, 'legacy');
});

test('rollback por configuração funciona (KIRANA_ORCHESTRATOR=legacy)', async () => {
  const config = loadConfig({ KIRANA_ORCHESTRATOR: 'legacy' });
  assert.equal(config.agent.orchestrator, 'legacy');
  const padrao = loadConfig({});
  assert.equal(padrao.agent.orchestrator, 'langgraph');
});

test('confirmação de escrita funciona igual nos dois orquestradores', async () => {
  const results = {};

  for (const orchestrator of ['langgraph', 'legacy']) {
    let calls = 0;
    const gateway = await startFakeGateway({
      script: () => {
        calls += 1;
        if (calls === 1) {
          return {
            toolCalls: [
              {
                name: 'registrar_interesse_comercial',
                args: { nome: 'Ana', canal_tipo: 'email', canal_valor: 'ana@exemplo.com', interesse: 'Atendimento', consentimento: true },
              },
            ],
          };
        }
        return { text: 'Preparei o registro. Confirma?' };
      },
    });
    const kirana = await startKirana({ gatewayUrl: gateway.url, env: { KIRANA_ORCHESTRATOR: orchestrator, KIRANA_MODEL_PROBE: 'false' } });

    try {
      const session = await (await fetch(`${kirana.base}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })).json();
      const run = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Quero registrar interesse' });
      const action = run.events.find((e) => e.type === 'confirmation')?.action;
      assert.ok(action, `${orchestrator}: deveria pedir confirmação`);

      const confirmed = await postSse(kirana.base, '/api/chat/confirm', { sessionId: session.id, actionId: action.id, approve: true });
      const toolResult = confirmed.events.find((e) => e.type === 'tool_result');
      results[orchestrator] = { requested: Boolean(action), executed: toolResult?.executed === true, ok: toolResult?.ok === true };
    } finally {
      await kirana.close();
      await gateway.close();
    }
  }

  assert.deepEqual(results.langgraph, results.legacy);
  assert.equal(results.langgraph.executed, true);
});
