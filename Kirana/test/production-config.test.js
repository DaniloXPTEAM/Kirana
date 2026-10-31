/**
 * Travas de PRODUÇÃO — o que muda quando a Kirana deixa de ser localhost.
 *
 * Contexto (impedimentos reais encontrados antes de publicar):
 *   1. **CORS**: o site (https://opportunity.ia.br) e a Kirana
 *      (https://kirana.<algo>) são origens diferentes. O servidor respondia o
 *      preflight `OPTIONS` sem `Access-Control-Allow-Origin`, então o widget
 *      embutido no site nunca conseguiria conversar.
 *   2. **IP atrás de proxy**: `req.socket.remoteAddress` é sempre o proxy. Todos
 *      os visitantes cairiam no mesmo balde: o limite por IP viraria limite
 *      GLOBAL e o primeiro visitante derrubaria o site.
 *   3. **Rotas privadas**: `GET /api/sessions` devolve TODAS as conversas (os
 *      títulos são mensagens dos visitantes) e `GET /api/memory` a memória do
 *      assistente. Em localhost é conveniência; num backend público é vazamento.
 *
 * Estes testes cobrem os três, e garantem que `development` (padrão) continua
 * exatamente como antes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startFakeGateway, startKirana } from './helpers.js';
import { loadConfig, validateProductionConfig } from '../src/config.js';
import { corsFor, normalizeOrigin, allowedOrigins } from '../src/cors.js';

const SITE_PUBLICO = 'https://opportunity.ia.br';

/* --------------------------------- CORS ---------------------------------- */

