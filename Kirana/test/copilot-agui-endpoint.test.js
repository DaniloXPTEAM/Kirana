/**
 * Integração real com o runtime OFICIAL do CopilotKit (`/api/copilot`).
 *
 * Arquitetura final (v0.3.0):
 *   widget -> POST /api/copilot {method:"agent/run"} -> CopilotRuntime
 *          -> BuiltInAgent(custom) -> agente Kirana (LangGraph) -> gateway
 *
 * O único elemento simulado aqui é o MODELO (gateway falso no contrato
 * OpenAI/SSE). Runtime, protocolo AG-UI, sessões, ferramentas, streaming e
 * cancelamento são reais.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startFakeGateway, startKirana } from './helpers.js';

const SITE = 'demo-opportunity';

const TOOLS = [
  {
    name: 'navigateToPage',
    description: 'Navega para uma página.',
    parameters: {
      type: 'object',
      properties: { page: { type: 'string', enum: ['inicio', 'solucoes', 'labs', 'contato'] } },
      required: ['page'],
    },
  },
  { name: 'submitContactRequest', description: 'Envia o pedido (sensível).', parameters: { type: 'object', properties: {} } },
];

/** Envelope do runtime oficial do CopilotKit (single-route). */
function envelope({ threadId, runId, messages, tools = [], state = {}, forwardedProps = {} }) {
  return {
    method: 'agent/run',
    params: { agentId: 'kirana' },
    body: { threadId, runId, messages, tools, state, forwardedProps },
  };
}

function parseSse(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        events.push(JSON.parse(payload));
      } catch {
        /* ignora linha malformada */
      }
    }
  }
  return events;
}

