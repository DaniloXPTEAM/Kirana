/**
 * Integração HTTP real: /api/agui (adaptador AG-UI) e /api/copilot (runtime
 * oficial do CopilotKit).
 *
 * Usa o servidor Kirana de verdade + gateway falso no contrato OpenAI/SSE.
 * O que é simulado aqui: SOMENTE o modelo do gateway. O transporte, a
 * sessão, as ferramentas, o streaming e o protocolo AG-UI são reais.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startFakeGateway, startKirana } from './helpers.js';

const TOOLS = [
  {
    name: 'navigateToPage',
    description: 'Navega para uma página.',
    parameters: { type: 'object', properties: { page: { type: 'string', enum: ['inicio', 'solucoes', 'labs', 'contato'] } }, required: ['page'] },
  },
  {
    name: 'submitContactRequest',
    description: 'Envia o pedido (sensível).',
    parameters: { type: 'object', properties: {} },
  },
];

async function readSseEvents(response) {
  const events = [];
  const text = await response.text();
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        events.push(JSON.parse(payload));
      } catch {
        /* ignora */
      }
    }
  }
  return events;
}

async function postAgui(base, body, headers = {}) {
  return fetch(`${base}/api/agui`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('AG-UI: run completo emite RUN_STARTED → texto → RUN_FINISHED', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'Olá! Sou a Kirana.' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await postAgui(kirana.base, {
      threadId: 't-1',
      runId: 'r-1',
      messages: [{ id: 'm1', role: 'user', content: 'Oi' }],
      tools: [],
      state: {},
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const events = await readSseEvents(response);
    const types = events.map((e) => e.type);
    assert.equal(types[0], 'RUN_STARTED');
    assert.ok(types.includes('TEXT_MESSAGE_START'));
    assert.ok(types.filter((t) => t === 'TEXT_MESSAGE_CONTENT').length > 0);
    assert.ok(types.includes('TEXT_MESSAGE_END'));
    assert.equal(types.at(-1), 'RUN_FINISHED');

    const text = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta).join('');
    assert.match(text, /Kirana/);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('AG-UI: ferramenta de frontend é anunciada com nome e argumentos', async () => {
  const gateway = await startFakeGateway({
    script: ({ callIndex }) =>
      callIndex === 0
        ? { toolCalls: [{ id: 'call_1', name: 'navigateToPage', args: { page: 'contato' } }] }
        : { text: 'Pronto, abri a página de contato.' },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await postAgui(
      kirana.base,
      { threadId: 't-2', runId: 'r-2', messages: [{ id: 'm1', role: 'user', content: 'Abra o contato' }], tools: TOOLS, state: { page: 'inicio' } },
      { 'x-kirana-site': 'demo-opportunity' },
    );
    const events = await readSseEvents(response);

    const start = events.find((e) => e.type === 'TOOL_CALL_START');
    const argsEvent = events.find((e) => e.type === 'TOOL_CALL_ARGS');
    const end = events.find((e) => e.type === 'TOOL_CALL_END');

    assert.ok(start, 'precisa anunciar a chamada');
    assert.equal(start.toolCallName, 'navigateToPage');
    assert.deepEqual(JSON.parse(argsEvent.delta), { page: 'contato' });
    assert.equal(end.toolCallId, start.toolCallId);
    // Só uma chamada anunciada (não duplicar) e ela vem antes do texto final.
    assert.equal(events.filter((e) => e.type === 'TOOL_CALL_START').length, 1);
    assert.ok(events.indexOf(start) < events.findIndex((e) => e.type === 'RUN_FINISHED'));
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('AG-UI: ferramenta fora do kit do site não é executável nem anunciada', async () => {
  const gateway = await startFakeGateway({
    script: ({ callIndex }) =>
      callIndex === 0 ? { toolCalls: [{ id: 'call_x', name: 'abrirOrcamento', args: {} }] } : { text: 'ok' },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await postAgui(
      kirana.base,
      {
        threadId: 't-3',
        runId: 'r-3',
        messages: [{ id: 'm1', role: 'user', content: 'Abra o orçamento' }],
        tools: [{ name: 'abrirOrcamento', description: 'proibida', parameters: { type: 'object', properties: {} } }],
        state: {},
      },
      { 'x-kirana-site': 'demo-opportunity' },
    );
    const events = await readSseEvents(response);

    assert.equal(events.filter((e) => e.type === 'TOOL_CALL_START' && e.toolCallName === 'abrirOrcamento').length, 0);
    assert.equal(events.at(-1).type, 'RUN_FINISHED');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('AG-UI: mensagem vazia devolve RUN_ERROR sem chamar o gateway', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'não deveria ser chamado' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await postAgui(kirana.base, { threadId: 't-4', runId: 'r-4', messages: [], tools: [], state: {} });
    const events = await readSseEvents(response);

    assert.equal(events.at(-1).type, 'RUN_ERROR');
    assert.equal(events.at(-1).code, 'empty_message');
    assert.equal(gateway.requests.length, 0);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('AG-UI: erro do gateway vira RUN_ERROR (e não derruba o servidor)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ status: 500, error: 'boom' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await postAgui(kirana.base, {
      threadId: 't-5',
      runId: 'r-5',
      messages: [{ id: 'm1', role: 'user', content: 'oi' }],
      tools: [],
      state: {},
    });
    const events = await readSseEvents(response);
    assert.equal(events.at(-1).type, 'RUN_ERROR');

    // Servidor continua saudável depois do erro.
    const health = await fetch(`${kirana.base}/health`);
    assert.equal(health.status, 200);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('AG-UI: estado compartilhado chega ao modelo sem dados sensíveis', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    await readSseEvents(
      await postAgui(kirana.base, {
        threadId: 't-6',
        runId: 'r-6',
        messages: [{ id: 'm1', role: 'user', content: 'onde estou?' }],
        tools: [],
        state: { page: 'labs', formStep: 'idle', token: 'nao-pode-vazar', apiKey: 'sk-123' },
      }),
    );

    const system = gateway.requests[0].messages[0];
    assert.equal(system.role, 'system');
    assert.match(system.content, /page: labs/);
    assert.doesNotMatch(system.content, /nao-pode-vazar/);
    assert.doesNotMatch(system.content, /sk-123/);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('AG-UI: histórico da mesma thread é reutilizado (sessão isolada por site)', async () => {
  let call = 0;
  const gateway = await startFakeGateway({
    script: () => {
      call += 1;
      return { text: `resposta ${call}` };
    },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    await readSseEvents(
      await postAgui(kirana.base, { threadId: 'thread-x', runId: 'r-a', messages: [{ id: 'm1', role: 'user', content: 'primeira' }], tools: [], state: {} }),
    );
    await readSseEvents(
      await postAgui(kirana.base, {
        threadId: 'thread-x',
        runId: 'r-b',
        messages: [
          { id: 'm1', role: 'user', content: 'primeira' },
          { id: 'm2', role: 'assistant', content: 'resposta 1' },
          { id: 'm3', role: 'user', content: 'segunda' },
        ],
        tools: [],
        state: {},
      }),
    );

    const secondCallMessages = gateway.requests[1].messages;
    const contents = secondCallMessages.map((m) => m.content);
    assert.ok(contents.includes('primeira'), 'histórico da sessão deve aparecer');
    assert.ok(contents.includes('segunda'));
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('CopilotKit: runtime oficial responde ao envelope {method:"agent/run"}', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'vindo pelo CopilotKit' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await fetch(`${kirana.base}/api/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'agent/run',
        params: { agentId: 'kirana' },
        body: {
          threadId: 'ck-1',
          runId: 'ckr-1',
          messages: [{ id: 'm1', role: 'user', content: 'Oi pelo CopilotKit' }],
          tools: [],
          state: {},
          forwardedProps: {},
        },
      }),
    });

    assert.equal(response.status, 200);
    const events = await readSseEvents(response);
    const types = events.map((e) => e.type);
    assert.equal(types[0], 'RUN_STARTED');
    assert.equal(types.at(-1), 'RUN_FINISHED');
    const text = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta).join('');
    assert.match(text, /CopilotKit/);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('CopilotKit: método inválido é recusado com erro de protocolo', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'x' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await fetch(`${kirana.base}/api/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'metodo/inexistente' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.message || '', /Unsupported method|Missing method/i);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('rotas antigas continuam funcionando ao lado das novas', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'oi' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const health = await fetch(`${kirana.base}/health`);
    assert.equal((await health.json()).status, 'ok');

    const config = await fetch(`${kirana.base}/api/config`);
    assert.equal(config.status, 200);

    const tools = await fetch(`${kirana.base}/api/tools`);
    assert.equal(tools.status, 200);

    const info = await fetch(`${kirana.base}/api/copilot/info?site=demo-opportunity`);
    const payload = await info.json();
    assert.equal(payload.site.id, 'demo-opportunity');
    assert.ok(payload.site.tools.length >= 6);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});
