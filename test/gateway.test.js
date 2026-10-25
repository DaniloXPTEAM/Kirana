import test from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';

import { loadConfig } from '../src/config.js';
import { createGatewayClient, GatewayError } from '../src/gateway.js';
import { silentLogger, startFakeGateway } from './helpers.js';

const configFor = (url, overrides = {}) =>
  loadConfig({ KIRANA_GATEWAY_URL: url, KIRANA_GATEWAY_API_KEY: 'test-key', ...overrides });

test('health e models do gateway', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  try {
    const client = createGatewayClient({ config: configFor(gateway.url), logger: silentLogger });
    const health = await client.health();
    assert.equal(health.status, 'ok');
    const models = await client.models();
    assert.deepEqual(models, ['gpt-6-luna', 'gpt-6.1-sol']);
  } finally {
    await gateway.close();
  }
});

test('chatStream acumula texto e chama onDelta', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'Olá, eu sou a Kirana.' }) });
  try {
    const client = createGatewayClient({ config: configFor(gateway.url), logger: silentLogger });
    const deltas = [];
    const result = await client.chatStream({
      messages: [{ role: 'user', content: 'oi' }],
      model: 'gpt-6-luna',
      onDelta: (text) => deltas.push(text),
    });
    assert.equal(result.text, 'Olá, eu sou a Kirana.');
    assert.equal(deltas.length, 5);
    assert.equal(result.finishReason, 'stop');
    assert.ok(result.ttftMs !== null);
    assert.equal(gateway.requests[0].stream, true);
    assert.equal(gateway.requests[0].model, 'gpt-6-luna');
  } finally {
    await gateway.close();
  }
});

test('chatStream agrega tool_calls fragmentadas', async () => {
  const gateway = await startFakeGateway({
    script: () => ({ toolCalls: [{ name: 'consultar_servicos', args: { consulta: 'crm' } }] }),
  });
  try {
    const client = createGatewayClient({ config: configFor(gateway.url), logger: silentLogger });
    const result = await client.chatStream({
      messages: [{ role: 'user', content: 'serviços de crm' }],
      model: 'gpt-6-luna',
      tools: [{ type: 'function', function: { name: 'consultar_servicos', description: 'x', parameters: { type: 'object', properties: {} } } }],
    });
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'consultar_servicos');
    assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { consulta: 'crm' });
    assert.equal(result.finishReason, 'tool_calls');
  } finally {
    await gateway.close();
  }
});

test('erro de autenticação do gateway é mapeado', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  try {
    const client = createGatewayClient({
      config: loadConfig({ KIRANA_GATEWAY_URL: gateway.url, KIRANA_GATEWAY_API_KEY: 'chave-errada' }),
      logger: silentLogger,
    });
    await assert.rejects(
      () => client.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna' }),
      (error) => error instanceof GatewayError && error.code === 'gateway_auth' && error.retryable === false,
    );
  } finally {
    await gateway.close();
  }
});

test('gateway inacessível vira erro recuperável', async () => {
  const client = createGatewayClient({ config: configFor('http://127.0.0.1:9'), logger: silentLogger });
  await assert.rejects(
    () => client.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna' }),
    (error) => error.code === 'gateway_unreachable' && error.retryable === true,
  );
});

test('sem chave configurada, falha com mensagem clara', async () => {
  const client = createGatewayClient({
    config: loadConfig({ KIRANA_GATEWAY_URL: 'http://127.0.0.1:9', KIRANA_GATEWAY_API_KEY: '' }),
    logger: silentLogger,
  });
  await assert.rejects(
    () => client.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna' }),
    (error) => error.code === 'gateway_not_configured',
  );
});

test('erro HTTP do gateway é propagado com status', async () => {
  const gateway = await startFakeGateway({ script: () => ({ status: 500, error: 'falha interna' }) });
  try {
    const client = createGatewayClient({ config: configFor(gateway.url), logger: silentLogger });
    await assert.rejects(
      () => client.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna' }),
      (error) => error.code === 'gateway_http' && error.status === 500 && error.retryable === true,
    );
  } finally {
    await gateway.close();
  }
});

