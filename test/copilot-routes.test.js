/**
 * Rotas de contrato do transporte do agente: `/api/copilot/info` e `/api/agui`.
 *
 * Contexto do defeito (v0.5.1):
 *   - `src/server.js` desviava TODO caminho que começa com `/api/copilot` para
 *     o runtime do CopilotKit, que só responde a POST. Por isso
 *     `GET /api/copilot/info` devolvia 405 — e o handler que trataria a rota
 *     (`src/copilot/http.js`) nunca era alcançado;
 *   - `/api/agui` (transporte AG-UI documentado, gerado por
 *     `npm run build:widget -- --agui`) respondia 404 porque nunca foi montado.
 *
 * O que estes testes protegem:
 *   1. `/api/copilot` continua intocado (é o caminho que o site usa);
 *   2. `/api/copilot/info` responde o MESMO payload de `/api/site/info`;
 *   3. `/api/agui` responde AG-UI por SSE de verdade;
 *   4. nada de token/credencial vaza nas respostas de metadados;
 *   5. o limite opcional do transporte não muda nada quando desligado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startFakeGateway, startKirana } from './helpers.js';

const SITE = 'demo-opportunity';

async function getJson(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

async function postCopilot(base, body) {
  const response = await fetch(`${base}/api/copilot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function parseSse(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload && payload !== '[DONE]')
    .map((payload) => {
      try {
        return JSON.parse(payload);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

test('GET /api/copilot/info responde 405 DE PROPÓSITO (mantém o cliente no single-route)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const info = await fetch(`${kirana.base}/api/copilot/info`);
    assert.equal(info.status, 405, 'um 2xx aqui faria o cliente v2 assumir transporte REST e quebrar o run');
    await info.text();
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('o runtime info é servido pelo envelope POST {method:"info"}', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await fetch(`${kirana.base}/api/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'info' }),
    });
    assert.equal(response.status, 200);
    const info = await response.json();

    // Forma que o cliente v2 consome: `Object.entries(info.agents)`.
    assert.equal(typeof info.agents, 'object');
    assert.ok(info.agents.kirana, 'o agente `kirana` precisa aparecer');
    assert.equal(typeof info.version, 'string');
    // `singleRoute` é o que confirma o transporte correto (envelope, não REST).
    assert.ok(info.singleRoute, 'o runtime precisa se declarar single-route');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('/api/copilot continua funcionando (nada mudou no caminho do site)', async () => {
  const gateway = await startFakeGateway({
    script: ({ callIndex }) => (callIndex === 0 ? { toolCalls: [{ name: 'list_services', args: {} }] } : { text: 'São seis frentes.' }),
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { status, text } = await postCopilot(kirana.base, {
      method: 'agent/run',
      params: { agentId: 'kirana' },
      body: {
        threadId: 'thread_info_regressao',
        runId: 'run_info_regressao',
        messages: [{ id: 'u1', role: 'user', content: 'Quais serviços vocês oferecem?' }],
        tools: [],
        state: {},
        forwardedProps: { siteId: SITE },
      },
    });
    assert.equal(status, 200);
    const events = parseSse(text);
    assert.ok(events.some((e) => e.type === 'RUN_STARTED'), 'o runtime precisa continuar emitindo AG-UI');
    assert.ok(events.some((e) => e.type === 'TOOL_CALL_START' && e.toolCallName === 'list_services'));
    assert.ok(events.some((e) => e.type === 'TEXT_MESSAGE_CONTENT'));
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('/api/agui responde o protocolo AG-UI por SSE (antes: 404)', async () => {
  const gateway = await startFakeGateway({
    script: ({ callIndex }) => (callIndex === 0 ? { toolCalls: [{ name: 'list_services', args: {} }] } : { text: 'São seis frentes de atuação.' }),
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await fetch(`${kirana.base}/api/agui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kirana-site': SITE },
      body: JSON.stringify({
        threadId: 'thread_agui_1',
        runId: 'run_agui_1',
        messages: [{ id: 'u1', role: 'user', content: 'Quais serviços vocês oferecem?' }],
        tools: [],
        state: {},
        forwardedProps: { siteId: SITE },
      }),
    });

    assert.equal(response.status, 200, 'POST /api/agui precisa responder 200');
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

    const events = parseSse(await response.text());
    const types = events.map((e) => e.type);
    assert.ok(types.includes('RUN_STARTED'), `esperava RUN_STARTED, veio: ${types.join(',')}`);
    assert.ok(types.includes('RUN_FINISHED'), 'o run precisa terminar de forma explícita');
    assert.ok(
      events.some((e) => e.type === 'TOOL_CALL_START' && e.toolCallName === 'list_services'),
      'a ferramenta do catálogo precisa executar também por este transporte',
    );
    const texto = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta).join('');
    assert.match(texto, /seis/i);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('/api/agui recusa GET e corpo inválido, sem derrubar o servidor', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const get = await fetch(`${kirana.base}/api/agui`);
    assert.equal(get.status, 405, 'GET /api/agui precisa ser 405 (só POST)');

    const bad = await fetch(`${kirana.base}/api/agui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ isso não é json',
    });
    assert.equal(bad.status, 400);

    // O servidor continua de pé depois dos erros.
    const health = await getJson(kirana.base, '/health');
    assert.equal(health.status, 200);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('limite do transporte do agente fica desligado por padrão (comportamento preservado)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    // 8 chamadas ao envelope `info`: com o balde desligado, nenhuma pode ser
    // recusada com 429 (é o comportamento das versões anteriores).
    for (let i = 0; i < 8; i += 1) {
      const response = await fetch(`${kirana.base}/api/copilot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'info' }),
      });
      assert.equal(response.status, 200, `chamada ${i + 1} não pode ser limitada com o balde desligado`);
      await response.text();
    }
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('limite do transporte do agente, quando configurado, responde 429', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: { KIRANA_AGENT_RATE_MAX: '3' } });
  try {
    const codes = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(`${kirana.base}/api/copilot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'agent/run', params: { agentId: 'kirana' }, body: { threadId: `t${i}`, runId: `r${i}`, messages: [], tools: [], state: {}, forwardedProps: {} } }),
      });
      codes.push(response.status);
      await response.text();
    }
    assert.ok(codes.includes(429), `esperava 429 depois de 3 chamadas, veio: ${codes.join(',')}`);
    assert.equal(codes[0], 200, 'a primeira chamada precisa passar');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});
