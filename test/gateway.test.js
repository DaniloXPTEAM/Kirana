import test from 'node:test';
import assert from 'node:assert/strict';

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