test('modelo indisponível (404) é marcado para fallback', async () => {
  const gateway = await startFakeGateway({ script: () => ({ status: 404, error: 'model not found' }) });
  try {
    const client = createGatewayClient({ config: configFor(gateway.url), logger: silentLogger });
    await assert.rejects(
      () => client.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-inexistente' }),
      (error) => error.code === 'model_unavailable' && error.retryable === true,
    );
  } finally {
    await gateway.close();
  }
});

test('abort do chamador encerra com código aborted', async () => {
  const gateway = await startFakeGateway({ script: () => ({ hang: true }) });
  try {
    const client = createGatewayClient({ config: configFor(gateway.url), logger: silentLogger });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      () =>
        client.chatStream({
          messages: [{ role: 'user', content: 'oi' }],
          model: 'gpt-6-luna',
          signal: controller.signal,
        }),
      (error) => error.code === 'aborted' || error.code === 'first_token_timeout',
    );
  } finally {
    await gateway.close();
  }
});

/* ------------------------------------------------------------------ */
/* Compatibilidade com o Gateway v0.2.0 (erro real de 24/10/2026)      */
/* ------------------------------------------------------------------ */

test('nenhum payload enviado contém temperature', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  try {
    const client = createGatewayClient({ config: configFor(gateway.url), logger: silentLogger });
    const result = await client.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna', temperature: 0.9 });
    assert.equal('temperature' in gateway.requests[0], false);
    assert.equal('max_tokens' in gateway.requests[0], false);
    assert.equal(result.strippedFields.length, 0);
    assert.deepEqual(result.payloadFields.sort(), ['messages', 'model', 'stream']);
  } finally {
    await gateway.close();
  }
});

test('campos internos da sessão não vazam para o gateway', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  try {
    const client = createGatewayClient({ config: configFor(gateway.url), logger: silentLogger });
    await client.chatStream({
      messages: [
        { role: 'user', content: 'oi', id: 'm_1', at: '2026-10-24T00:00:00Z' },
        { role: 'assistant', content: 'olá', model: 'gpt-6-luna', ttftMs: 900, aborted: false },
      ],
      model: 'gpt-6-luna',
    });
    const sent = gateway.requests[0].messages;
    assert.deepEqual(Object.keys(sent[0]).sort(), ['content', 'role']);
    assert.deepEqual(Object.keys(sent[1]).sort(), ['content', 'role']);
  } finally {
    await gateway.close();
  }
});

test('recuperação automática: gateway rejeita campo, cliente remove e repete', async () => {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push(body);

    if ('temperature' in body) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'unsupported_parameter',
            message: 'Unsupported request field: temperature. This gateway only forwards validated ChatGPT-plan-compatible fields.',
          },
        }),
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'resposta ok' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const client = createGatewayClient({
      config: loadConfig({
        KIRANA_GATEWAY_URL: `http://127.0.0.1:${port}`,
        KIRANA_GATEWAY_API_KEY: 'test-key',
        // simula alguém reativando o campo por engano
        KIRANA_SEND_TEMPERATURE: 'true',
      }),
      logger: silentLogger,
    });
    const result = await client.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna', temperature: 0.7 });

    assert.equal(received.length, 2, 'deve repetir exatamente uma vez');
    assert.equal('temperature' in received[0], true);
    assert.equal('temperature' in received[1], false);
    assert.deepEqual(result.strippedFields, ['temperature']);
    assert.equal(result.text, 'resposta ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('erro unsupported_parameter sem recuperação possível é reportado com o campo', async () => {
  const gateway = await startFakeGateway({
    script: () => ({
      status: 400,
      error: 'Unsupported request field: imaginary_field. This gateway only forwards validated ChatGPT-plan-compatible fields.',
    }),
  });
  const { startFakeGateway: _unused } = await import('./helpers.js');
  try {
    const client = createGatewayClient({ config: configFor(gateway.url), logger: silentLogger });
    // Força o campo a existir no payload ativando opt-ins irrelevantes: aqui o
    // gateway simulado rejeita com um campo que nunca enviamos, então não há
    // como remover — deve virar erro claro e não ficar em loop.
    await assert.rejects(
      () => client.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna' }),
      (error) => {
        assert.equal(error.status, 400);
        assert.ok(['unsupported_parameter', 'gateway_http'].includes(error.code));
        return true;
      },
    );
    assert.equal(gateway.calls, 1, 'não deve repetir quando o campo não está no payload');
  } finally {
    await gateway.close();
  }
});