test('preflight do site público recebe CORS (antes não recebia nada)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await fetch(`${kirana.base}/api/copilot`, {
      method: 'OPTIONS',
      headers: {
        origin: SITE_PUBLICO,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), SITE_PUBLICO);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'false', 'a Kirana não usa cookie de sessão');
    assert.match(response.headers.get('access-control-allow-headers') || '', /content-type/);
    assert.match(response.headers.get('access-control-allow-methods') || '', /POST/);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('origem desconhecida NÃO recebe CORS (lista fechada, nunca *)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await fetch(`${kirana.base}/api/copilot`, {
      method: 'OPTIONS',
      headers: { origin: 'https://site-invasor.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(response.status, 204, 'o preflight em si não falha');
    assert.equal(response.headers.get('access-control-allow-origin'), null, 'sem CORS o navegador bloqueia');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('post real do site público devolve CORS (a resposta é legível pelo JS)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await fetch(`${kirana.base}/api/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE_PUBLICO },
      body: JSON.stringify({ method: 'info' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), SITE_PUBLICO);
    assert.equal(response.headers.get('vary'), 'Origin');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('KIRANA_ALLOWED_ORIGINS autoriza outras origens sem tocar no site.json', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({
    gatewayUrl: gateway.url,
    env: { KIRANA_ALLOWED_ORIGINS: 'https://preview.seudominio.com,https://kirana.seudominio.com' },
  });
  try {
    for (const origin of ['https://preview.seudominio.com', 'https://kirana.seudominio.com']) {
      const response = await fetch(`${kirana.base}/api/copilot`, { method: 'OPTIONS', headers: { origin } });
      assert.equal(response.headers.get('access-control-allow-origin'), origin, origin);
    }
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('a mesma origem continua liberada (interface e testes não mudam)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const origin = kirana.base;
    const response = await fetch(`${kirana.base}/api/copilot`, { method: 'OPTIONS', headers: { origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('chat com origem autorizada passa; com origem estranha é 403', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'Olá!' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const session = await fetch(`${kirana.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((r) => r.json());

    const bloqueado = await fetch(`${kirana.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://site-invasor.example' },
      body: JSON.stringify({ sessionId: session.id, message: 'oi' }),
    });
    assert.equal(bloqueado.status, 403);
    await bloqueado.text();

    const permitido = await fetch(`${kirana.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE_PUBLICO, accept: 'text/event-stream' },
      body: JSON.stringify({ sessionId: session.id, message: 'oi' }),
    });
    assert.equal(permitido.status, 200, 'o site autorizado precisa poder conversar');
    await permitido.text();
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('normalização de origem ignora valor inválido e nome de host solto', () => {
  assert.equal(normalizeOrigin('https://Opportunity.IA.br/pagina'), 'https://opportunity.ia.br');
  assert.equal(normalizeOrigin('javascript:alert(1)'), '');
  assert.equal(normalizeOrigin(''), '');
  const set = allowedOrigins({ extra: ['opportunity.ia.br', 'https://ok.example'] });
  assert.ok(set.has('https://ok.example'));
  assert.equal(set.size, 1, 'host solto não entra na lista');
});

/* ------------------------- IP real atrás de proxy ------------------------- */

async function esgotarLimite(base, { origem, xff } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origem) headers.origin = origem;
  if (xff) headers['x-forwarded-for'] = xff;
  const codigos = [];
  for (let i = 0; i < 5; i += 1) {
    const response = await fetch(`${base}/api/copilot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method: 'info' }),
    });
    codigos.push(response.status);
    await response.text();
  }
  return codigos;
}

test('sem TRUST_PROXY, todos os visitantes compartilham o balde (limite vira global)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: { KIRANA_AGENT_RATE_MAX: '2' } });
  try {
    const primeiro = await esgotarLimite(kirana.base, { xff: '203.0.113.10' });
    const segundo = await esgotarLimite(kirana.base, { xff: '198.51.100.77' });
    assert.ok(primeiro.includes(429), `limite deveria estourar: ${primeiro.join(',')}`);
    assert.ok(segundo.includes(429), 'sem TRUST_PROXY o segundo visitante também é bloqueado (balde único)');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('com TRUST_PROXY, cada visitante tem o seu balde (proteção por IP de verdade)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({
    gatewayUrl: gateway.url,
    env: { KIRANA_AGENT_RATE_MAX: '2', KIRANA_TRUST_PROXY: 'true' },
  });
  try {
    const primeiro = await esgotarLimite(kirana.base, { xff: '203.0.113.10' });
    assert.deepEqual(primeiro.slice(0, 2), [200, 200], `as duas primeiras passam: ${primeiro.join(',')}`);
    assert.equal(primeiro[2], 429, 'a terceira estoura para o MESMO IP');

    const outro = await esgotarLimite(kirana.base, { xff: '198.51.100.77' });
    assert.equal(outro[0], 200, 'outro visitante não pode ser penalizado pelo primeiro');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

/* --------------------- rotas privadas em produção ------------------------ */

test('em produção, listar sessões e memória exige autenticação', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({
    gatewayUrl: gateway.url,
    env: { KIRANA_ENV: 'production', KIRANA_ACCESS_TOKEN: 'segredo-de-producao' },
  });
  try {
    const semToken = await fetch(`${kirana.base}/api/sessions`);
    assert.equal(semToken.status, 401, 'listar TODAS as conversas não pode ser público');
    await semToken.text();

    const memoria = await fetch(`${kirana.base}/api/memory`);
    assert.equal(memoria.status, 401);
    await memoria.text();

    const comToken = await fetch(`${kirana.base}/api/sessions`, {
      headers: { authorization: 'Bearer segredo-de-producao' },
    });
    assert.equal(comToken.status, 200);
    await comToken.text();
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('em produção, o caminho público do site continua aberto (sem token no navegador)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'Olá!' }) });
  const kirana = await startKirana({
    gatewayUrl: gateway.url,
    env: { KIRANA_ENV: 'production', KIRANA_ACCESS_TOKEN: 'segredo-de-producao', KIRANA_TRUST_PROXY: 'true', KIRANA_AGENT_RATE_MAX: '100' },
  });
  try {
    // O visitante não tem token: /api/copilot é protegido por origem + limite.
    const response = await fetch(`${kirana.base}/api/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE_PUBLICO, 'x-forwarded-for': '203.0.113.10' },
      body: JSON.stringify({ method: 'info' }),
    });
    assert.equal(response.status, 200, 'o widget do site precisa funcionar sem credencial');
    assert.equal(response.headers.get('access-control-allow-origin'), SITE_PUBLICO);
    const text = await response.text();
    assert.doesNotMatch(text, /segredo-de-producao/);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('em desenvolvimento nada muda (compatibilidade com todas as suítes)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const sessions = await fetch(`${kirana.base}/api/sessions`);
    assert.equal(sessions.status, 200, 'dev continua sem token');
    await sessions.text();
    const memoria = await fetch(`${kirana.base}/api/memory`);
    assert.equal(memoria.status, 200);
    await memoria.text();
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

/* --------------------- validação da configuração -------------------------- */

test('validateProductionConfig só age em produção', () => {
  const dev = loadConfig({ KIRANA_DATA_DIR: '/tmp/kirana-cfg-dev' });
  assert.deepEqual(validateProductionConfig(dev), { fatal: [], avisos: [] });

  const prod = loadConfig({ KIRANA_ENV: 'production', KIRANA_DATA_DIR: '/tmp/kirana-cfg-prod' });
  const { fatal, avisos } = validateProductionConfig(prod);
  assert.equal(fatal.length, 1, 'sem token é fatal');
  assert.match(fatal[0], /KIRANA_ACCESS_TOKEN/);
  assert.ok(avisos.some((a) => /TRUST_PROXY/.test(a)));
  assert.ok(avisos.some((a) => /AGENT_RATE_MAX/.test(a)));
});

test('produção sem token não sobe (falha no start, não em produção)', async () => {
  const { createKiranaServer } = await import('../src/server.js');
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const anterior = { ...process.env };
  try {
    process.env.KIRANA_ENV = 'production';
    process.env.KIRANA_ACCESS_TOKEN = '';
    process.env.KIRANA_DATA_DIR = '/tmp/kirana-prod-sem-token';
    process.env.KIRANA_GATEWAY_URL = gateway.url;
    process.env.KIRANA_GATEWAY_API_KEY = 'test-key';
    process.env.KIRANA_LOG_LEVEL = 'error';
    assert.throws(() => createKiranaServer(), /Configuração de produção inválida/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in anterior)) delete process.env[key];
    Object.assign(process.env, anterior);
    await gateway.close();
  }
});

test('a configuração pública enviada ao navegador não contém segredo', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }), apiKey: 'chave-do-gateway-secreta' });
  const kirana = await startKirana({
    gatewayUrl: gateway.url,
    env: { KIRANA_ACCESS_TOKEN: 'token-privado', KIRANA_ENV: 'production' },
  });
  try {
    const response = await fetch(`${kirana.base}/api/config`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /chave-do-gateway-secreta/);
    assert.doesNotMatch(text, /token-privado/);
    const body = JSON.parse(text);
    // O navegador só precisa saber que existe token, nunca qual é.
    assert.equal(body.requiresAccessToken, true);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});
