/**
 * TamaAgent × OmniRoute (provedor de formato OpenAI, SEM o Gateway antigo).
 *
 * Prova, com HTTP real em loopback e um provedor falso que se comporta como o
 * OmniRoute (sem `/health`, sem `/v1/engine`, com `/v1/models` e
 * `/v1/chat/completions` em streaming):
 *   - o celular fala com a ponte do TamaAgent (`/api/gateway/*`) e a ponte repassa
 *     ao provedor com a chave do provedor, que nunca chega ao celular;
 *   - `/health` responde "ok" pelo catálogo quando o provedor não tem `/health`;
 *   - se o catálogo falha, `/health` diz "down", e não "ok";
 *   - o streaming atravessa a ponte;
 *   - `OMNIROUTE_URL` com ou sem `/v1` e os apelidos `TAMAAGENT_*` funcionam.
 *
 * NÃO prova: que o OmniRoute REAL do PC responda, qual modelo ele usa, nem que
 * a chave do proprietário seja válida. Isso só se vê no PC dele.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { loadConfig, normalizeUpstreamUrl, withEnvAliases } from '../src/config.js';
import { startTamaAgent, getJson, postSse } from './helpers.js';

const CHAVE_PROVEDOR = 'sk-chave-FALSA-so-para-teste';
const TOKEN = 'ponte-de-teste-com-32-caracteres-ou-mais';
const auth = { Authorization: `Bearer ${TOKEN}` };

/** Provedor falso estilo OmniRoute: só /v1/models e /v1/chat/completions. */
async function startOmniRouteFalso({ catalogoOk = true } = {}) {
  const vistos = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    vistos.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '' });
    if ((req.headers.authorization || '') !== `Bearer ${CHAVE_PROVEDOR}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid api key', code: 'invalid_api_key' } }));
    }
    if (url.pathname === '/v1/models') {
      if (!catalogoOk) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'sem provedores' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'auto', object: 'model' }] }));
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const partes = [];
      for await (const p of req) partes.push(p);
      JSON.parse(Buffer.concat(partes).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const palavra of ['Olá', ' do', ' OmniRoute']) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: palavra } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    vistos,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const ENV_PONTE = { KIRANA_BRIDGE: 'on', KIRANA_BRIDGE_TOKEN: TOKEN, KIRANA_GATEWAY_API_KEY: CHAVE_PROVEDOR };

test('padrão do TamaAgent: provedor em 127.0.0.1:20128 (OmniRoute)', () => {
  const config = loadConfig({ KIRANA_LOG_LEVEL: 'error' });
  assert.equal(config.appName, 'TamaAgent');
  assert.equal(config.gateway.url, 'http://127.0.0.1:20128');
});

test('OMNIROUTE_URL e OMNIROUTE_API_KEY valem; /v1 final é removido; chave nunca no config público', () => {
  const config = loadConfig({ OMNIROUTE_URL: 'http://127.0.0.1:20128/v1/', OMNIROUTE_API_KEY: CHAVE_PROVEDOR });
  assert.equal(config.gateway.url, 'http://127.0.0.1:20128');
  assert.equal(config.gateway.apiKey, CHAVE_PROVEDOR);
  assert.equal(normalizeUpstreamUrl('http://localhost:20128/v1', 'x'), 'http://localhost:20128');
  assert.equal(normalizeUpstreamUrl('', 'http://a:1'), 'http://a:1');
});

test('apelidos TAMAAGENT_* valem como KIRANA_* e não alteram o ambiente de quem chamou', () => {
  const original = { TAMAAGENT_PORT: '3999', KIRANA_HOST: '127.0.0.1' };
  const copia = withEnvAliases(original);
  assert.equal(copia.KIRANA_PORT, '3999');
  assert.equal(original.KIRANA_PORT, undefined);
  assert.equal(loadConfig({ TAMAAGENT_PORT: '3999' }).port, 3999);
  // KIRANA_* explícito vence o apelido
  assert.equal(loadConfig({ TAMAAGENT_PORT: '3999', KIRANA_PORT: '3111' }).port, 3111);
});

test('ponte: /health sem /health no provedor usa o catálogo e diz ok; chave do provedor não vaza', async () => {
  const provedor = await startOmniRouteFalso();
  const agente = await startTamaAgent({ gatewayUrl: provedor.url, env: ENV_PONTE });
  try {
    const { status, body } = await getJson(agente.base, '/api/gateway/health', auth);
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.via, '/v1/models');
    assert.ok(!JSON.stringify(body).includes(CHAVE_PROVEDOR));
    // o provedor recebeu a chave do provedor, não o token da ponte
    const recebidos = provedor.vistos.map((v) => v.auth);
    assert.ok(recebidos.every((a) => a === `Bearer ${CHAVE_PROVEDOR}`));
  } finally {
    await agente.close();
    await provedor.close();
  }
});

test('ponte: se o catálogo do provedor falha, /health diz down (502), não ok', async () => {
  const provedor = await startOmniRouteFalso({ catalogoOk: false });
  const agente = await startTamaAgent({ gatewayUrl: provedor.url, env: ENV_PONTE });
  try {
    const { status, body } = await getJson(agente.base, '/api/gateway/health', auth);
    assert.equal(status, 502);
    assert.equal(body.status, 'down');
  } finally {
    await agente.close();
    await provedor.close();
  }
});

test('ponte: /v1/models e o streaming de /v1/chat/completions atravessam até o provedor', async () => {
  const provedor = await startOmniRouteFalso();
  const agente = await startTamaAgent({ gatewayUrl: provedor.url, env: ENV_PONTE });
  try {
    const modelos = await getJson(agente.base, '/api/gateway/v1/models', auth);
    assert.equal(modelos.status, 200);
    assert.equal(modelos.body.data[0].id, 'auto');

    const resposta = await postSse(
      agente.base,
      '/api/gateway/v1/chat/completions',
      { model: 'auto', stream: true, messages: [{ role: 'user', content: 'oi' }] },
      { headers: auth },
    );
    assert.equal(resposta.ok, true);
    const texto = resposta.events.map((e) => e?.choices?.[0]?.delta?.content || '').join('');
    assert.equal(texto, 'Olá do OmniRoute');
  } finally {
    await agente.close();
    await provedor.close();
  }
});

test('ponte: token errado é recusado antes de chegar ao provedor', async () => {
  const provedor = await startOmniRouteFalso();
  const agente = await startTamaAgent({ gatewayUrl: provedor.url, env: ENV_PONTE });
  try {
    const { status } = await getJson(agente.base, '/api/gateway/v1/models', { Authorization: 'Bearer errado-errado-errado-errado-errado' });
    assert.equal(status, 401);
    assert.equal(provedor.vistos.length, 0);
  } finally {
    await agente.close();
    await provedor.close();
  }
});
