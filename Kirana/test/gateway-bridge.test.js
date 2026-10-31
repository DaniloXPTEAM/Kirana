/**
 * Ponte `/api/gateway/*` — celular → Kirana (3000) → Gateway (1455, loopback).
 *
 * O que estes testes provam, com HTTP real em loopback e gateway falso:
 *   • a ponte nasce desligada e, ligada, exige token próprio;
 *   • a chave do Gateway nunca chega ao cliente;
 *   • só a lista fechada de rotas é exposta (não é proxy genérico);
 *   • streaming atravessa a ponte sem buffer;
 *   • Gateway fora do ar vira erro claro, não resposta inventada;
 *   • configuração perigosa (ponte na rede sem autenticação) falha no start.
 *
 * O que NÃO provam: que o Gateway real responda, ou que o celular na sua
 * rede vá alcançar o PC (firewall/roteador continuam sendo ambiente).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { loadConfig, validateBridgeConfig } from '../src/config.js';
import { createGatewayBridge } from '../src/gateway-bridge.js';
import { startFakeGateway, startKirana, postSse, getJson, silentLogger } from './helpers.js';
import { createKiranaServer } from '../src/server.js';

/** Extrai texto de chunks SSE no formato OpenAI (a ponte repassa o formato do Gateway). */
function textoDoGateway(events) {
  return events
    .map((evento) => evento?.choices?.[0]?.delta?.content || '')
    .join('');
}

const TOKEN = 'ponte-de-teste-com-32-caracteres-ou-mais';
const BRIDGE_ENV = { KIRANA_BRIDGE: 'on', KIRANA_BRIDGE_TOKEN: TOKEN };
const auth = { Authorization: `Bearer ${TOKEN}` };

test('ponte desligada não existe: 404 bridge_disabled', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { status, body } = await getJson(kirana.base, '/api/gateway/health', auth);
    assert.equal(status, 404);
    assert.equal(body.error.code, 'bridge_disabled');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('ponte ligada sem token recusa tudo (fail-closed), mesmo com token inventado', async () => {
  // Config construído à mão: o start normal recusaria esta combinação.
  const config = loadConfig({ KIRANA_LOG_LEVEL: 'error', KIRANA_BRIDGE: 'on', KIRANA_BRIDGE_TOKEN: '' });
  const bridge = createGatewayBridge({ config, logger: silentLogger });
  const server = http.createServer((req, res) => bridge.handle(req, res, new URL(req.url, 'http://localhost'), req.method));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { status, body } = await getJson(base, '/api/gateway/health', { Authorization: 'Bearer qualquer-coisa' });
    assert.equal(status, 403);
    assert.equal(body.error.code, 'bridge_not_configured');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('token da ponte ausente ou errado: 401 sem tocar no Gateway', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'não deveria ser chamado' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: BRIDGE_ENV });
  try {
    const semToken = await getJson(kirana.base, '/api/gateway/health');
    assert.equal(semToken.status, 401);
    assert.equal(semToken.body.error.code, 'bridge_unauthorized');

    const errado = await getJson(kirana.base, '/api/gateway/health', { Authorization: 'Bearer token-errado' });
    assert.equal(errado.status, 401);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('com token, /api/gateway/health e /v1/models funcionam — sem vazar a chave', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: BRIDGE_ENV });
  try {
    const saude = await getJson(kirana.base, '/api/gateway/health', auth);
    assert.equal(saude.status, 200);
    assert.equal(saude.body.status, 'ok');

    const modelos = await getJson(kirana.base, '/api/gateway/v1/models', auth);
    assert.equal(modelos.status, 200);
    assert.deepEqual(modelos.body.data.map((m) => m.id), ['gpt-6-luna', 'gpt-6.1-sol']);
    // A chave do Gateway autentica a ponte com o Gateway e nunca sai daqui.
    assert.equal(JSON.stringify(modelos.body).includes('test-key'), false);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('streaming atravessa a ponte sem buffer', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'Olá pelo celular!' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: BRIDGE_ENV });
  try {
    const resposta = await postSse(
      kirana.base,
      '/api/gateway/v1/chat/completions',
      { model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'Oi' }] },
      { headers: auth },
    );
    assert.equal(resposta.ok, true);
    assert.equal(textoDoGateway(resposta.events), 'Olá pelo celular!');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('a ponte NÃO é proxy genérico: rota fora da lista dá 404 e não chama o Gateway', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: BRIDGE_ENV });
  try {
    for (const caminho of ['/api/gateway/v1/files', '/api/gateway/auth/start', '/api/gateway/v1/images/analyze']) {
      const { status, body } = await getJson(kirana.base, caminho, auth);
      assert.equal(status, 404, caminho);
      assert.equal(body.error.code, 'bridge_route_not_exposed', caminho);
    }
    assert.equal(gateway.requests.length, 0);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('Gateway fora do ar vira 502 gateway_unreachable (nada inventado)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const urlMorta = gateway.url;
  await gateway.close();
  const kirana = await startKirana({ gatewayUrl: urlMorta, env: BRIDGE_ENV });
  try {
    const { status, body } = await getJson(kirana.base, '/api/gateway/v1/models', auth);
    assert.equal(status, 502);
    assert.equal(body.error.code, 'gateway_unreachable');
  } finally {
    await kirana.close();
  }
});

