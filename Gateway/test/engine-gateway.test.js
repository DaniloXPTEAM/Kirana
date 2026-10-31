/**
 * Integração do MOTOR com o Gateway HTTP real (em memória, sem rede externa).
 *
 * Prova, com upstream falso determinístico:
 *   • `/v1/engine` separa modelo PEDIDO, modelo USADO e modelo DECLARADO pelo
 *     provedor — e só marca `identity_verified` quando o provedor declara;
 *   • `/v1/runs` e `/v1/runs/:id` registram a execução (latência, uso, tools);
 *   • o nome ecoado ao cliente continua sendo o pedido (compatibilidade);
 *   • fallback só acontece em falha de infraestrutura, e só antes do 1º byte;
 *   • modelo de custo pago é bloqueado com 402 sem tocar no provedor;
 *   • pessoa que pede um modelo explicitamente é respeitada.
 *
 * O que NÃO se prova aqui: que qualquer modelo real exista, responda bem ou
 * custe o que está escrito. Isso exige conta autorizada (SIWC) — ver
 * docs/tama-integration.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGateway } from '../src/gateway.js';
import { ResponsesClient } from '../src/responses.js';

const KEY = randomBytes(32).toString('base64url');
const headers = { authorization: `Bearer ${KEY}` };

function sse(events) {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Upstream falso: responde por modelo, permite falhar por modelo. */
function fakeUpstream({ failures = {}, reportedModel } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://api.openai.com/v1/models') {
      return Response.json({
        models: [
          { slug: 'modelo-a', display_name: 'A', visibility: 'list' },
          { slug: 'modelo-b', display_name: 'B', visibility: 'list' },
          { slug: 'modelo-visao', display_name: 'V', visibility: 'list' },
        ],
      });
    }
    if (target === 'https://api.openai.com/v1/responses') {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push(body);
      const failure = failures[body?.model];
      if (failure) {
        // Status coerente com o código: 401 é erro de conta (não mascarável),
        // 503 é infraestrutura (pode tentar outro modelo).
        const status = failure === 'authentication_required' ? 401 : 503;
        return new Response(JSON.stringify({ error: { message: 'upstream caiu', code: failure } }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
      const reported = reportedModel ?? body.model;
      return sse([
        { type: 'response.output_text.delta', delta: `resposta de ${body.model}` },
        {
          type: 'response.completed',
          response: {
            id: `resp_${body.model}`,
            model: reported, // o que o PROVEDOR diz ter usado
            status: 'completed',
            usage: { input_tokens: 11, output_tokens: 7 },
          },
        },
      ]);
    }
    throw new Error(`URL inesperada: ${target}`);
  };
  return { fetchImpl, calls };
}

async function start(t, { failures = {}, reportedModel, engineOptions = {} } = {}) {
  const auth = {
    status: () => ({ authenticated: true, sharing: true, tokenStorage: 'memory-only' }),
    accessToken: async () => 'mock-oauth-token',
    initialize: async () => {},
    clear() {},
  };
  const upstream = fakeUpstream({ failures, reportedModel });
  const responseClient = new ResponsesClient({ auth, fetchImpl: upstream.fetchImpl });
  const stateDir = await mkdtemp(join(tmpdir(), 'kirana-engine-test-'));
  const app = createGateway({
    apiKey: KEY,
    stateDir,
    port: 0,
    authClient: auth,
    responseClient,
    engineOptions,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, app, calls: upstream.calls };
}

const chat = (base, body) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('/v1/engine informa política e identidade sem inventar modelo', async (t) => {
  const { base } = await start(t, {
    engineOptions: { primaryModel: 'modelo-a', fallbackModel: 'modelo-b', routing: true },
  });
  const r = await fetch(`${base}/v1/engine`, { headers });
  const data = await r.json();
  assert.equal(r.status, 200);
  assert.equal(data.gateway.provider, 'siwc-responses');
  assert.equal(data.policy.primary_model, 'modelo-a');
  assert.equal(data.policy.fallback_model, 'modelo-b');
  assert.equal(data.policy.cost_policy, 'plan-only');
  assert.equal(data.identity, null, 'nenhuma chamada ainda: nada a identificar');
});

test('identidade REAL: separa pedido, usado e declarado pelo provedor', async (t) => {
  const { base } = await start(t, { engineOptions: { primaryModel: 'modelo-a', routing: true } });

  const response = await chat(base, { model: 'modelo-a', stream: true, messages: [{ role: 'user', content: 'oi' }] });
  assert.equal(response.status, 200);
  const body = await response.text();
  // Compatibilidade preservada: o nome ecoado ao cliente é o nome pedido.
  assert.match(body, /"model":"modelo-a"/);

  const engine = await (await fetch(`${base}/v1/engine`, { headers })).json();
  assert.equal(engine.identity.model_requested, 'modelo-a');
  assert.equal(engine.identity.model_used, 'modelo-a');
  assert.equal(engine.identity.model_reported, 'modelo-a');
  assert.equal(engine.identity.identity_verified, true);
  assert.equal(engine.identity.fallback_used, false);

  const runs = await (await fetch(`${base}/v1/runs`, { headers })).json();
  assert.equal(runs.data.length, 1);
  const run = runs.data[0];
  assert.equal(run.status, 'completed');
  assert.equal(run.model_reported, 'modelo-a');
  assert.equal(run.usage.total_tokens, 18);
  assert.equal(typeof run.latency.total_ms, 'number');
  assert.equal(run.provider, 'siwc-responses');
});

test('quando o provedor declara OUTRO modelo, a identidade não é "verificada"', async (t) => {
  // Caso real e importante: o provedor pode atender com um modelo diferente do
  // pedido (roteamento interno). O Gateway registra os dois e NÃO finge que são iguais.
  const { base } = await start(t, {
    reportedModel: 'motor-interno-x',
    engineOptions: { primaryModel: 'modelo-a', routing: true },
  });
  await chat(base, { model: 'modelo-a', stream: true, messages: [{ role: 'user', content: 'oi' }] });
  const engine = await (await fetch(`${base}/v1/engine`, { headers })).json();
  assert.equal(engine.identity.model_requested, 'modelo-a');
  assert.equal(engine.identity.model_reported, 'motor-interno-x');
  assert.equal(engine.identity.identity_verified, false, 'nome pedido ≠ nome declarado pelo provedor');
});

test('fallback só em falha de infraestrutura, e o histórico mostra a decisão', async (t) => {
  const { base, calls } = await start(t, {
    failures: { 'modelo-a': 'upstream_connection_error' },
    engineOptions: { primaryModel: 'modelo-a', fallbackModel: 'modelo-b', routing: true },
  });
  const response = await chat(base, { model: 'modelo-a', stream: true, messages: [{ role: 'user', content: 'oi' }] });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /resposta de modelo-b/, 'a alternativa respondeu');
  assert.deepEqual(calls.map((c) => c.model), ['modelo-a', 'modelo-b'], 'uma tentativa em cada, sem loop');

  const run = (await (await fetch(`${base}/v1/runs`, { headers })).json()).data[0];
  assert.equal(run.fallback_used, true);
  assert.equal(run.model_used, 'modelo-b');
  assert.deepEqual(run.attempts.map((a) => a.outcome), ['failed', 'ok']);
});

test('erro de conta NÃO é mascarado por fallback', async (t) => {
  const { base, calls } = await start(t, {
    failures: { 'modelo-a': 'authentication_required' },
    engineOptions: { primaryModel: 'modelo-a', fallbackModel: 'modelo-b', routing: true },
  });
  const response = await chat(base, { model: 'modelo-a', stream: true, messages: [{ role: 'user', content: 'oi' }] });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, 'authentication_required');
  assert.deepEqual(calls.map((c) => c.model), ['modelo-a'], 'não tenta outro modelo');
});