async function runCopilot(base, body, { headers = {} } = {}) {
  const response = await fetch(`${base}/api/copilot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, events: parseSse(text), text };
}

const textOf = (events) =>
  events
    .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
    .map((e) => e.delta)
    .join('');

/* ------------------------------ fluxo básico ------------------------------ */

test('run completo pelo runtime oficial: RUN_STARTED → texto → RUN_FINISHED', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'Olá! Sou a Kirana.' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { response, events } = await runCopilot(
      kirana.base,
      envelope({ threadId: 't-1', runId: 'r-1', messages: [{ id: 'm1', role: 'user', content: 'Oi' }] }),
    );

    assert.equal(response.status, 200);
    const seq = events.map((e) => e.type);
    assert.equal(seq[0], 'RUN_STARTED');
    assert.equal(seq.at(-1), 'RUN_FINISHED');
    assert.ok(seq.includes('TEXT_MESSAGE_START'));
    assert.ok(seq.includes('TEXT_MESSAGE_END'));
    assert.match(textOf(events), /Kirana/);
    // O RUN_FINISHED carrega thread/run corretos (contrato AG-UI).
    const finished = events.at(-1);
    assert.equal(finished.threadId, 't-1');
    assert.equal(finished.runId, 'r-1');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('ferramenta de frontend é anunciada com nome, argumentos e id único', async () => {
  const gateway = await startFakeGateway({
    script: ({ callIndex }) =>
      callIndex === 0
        ? { toolCalls: [{ id: 'call_1', name: 'navigateToPage', args: { page: 'contato' } }] }
        : { text: 'Abri a página de contato.' },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { events } = await runCopilot(
      kirana.base,
      envelope({
        threadId: 't-2',
        runId: 'r-2',
        messages: [{ id: 'm1', role: 'user', content: 'Abra o contato' }],
        tools: TOOLS,
        state: { page: 'inicio' },
        forwardedProps: { siteId: SITE },
      }),
    );

    const starts = events.filter((e) => e.type === 'TOOL_CALL_START');
    assert.equal(starts.length, 1, 'uma única chamada anunciada');
    assert.equal(starts[0].toolCallName, 'navigateToPage');

    const args = events.find((e) => e.type === 'TOOL_CALL_ARGS');
    assert.deepEqual(JSON.parse(args.delta), { page: 'contato' });

    const end = events.find((e) => e.type === 'TOOL_CALL_END');
    assert.equal(end.toolCallId, starts[0].toolCallId);

    // A chamada vem antes do fechamento do run.
    assert.ok(events.indexOf(starts[0]) < events.findIndex((e) => e.type === 'RUN_FINISHED'));
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('ferramenta fora do kit do site não é anunciada nem executada', async () => {
  const gateway = await startFakeGateway({
    script: ({ callIndex }) =>
      callIndex === 0 ? { toolCalls: [{ id: 'call_x', name: 'abrirOrcamento', args: {} }] } : { text: 'ok' },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { events } = await runCopilot(
      kirana.base,
      envelope({
        threadId: 't-3',
        runId: 'r-3',
        messages: [{ id: 'm1', role: 'user', content: 'Abra o orçamento' }],
        tools: [{ name: 'abrirOrcamento', description: 'proibida', parameters: { type: 'object', properties: {} } }],
        forwardedProps: { siteId: SITE },
      }),
    );

    assert.equal(events.filter((e) => e.type === 'TOOL_CALL_START' && e.toolCallName === 'abrirOrcamento').length, 0);
    assert.equal(events.at(-1).type, 'RUN_FINISHED');
    // A ferramenta proibida nem foi enviada ao modelo.
    const sentTools = (gateway.requests[0].tools || []).map((t) => t.function?.name);
    assert.equal(sentTools.includes('abrirOrcamento'), false);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

/* -------------------------------- erros ---------------------------------- */

test('mensagem vazia devolve RUN_ERROR e não chama o gateway', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'não deveria ser chamado' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { events } = await runCopilot(kirana.base, envelope({ threadId: 't-4', runId: 'r-4', messages: [] }));

    assert.equal(events.at(-1).type, 'RUN_ERROR');
    assert.equal(events.at(-1).code, 'empty_message');
    assert.equal(gateway.requests.length, 0);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('falha do gateway vira RUN_ERROR e o servidor continua saudável', async () => {
  const gateway = await startFakeGateway({ script: () => ({ status: 500, error: 'boom' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { events } = await runCopilot(
      kirana.base,
      envelope({ threadId: 't-5', runId: 'r-5', messages: [{ id: 'm1', role: 'user', content: 'oi' }] }),
    );
    assert.equal(events.at(-1).type, 'RUN_ERROR');

    const health = await fetch(`${kirana.base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('método desconhecido no envelope é recusado pelo runtime', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'x' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await fetch(`${kirana.base}/api/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'metodo/inexistente' }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message || '', /Unsupported method|Missing method/i);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

/* --------------------- estado compartilhado e sessões --------------------- */

test('estado da página chega ao modelo SEM dados sensíveis', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    await runCopilot(
      kirana.base,
      envelope({
        threadId: 't-6',
        runId: 'r-6',
        messages: [{ id: 'm1', role: 'user', content: 'onde estou?' }],
        state: { page: 'labs', formStep: 'idle', token: 'nao-pode-vazar', apiKey: 'sk-123', email: 'ana@exemplo.com' },
        forwardedProps: { siteId: SITE },
      }),
    );

    const system = gateway.requests[0].messages[0];
    assert.equal(system.role, 'system');
    assert.match(system.content, /page: labs/, 'estado não sensível deve chegar');
    assert.doesNotMatch(system.content, /nao-pode-vazar/);
    assert.doesNotMatch(system.content, /sk-123/);
    assert.doesNotMatch(system.content, /ana@exemplo\.com/);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('sessão persiste entre runs da mesma thread (histórico reaproveitado)', async () => {
  let call = 0;
  const gateway = await startFakeGateway({
    script: () => {
      call += 1;
      return { text: `resposta ${call}` };
    },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    await runCopilot(
      kirana.base,
      envelope({
        threadId: 'thread-x',
        runId: 'r-a',
        messages: [{ id: 'm1', role: 'user', content: 'primeira' }],
        forwardedProps: { siteId: SITE },
      }),
    );

    await runCopilot(
      kirana.base,
      envelope({
        threadId: 'thread-x',
        runId: 'r-b',
        messages: [
          { id: 'm1', role: 'user', content: 'primeira' },
          { id: 'm2', role: 'assistant', content: 'resposta 1' },
          { id: 'm3', role: 'user', content: 'segunda' },
        ],
        forwardedProps: { siteId: SITE },
      }),
    );

    const contents = gateway.requests[1].messages.map((m) => m.content);
    assert.ok(contents.includes('primeira'), 'histórico da sessão deve aparecer');
    assert.ok(contents.includes('segunda'));
    // E o modelo recebe as duas mensagens: nada de sessão "zerada".
    assert.ok(gateway.requests[1].messages.filter((m) => m.role === 'user').length >= 2);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('ISOLAMENTO: mesmo threadId em sites diferentes não compartilha histórico', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    // Site A conversa.
    await runCopilot(
      kirana.base,
      envelope({
        threadId: 'mesma-thread',
        runId: 'r-a',
        messages: [{ id: 'm1', role: 'user', content: 'segredo do cliente A' }],
        forwardedProps: { siteId: 'demo-opportunity' },
      }),
    );

    // Site B com a mesma thread: o histórico de A não pode aparecer.
    await runCopilot(
      kirana.base,
      envelope({
        threadId: 'mesma-thread',
        runId: 'r-b',
        messages: [{ id: 'm2', role: 'user', content: 'mensagem do cliente B' }],
        forwardedProps: { siteId: 'demo-parceiro' },
      }),
    );

    const secondCall = gateway.requests[1].messages.map((m) => m.content).join('\n');
    assert.match(secondCall, /cliente B/);
    assert.doesNotMatch(secondCall, /segredo do cliente A/, 'histórico não pode vazar entre sites');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('site não integrado é recusado (sem cair no site padrão)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'não deveria responder' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { events } = await runCopilot(
      kirana.base,
      envelope({
        threadId: 't-desconhecido',
        runId: 'r-desc',
        messages: [{ id: 'm1', role: 'user', content: 'oi' }],
        forwardedProps: { siteId: 'site-que-nao-existe' },
      }),
    );

    assert.equal(events.at(-1).type, 'RUN_ERROR');
    assert.equal(events.at(-1).code, 'unknown_site');
    assert.equal(gateway.requests.length, 0, 'site desconhecido não pode chegar ao modelo');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('resultado de ferramenta devolvido pelo navegador entra no contexto do turno', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'pedido registrado' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    await runCopilot(
      kirana.base,
      envelope({
        threadId: 't-tool-result',
        runId: 'r-tr',
        messages: [
          { id: 'm1', role: 'user', content: 'envie o pedido' },
          {
            id: 'm2',
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_9', type: 'function', function: { name: 'submitContactRequest', arguments: '{}' } }],
          },
          { id: 'm3', role: 'tool', toolCallId: 'call_9', content: '{"ok":true,"protocolo":"INT-2026-TESTE"}' },
        ],
        tools: TOOLS,
        forwardedProps: { siteId: SITE },
      }),
    );

    const system = gateway.requests[0].messages[0].content;
    assert.match(system, /INT-2026-TESTE/, 'o resultado real precisa voltar ao modelo');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

/* ---------------------------- cancelamento ------------------------------- */

test('cancelamento: abortar o stream no meio não trava a sessão nem o servidor', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'uma resposta bem longa '.repeat(40) }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const controller = new AbortController();
    const response = await fetch(`${kirana.base}/api/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        envelope({ threadId: 't-cancel', runId: 'r-cancel', messages: [{ id: 'm1', role: 'user', content: 'fale muito' }] }),
      ),
      signal: controller.signal,
    });

    // Lê o começo do stream e aborta (equivalente ao botão "Parar").
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});

    // Servidor continua no ar e aceita novo run.
    const health = await fetch(`${kirana.base}/health`);
    assert.equal(health.status, 200);

    const again = await runCopilot(
      kirana.base,
      envelope({ threadId: 't-cancel', runId: 'r-after', messages: [{ id: 'm1', role: 'user', content: 'de novo' }] }),
    );
    assert.equal(again.events.at(-1).type, 'RUN_FINISHED');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