test('limite de requisições da ponte: 429 depois do teto', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: { ...BRIDGE_ENV, KIRANA_BRIDGE_RATE_MAX: '2' } });
  try {
    assert.equal((await getJson(kirana.base, '/api/gateway/health', auth)).status, 200);
    assert.equal((await getJson(kirana.base, '/api/gateway/health', auth)).status, 200);
    const terceira = await getJson(kirana.base, '/api/gateway/health', auth);
    assert.equal(terceira.status, 429);
    assert.equal(terceira.body.error.code, 'bridge_rate_limited');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('ping da ponte informa rotas expostas sem revelar segredos', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: BRIDGE_ENV });
  try {
    const { status, body } = await getJson(kirana.base, '/api/gateway/ping', auth);
    assert.equal(status, 200);
    assert.equal(body.bridge, 'on');
    assert.equal(body.enabled, true);
    assert.ok(body.routes.includes('POST /v1/chat/completions'));
    const texto = JSON.stringify(body);
    assert.equal(texto.includes(TOKEN), false);
    assert.equal(texto.includes('test-key'), false);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('configuração perigosa falha no start: ponte sem token', () => {
  const config = loadConfig({ KIRANA_BRIDGE: 'on', KIRANA_BRIDGE_TOKEN: 'curto' });
  const { fatal } = validateBridgeConfig(config);
  assert.equal(fatal.length, 1);
  assert.match(fatal[0], /KIRANA_BRIDGE_TOKEN/);
  assert.throws(() => createKiranaCom(config), /ponte do Gateway inválida/i);
});

test('configuração perigosa falha no start: ponte na rede sem autenticação da Kirana', () => {
  const config = loadConfig({
    KIRANA_BRIDGE: 'on',
    KIRANA_BRIDGE_TOKEN: TOKEN,
    KIRANA_HOST: '0.0.0.0',
    KIRANA_ACCESS_TOKEN: '',
  });
  const { fatal } = validateBridgeConfig(config);
  assert.equal(fatal.length, 1);
  assert.match(fatal[0], /KIRANA_ACCESS_TOKEN/);
});

test('ponte ligada com host na rede e token da Kirana: só aviso, sem fatal', () => {
  const config = loadConfig({
    KIRANA_BRIDGE: 'on',
    KIRANA_BRIDGE_TOKEN: TOKEN,
    KIRANA_HOST: '0.0.0.0',
    KIRANA_ACCESS_TOKEN: 'token-da-kirana-com-32-caracteres!!',
  });
  const { fatal, avisos } = validateBridgeConfig(config);
  assert.equal(fatal.length, 0);
  // Continua valendo com host na rede + token: nenhum aviso é sobre loopback.
  assert.equal(avisos.some((a) => /KIRANA_HOST/.test(a)), false);
});

/** Exercita a validação dentro do servidor real, sem escutar (falha na criação). */
function createKiranaCom(config) {
  return createKiranaServer({ config, logger: silentLogger });
}

/* ------------------------- Acesso remoto (Tailscale) ---------------------- */
/*
 * O `tailscale serve` entrega em loopback e injeta X-Forwarded-Proto,
 * X-Forwarded-For e Tailscale-User-Login. Estes testes reproduzem ESSES
 * CABEÇALHOS em loopback. Não são o Tailscale: tailnet, DNS .ts.net, certificado
 * e o aparelho real continuam fora do que se pode provar aqui.
 */
const REMOTO_ENV = {
  ...BRIDGE_ENV,
  KIRANA_BRIDGE_REQUIRE_HTTPS: 'on',
  KIRANA_BRIDGE_TRUST_PROXY: 'on',
  // Atrás de proxy a Kirana fica alcançável do tailnet: o token da API é
  // obrigatório para /api/sessions e /api/memory não ficarem abertas.
  KIRANA_ACCESS_TOKEN: 'token-da-kirana-no-tailnet-32-caracteres',
};
const comoServe = (extra = {}) => ({
  Authorization: `Bearer ${TOKEN}`,
  'X-Forwarded-Proto': 'https',
  'X-Forwarded-For': '100.64.0.10',
  'Tailscale-User-Login': 'dono@exemplo.ts.net',
  ...extra,
});

test('modo remoto: pedido sem HTTPS é recusado com código claro', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: REMOTO_ENV });
  try {
    // Token certo, mas chegou em HTTP claro: recusa antes de qualquer repasse.
    const claro = await getJson(kirana.base, '/api/gateway/v1/models', { Authorization: `Bearer ${TOKEN}` });
    assert.equal(claro.status, 403);
    assert.equal(claro.body.error.code, 'bridge_https_required');
    assert.equal(gateway.requests.length, 0, 'nada foi repassado ao Gateway');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('modo remoto: com cabeçalhos do Serve, funciona e o ping confirma o caminho', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: REMOTO_ENV });
  try {
    const ping = await getJson(kirana.base, '/api/gateway/ping', comoServe());
    assert.equal(ping.status, 200);
    assert.equal(ping.body.request.https, true);
    assert.equal(ping.body.request.viaTailscale, true);
    assert.equal(ping.body.requireHttps, true);

    const modelos = await getJson(kirana.base, '/api/gateway/v1/models', comoServe());
    assert.equal(modelos.status, 200);
    assert.equal(modelos.body.data.length, 2);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('modo remoto: o token da ponte continua obrigatório (tailnet não substitui token)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: REMOTO_ENV });
  try {
    // Estar no tailnet não autoriza nada por si só.
    const semToken = await getJson(kirana.base, '/api/gateway/v1/models', {
      'X-Forwarded-Proto': 'https',
      'Tailscale-User-Login': 'dono@exemplo.ts.net',
    });
    assert.equal(semToken.status, 401);
    assert.equal(semToken.body.error.code, 'bridge_unauthorized');
    assert.equal(gateway.requests.length, 0);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('modo remoto: limite por identidade do tailnet, não um balde único de 127.0.0.1', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: { ...REMOTO_ENV, KIRANA_BRIDGE_RATE_MAX: '2' } });
  try {
    const aparelhoA = comoServe({ 'Tailscale-User-Login': 'celular@exemplo.ts.net' });
    const aparelhoB = comoServe({ 'Tailscale-User-Login': 'notebook@exemplo.ts.net' });

    assert.equal((await getJson(kirana.base, '/api/gateway/ping', aparelhoA)).status, 200);
    assert.equal((await getJson(kirana.base, '/api/gateway/ping', aparelhoA)).status, 200);
    assert.equal((await getJson(kirana.base, '/api/gateway/ping', aparelhoA)).status, 429, 'aparelho A estourou');

    // B tem o próprio balde: não é penalizado pelo laço do A.
    assert.equal((await getJson(kirana.base, '/api/gateway/ping', aparelhoB)).status, 200);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('modo remoto: cabeçalho do cliente não é repassado ao Gateway (sem spoofing)', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: REMOTO_ENV });
  try {
    await postSse(
      kirana.base,
      '/api/gateway/v1/chat/completions',
      { model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'Oi' }] },
      { headers: comoServe({ 'Tailscale-User-Login': 'invasor@exemplo.ts.net', 'X-Forwarded-For': '10.9.9.9' }) },
    );
    // O que importa: o corpo chegou ao Gateway íntegro e nenhum cabeçalho de
    // identidade do cliente foi usado para autenticar no Gateway (a chave é só
    // da ponte, injetada no backend).
    assert.equal(gateway.requests.length, 1);
    assert.equal(gateway.requests[0].model, 'gpt-6-luna');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('configuração: HTTPS obrigatório sem confiar no proxy falha no start', () => {
  const config = loadConfig({
    KIRANA_BRIDGE: 'on',
    KIRANA_BRIDGE_TOKEN: TOKEN,
    KIRANA_BRIDGE_REQUIRE_HTTPS: 'on',
    KIRANA_BRIDGE_TRUST_PROXY: 'off',
  });
  const { fatal } = validateBridgeConfig(config);
  assert.equal(fatal.length, 1);
  assert.match(fatal[0], /KIRANA_BRIDGE_TRUST_PROXY/);
});

test('configuração: trustProxy (atrás do Serve) sem KIRANA_ACCESS_TOKEN falha no start', () => {
  const config = loadConfig({
    KIRANA_BRIDGE: 'on',
    KIRANA_BRIDGE_TOKEN: TOKEN,
    KIRANA_BRIDGE_REQUIRE_HTTPS: 'on',
    KIRANA_BRIDGE_TRUST_PROXY: 'on',
    KIRANA_ACCESS_TOKEN: '',
  });
  const { fatal } = validateBridgeConfig(config);
  assert.equal(fatal.length, 1);
  assert.match(fatal[0], /KIRANA_ACCESS_TOKEN/);
  assert.throws(() => createKiranaCom(config), /ponte do Gateway inválida/i);
});