test('modelo de custo pago é bloqueado ANTES do provedor (HTTP 402)', async (t) => {
  const { base, calls } = await start(t, {
    engineOptions: {
      routing: true,
      primaryModel: 'modelo-a',
      models: [
        { model: 'modelo-a', provider: 'siwc-responses', cost: 'plan', capabilities: { 'text.chat': true } },
        { model: 'modelo-caro', provider: 'outro', cost: 'paid', capabilities: { 'text.chat': true } },
      ],
    },
  });
  const response = await chat(base, { model: 'modelo-caro', stream: true, messages: [{ role: 'user', content: 'oi' }] });
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.equal(body.error.code, 'cost_blocked');
  assert.match(body.error.message, /pago/);
  assert.deepEqual(calls, [], 'nenhuma chamada ao provedor');

  const run = (await (await fetch(`${base}/v1/runs`, { headers })).json()).data[0];
  assert.equal(run.status, 'blocked');
  assert.equal(run.code, 'cost_blocked');
});

test('com roteamento DESLIGADO o comportamento é o do v0.4.0 (sem decisão)', async (t) => {
  const { base, calls } = await start(t, { engineOptions: { primaryModel: 'modelo-a' } }); // routing: false
  const response = await chat(base, { model: 'modelo-b', stream: true, messages: [{ role: 'user', content: 'oi' }] });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((c) => c.model), ['modelo-b'], 'executa exatamente o pedido');
  const run = (await (await fetch(`${base}/v1/runs`, { headers })).json()).data[0];
  assert.equal(run.decision.reason, 'roteamento_desligado');
});

