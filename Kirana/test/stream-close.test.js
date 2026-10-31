/**
 * Encerramento do turno no backend — o outro lado do bug do indicador.
 *
 * Verifica, com HTTP real:
 *   - `done` é o último evento e o SSE é fechado (o navegador recebe EOF);
 *   - erro também fecha o stream (sem deixar a UI esperando);
 *   - cancelamento do cliente encerra o turno;
 *   - a conexão com o GATEWAY é liberada quando paramos de ler em `[DONE]`
 *     (antes ficava aberta: um socket vazado por turno).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startFakeGateway, startKirana, postSse } from './helpers.js';

/** Fecha a resposta do servidor de teste mesmo com socket keep-alive pendurado. */
const closeServer = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

async function newSession(base) {
  const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return response.json();
}

test('conclusão normal: done é o último evento e o stream é fechado', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'Resposta completa da Kirana.' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: { KIRANA_MODEL_PROBE: 'false' } });
  try {
    const session = await newSession(kirana.base);
    const run = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'oi' });

    // postSse lê o corpo até o fim: se o servidor não fechasse, o teste penduraria.
    assert.equal(run.ok, true);
    const ultimo = run.events.at(-1);
    assert.equal(ultimo.type, 'done', `último evento foi ${ultimo.type}`);
    assert.equal(run.events.filter((e) => e.type === 'done').length, 1);
    assert.equal(ultimo.orchestrator, 'langgraph');
    assert.ok(ultimo.totalMs >= 0);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('o stream fecha em tempo curto depois do done (sem travar o cliente)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: { KIRANA_MODEL_PROBE: 'false' } });
  try {
    const session = await newSession(kirana.base);
    const startedAt = Date.now();
    const response = await fetch(`${kirana.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, message: 'oi' }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let texto = '';
    const prazo = setTimeout(() => reader.cancel(), 5000);

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      texto += decoder.decode(value, { stream: true });
    }
    clearTimeout(prazo);

    assert.match(texto, /"type":"done"/);
    assert.ok(Date.now() - startedAt < 5000, 'fechamento demorou demais');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('erro do gateway: evento error e stream fechado', async () => {
  const gateway = await startFakeGateway({ script: () => ({ status: 401, error: 'unauthorized' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: { KIRANA_MODEL_PROBE: 'false' } });
  try {
    const session = await newSession(kirana.base);
    const run = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'oi' });
    assert.equal(run.ok, true);
    assert.equal(run.events.at(-1).type, 'error');
    assert.equal(run.events.some((e) => e.type === 'done'), false);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('cancelamento do cliente encerra o turno e não deixa o backend pendurado', async () => {
  // Gateway que responde devagar: dá tempo de abortar no meio.
  const lento = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-6-luna' }] }));
      return;
    }
    for await (const _ of req) {
      /* drena */
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      try {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `pedaco${i} ` } }] })}\n\n`);
      } catch {
        clearInterval(timer);
      }
      if (i > 40) clearInterval(timer);
    }, 50);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => lento.listen(0, '127.0.0.1', resolve));

  const kirana = await startKirana({ gatewayUrl: `http://127.0.0.1:${lento.address().port}`, env: { KIRANA_MODEL_PROBE: 'false' } });
  try {
    const session = await newSession(kirana.base);
    const controller = new AbortController();
    const pedido = fetch(`${kirana.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, message: 'oi' }),
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await pedido.catch(() => null);

    // O backend tem que continuar saudável depois do abort.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = await fetch(`${kirana.base}/health`);
    assert.equal(status.status, 200);
  } finally {
    await kirana.close();
    await closeServer(lento);
  }
});

test('a conexão com o gateway é liberada após [DONE] (sem socket vazado)', async () => {
  let conexaoFechadaPeloCliente = false;

  // Gateway que manda [DONE] e NÃO fecha (keep-alive), como um servidor SSE real.
  const keepAlive = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-6-luna' }] }));
      return;
    }
    for await (const _ of req) {
      /* drena */
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Ok.' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping);
      }
    }, 100);
    res.on('close', () => {
      conexaoFechadaPeloCliente = true;
      clearInterval(ping);
    });
  });
  await new Promise((resolve) => keepAlive.listen(0, '127.0.0.1', resolve));

  const kirana = await startKirana({ gatewayUrl: `http://127.0.0.1:${keepAlive.address().port}`, env: { KIRANA_MODEL_PROBE: 'false' } });
  try {
    const session = await newSession(kirana.base);
    const run = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'oi' });
    assert.equal(run.events.at(-1).type, 'done');

    // Dá tempo do socket fechar do lado do gateway.
    for (let i = 0; i < 20 && !conexaoFechadaPeloCliente; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(conexaoFechadaPeloCliente, true, 'o backend deixou a conexão com o gateway aberta');
  } finally {
    await kirana.close();
    await closeServer(keepAlive);
  }
});