/* ------------------------ compatibilidade / regressão -------------------- */

test('rotas originais e metadados do site continuam funcionando', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'oi' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    assert.equal((await (await fetch(`${kirana.base}/health`)).json()).status, 'ok');
    assert.equal((await fetch(`${kirana.base}/api/config`)).status, 200);
    assert.equal((await fetch(`${kirana.base}/api/tools`)).status, 200);

    const info = await fetch(`${kirana.base}/api/site/info?site=${SITE}`);
    assert.equal(info.status, 200);
    const payload = await info.json();
    assert.equal(payload.site.id, SITE);
    assert.ok(payload.site.tools.length >= 6);
    assert.ok(payload.site.tools.some((t) => t.name === 'submitContactRequest' && t.requiresConfirmation));
    assert.equal(payload.copilotkit, '/api/copilot');
    // Metadados não podem expor configuração interna.
    assert.equal(JSON.stringify(payload).includes('apiKey'), false);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('chat SSE original (interface antiga) segue funcionando ao lado do CopilotKit', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'resposta pelo fluxo antigo' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const session = await (
      await fetch(`${kirana.base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    ).json();

    const response = await fetch(`${kirana.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, message: 'oi pelo fluxo antigo' }),
    });
    const events = parseSse(await response.text());
    const seq = events.map((e) => e.type);

    assert.ok(seq.includes('delta'), 'o streaming antigo precisa continuar emitindo delta');
    assert.equal(seq.at(-1), 'done');
    assert.match(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), /fluxo antigo/);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});