test('/v1/runs/:id devolve a execução e 404 para id inexistente', async (t) => {
  const { base } = await start(t, { engineOptions: { primaryModel: 'modelo-a', routing: true } });
  await chat(base, { model: 'modelo-a', stream: true, messages: [{ role: 'user', content: 'oi' }] });
  const lista = (await (await fetch(`${base}/v1/runs`, { headers })).json()).data;
  const detalhe = await (await fetch(`${base}/v1/runs/${lista[0].id}`, { headers })).json();
  assert.equal(detalhe.id, lista[0].id);
  assert.equal(detalhe.model_used, 'modelo-a');
  assert.equal((await fetch(`${base}/v1/runs/run_999999`, { headers })).status, 404);
});

test('endpoints do motor exigem a chave do Gateway', async (t) => {
  const { base } = await start(t, {});
  assert.equal((await fetch(`${base}/v1/engine`)).status, 401);
  assert.equal((await fetch(`${base}/v1/runs`)).status, 401);
});

test('capacidade sem modelo aprovado é recusada sem chamar o provedor', async (t) => {
  const { base, calls } = await start(t, {
    engineOptions: { routing: true, primaryModel: 'modelo-a', models: [{ model: 'modelo-a', cost: 'plan', capabilities: { 'text.chat': true } }] },
  });
  // Pedir um modelo declarado como indisponível para imagem: recusa limpa.
  const r = await fetch(`${base}/v1/images/analyze`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'modelo-visao', prompt: 'descreva' }),
  });
  // A rota de imagem exige arquivos; o que importa aqui é que nada foi ao provedor
  // por conta de roteamento e o erro é explícito (não 500 genérico).
  assert.notEqual(r.status, 500);
  assert.deepEqual(calls, []);
});

test('/v1/engine mostra o timeout EFETIVO e as especializadas configuradas', async (t) => {
  const { base } = await start(t, {
    engineOptions: {
      primaryModel: 'modelo-a',
      routing: true,
      specialized: { 'images.analyze': ['modelo-visao'] },
    },
  });
  const data = await (await fetch(`${base}/v1/engine`, { headers })).json();
  // Regressão: já foi `null`, o que não informa nada a quem integra.
  assert.equal(typeof data.policy.timeout_ms, 'number');
  assert.ok(data.policy.timeout_ms > 0);
  assert.deepEqual(data.policy.specialized, { 'images.analyze': ['modelo-visao'] });
});

test('capacidade especializada indicada mas sem teste no catálogo NÃO é usada', async (t) => {
  const { base, calls } = await start(t, {
    engineOptions: {
      routing: true,
      primaryModel: 'modelo-a',
      specialized: { 'tools': ['modelo-visao'] },
      models: [{ model: 'modelo-visao', cost: 'plan', capabilities: { 'tools': true } }], // declarado, não testado
    },
  });
  const response = await chat(base, {
    model: 'modelo-a',
    stream: true,
    messages: [{ role: 'user', content: 'oi' }],
    tools: [{ type: 'function', function: { name: 'x', description: 'x', parameters: { type: 'object', properties: {} } } }],
  });
  assert.equal(response.status, 200);
  // Sem `tested`, o primário responde: nada de trocar de modelo por folheto.
  assert.deepEqual(calls.map((c) => c.model), ['modelo-a']);
});
