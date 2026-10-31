/**
 * Motor do Gateway — identidade real, catálogo por capacidade e política de
 * execução (roteamento, timeout, circuit breaker, retry limitado, fallback sem
 * loop, bloqueio de custo pago e histórico de execução).
 *
 * Estes testes são DETERMINÍSTICOS: usam funções falsas no lugar do provedor.
 * Eles provam a POLÍTICA do Gateway, não a qualidade de nenhum modelo real.
 * Prova de modelo real exige a autorização SIWC do dono da conta — ver
 * docs/tama-integration.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COST,
  CapabilityCatalog,
  CircuitBreaker,
  RunLog,
  executeChain,
  isFallbackEligible,
  selectChain,
} from '../src/engine.js';

/* ------------------------------ catálogo --------------------------------- */

test('catálogo separa declared, tested, unavailable e unknown', () => {
  const catalog = new CapabilityCatalog();
  catalog.declare('modelo-a', { provider: 'siwc-responses', cost: COST.PLAN, capabilities: { 'text.chat': true, reasoning: true, 'images.analyze': true } });
  catalog.declare('modelo-b', { provider: 'siwc-responses', cost: COST.PLAN, capabilities: { 'text.chat': true, 'images.analyze': true } });

  // Declarado ≠ testado.
  assert.equal(catalog.statusFor('modelo-a', 'reasoning'), 'declared');
  assert.equal(catalog.statusFor('modelo-a', 'coding'), 'unknown');

  catalog.recordTest('modelo-a', 'reasoning', { ok: true, detail: 'bench local' });
  assert.equal(catalog.statusFor('modelo-a', 'reasoning'), 'tested');

  // Reprovação é permanente até novo teste e NUNCA vira disponível por inferência.
  catalog.recordTest('modelo-b', 'images.analyze', { ok: false, detail: 'reprovado na experiência do usuário' });
  assert.equal(catalog.statusFor('modelo-b', 'images.analyze'), 'unavailable');
  assert.equal(catalog.supports('modelo-b', 'images.analyze'), false);
  assert.equal(catalog.supports('modelo-b', 'images.analyze', { requires: 'tested' }), false);

  // Quem exige garantia não aceita "declarado".
  catalog.declare('modelo-c', { capabilities: { 'images.analyze': true } });
  assert.equal(catalog.supports('modelo-c', 'images.analyze'), true);
  assert.equal(catalog.supports('modelo-c', 'images.analyze', { requires: 'tested' }), false);

  const entry = catalog.get('modelo-b');
  assert.equal(entry.capabilities['images.analyze'], 'unavailable');
  assert.equal(catalog.get('inexistente'), null);
});

/* ------------------------------- roteamento ------------------------------ */

const catalogPadrao = () => {
  const catalog = new CapabilityCatalog();
  catalog.declare('primario', { provider: 'siwc-responses', cost: COST.PLAN, capabilities: { 'text.chat': true, reasoning: true } });
  catalog.declare('alternativa', { provider: 'siwc-responses', cost: COST.PLAN, capabilities: { 'text.chat': true } });
  catalog.declare('visao', { provider: 'siwc-responses', cost: COST.PLAN, capabilities: { 'images.analyze': true } });
  catalog.declare('pago', { provider: 'outro-provedor', cost: COST.PAID, capabilities: { 'text.chat': true } });
  return catalog;
};

test('sem pedido explícito, o PRIMÁRIO é preservado — mesmo com outro disponível', () => {
  const { chain, decision } = selectChain({ primary: 'primario', fallback: 'alternativa', catalog: catalogPadrao() });
  assert.deepEqual(chain, ['primario', 'alternativa'], 'primário primeiro; alternativa só como reserva');
  assert.equal(decision.selected_model, 'primario');
  assert.equal(decision.reason, 'modelo_primario_preservado');
});

test('não troca de modelo só porque outro está disponível (sem fallback configurado)', () => {
  const { chain, decision } = selectChain({ primary: 'primario', catalog: catalogPadrao() });
  assert.deepEqual(chain, ['primario']);
  assert.equal(decision.fallback_available, false);
});

test('pedido explícito do usuário vence a política de primário', () => {
  const { chain, decision } = selectChain({ primary: 'primario', requestedModel: 'alternativa', explicit: true, catalog: catalogPadrao() });
  assert.deepEqual(chain, ['alternativa']);
  assert.equal(decision.reason, 'pedido_explicito_do_usuario');
});

test('capacidade sem suporte no primário usa especializado aprovado', () => {
  const { chain, decision } = selectChain({
    capability: 'images.analyze',
    primary: 'primario',
    specialized: { 'images.analyze': ['visao'] },
    catalog: catalogPadrao(),
  });
  assert.deepEqual(chain, ['visao']);
  assert.equal(decision.reason, 'capacidade_especializada_aprovada');
});

test('capacidade sem especializado aprovado é RECUSADA com código claro', () => {
  const { chain, decision } = selectChain({ capability: 'images.analyze', primary: 'primario', catalog: catalogPadrao() });
  assert.deepEqual(chain, []);
  assert.equal(decision.blocked.code, 'capability_unavailable');
  assert.match(decision.blocked.message, /images\.analyze/);
});

test('especializado reprovado no catálogo não é usado, mesmo aprovado na lista', () => {
  const catalog = catalogPadrao();
  catalog.recordTest('visao', 'images.analyze', { ok: false, detail: 'reprovado' });
  const { chain, decision } = selectChain({
    capability: 'images.analyze',
    primary: 'primario',
    specialized: { 'images.analyze': ['visao'] },
    catalog,
  });
  assert.deepEqual(chain, []);
  assert.equal(decision.blocked.code, 'capability_unavailable');
  assert.ok(decision.skipped.some((s) => s.model === 'visao' && s.reason === 'capability_unavailable'));
});

test('custo pago é BLOQUEADO por padrão (plan-only)', () => {
  const { chain, decision } = selectChain({ primary: 'primario', requestedModel: 'pago', explicit: true, catalog: catalogPadrao() });
  assert.deepEqual(chain, []);
  assert.equal(decision.blocked.code, 'cost_blocked');
  assert.match(decision.blocked.message, /plan-only/);
});

test('custo pago só passa com política allow-paid explícita', () => {
  const { chain } = selectChain({ primary: 'primario', requestedModel: 'pago', explicit: true, costPolicy: 'allow-paid', catalog: catalogPadrao() });
  assert.deepEqual(chain, ['pago']);
});

test('primário bloqueado por falhas usa o fallback (falha comprovada)', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  breaker.record('primario', false);
  const { chain, decision } = selectChain({ primary: 'primario', fallback: 'alternativa', catalog: catalogPadrao(), breaker });
  assert.deepEqual(chain, ['alternativa']);
  assert.equal(decision.reason, 'primario_bloqueado_por_falhas');
});

test('sem alternativa utilizável, a tarefa é PRESERVADA com recusa explícita', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  breaker.record('primario', false);
  const { chain, decision } = selectChain({ primary: 'primario', catalog: catalogPadrao(), breaker });
  assert.deepEqual(chain, []);
  assert.equal(decision.blocked.code, 'no_candidate_available');
});

test('a cadeia NUNCA repete um modelo (sem loop de fallback)', () => {
  const { chain } = selectChain({
    primary: 'primario',
    fallback: 'primario',
    catalog: catalogPadrao(),
    maxFallbackHops: 5,
  });
  assert.deepEqual(chain, ['primario']);
  assert.equal(new Set(chain).size, chain.length);
});

test('cadeia respeita o teto de saltos de fallback', () => {
  const { chain } = selectChain({ primary: 'primario', fallback: 'alternativa', catalog: catalogPadrao(), maxFallbackHops: 1 });
  assert.equal(chain.length, 2);
  assert.deepEqual(chain, ['primario', 'alternativa']);
});

/* ---------------------------- elegibilidade ------------------------------ */

test('isFallbackEligible: infra pode tentar outro modelo; pedido inválido NÃO', () => {
  assert.equal(isFallbackEligible({ code: 'upstream_timeout', retryable: true }), true);
  assert.equal(isFallbackEligible({ code: 'upstream_connection_error', retryable: true }), true);
  assert.equal(isFallbackEligible({ code: 'gateway_rate_limit', retryable: true }), true);
  // Não mascara erro do pedido nem de conta.
  assert.equal(isFallbackEligible({ code: 'invalid_args', retryable: false }), false);
  assert.equal(isFallbackEligible({ code: 'authentication_required', retryable: false }), false);
  assert.equal(isFallbackEligible({ code: 'model_not_available', retryable: false }), false);
  assert.equal(isFallbackEligible({ code: 'request_too_large', retryable: false }), false);
});

/* ------------------------------ execução -------------------------------- */

test('execução: primeira tentativa boa encerra a cadeia', async () => {
  const chamadas = [];
  const out = await executeChain({
    chain: ['primario', 'alternativa'],
    call: async ({ model }) => { chamadas.push(model); return { text: 'ok' }; },
  });
  assert.equal(out.ok, true);
  assert.equal(out.model, 'primario');
  assert.equal(out.fallbackUsed, false);
  assert.deepEqual(chamadas, ['primario']);
});

test('execução: falha de infra cai para a alternativa — sem loop', async () => {
  const chamadas = [];
  const out = await executeChain({
    chain: ['primario', 'alternativa'],
    call: async ({ model }) => {
      chamadas.push(model);
      if (model === 'primario') throw Object.assign(new Error('caiu'), { code: 'upstream_connection_error', retryable: true });
      return { text: 'ok' };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.model, 'alternativa');
  assert.equal(out.fallbackUsed, true);
  assert.deepEqual(chamadas, ['primario', 'alternativa']);
});

test('execução: erro não recuperável para IMEDIATAMENTE (não mascara)', async () => {
  const chamadas = [];
  const out = await executeChain({
    chain: ['primario', 'alternativa'],
    call: async ({ model }) => {
      chamadas.push(model);
      throw Object.assign(new Error('chave inválida'), { code: 'authentication_required', retryable: false });
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.stopReason, 'erro_nao_recuperavel');
  assert.deepEqual(chamadas, ['primario'], 'não tenta outro modelo para erro de conta');
  assert.equal(out.code, 'authentication_required');
});

test('execução: timeout por tentativa é respeitado e conta como falha', async () => {
  const out = await executeChain({
    chain: ['primario'],
    timeoutMs: 30,
    call: async () => { await new Promise((r) => setTimeout(r, 500)); return {}; },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'engine_timeout');
  assert.equal(out.attempts[0].eligible_for_fallback, true);
});

test('execução: circuit breaker aberto pula o modelo sem chamar', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  breaker.record('primario', false);
  let chamouPrimario = false;
  const out = await executeChain({
    chain: ['primario', 'alternativa'],
    breaker,
    call: async ({ model }) => { if (model === 'primario') chamouPrimario = true; return { ok: true }; },
  });
  assert.equal(chamouPrimario, false);
  assert.equal(out.ok, true);
  assert.equal(out.model, 'alternativa');
  assert.ok(out.attempts.some((a) => a.outcome === 'skipped' && a.code === 'circuit_open'));
});

test('execução: tentativas limitadas por modelo (nunca repete em loop)', async () => {
  let n = 0;
  const out = await executeChain({
    chain: ['primario'],
    attemptsPerModel: 1,
    call: async () => { n += 1; throw Object.assign(new Error('x'), { code: 'upstream_timeout', retryable: true }); },
  });
  assert.equal(n, 1);
  assert.equal(out.ok, false);
  assert.equal(out.attempts.length, 1);
});

test('circuit breaker: fecha, abre e sonda em meio-aberto', () => {
  let agora = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 2, resetMs: 100, now: () => agora });
  assert.equal(breaker.allow('m'), true);
  breaker.record('m', false);
  assert.equal(breaker.status('m').state, 'closed');
  breaker.record('m', false);
  assert.equal(breaker.status('m').state, 'open');
  assert.equal(breaker.allow('m'), false);

  agora = 150; // passou a janela: uma sondagem é permitida
  assert.equal(breaker.allow('m'), true);
  assert.equal(breaker.allow('m'), false, 'só uma sondagem por janela');
  breaker.record('m', true); // sucesso fecha
  assert.equal(breaker.status('m').state, 'closed');
  assert.equal(breaker.allow('m'), true);
});

/* ------------------------- histórico de execução ------------------------- */

test('RunLog: guarda decisões, limita o tamanho e devolve por id', () => {
  const log = new RunLog({ limit: 3, now: () => Date.parse('2026-10-29T00:00:00Z') });
  for (let i = 1; i <= 5; i += 1) log.record({ kind: 'text.chat', status: 'completed', model_used: `m${i}` });
  assert.equal(log.size, 3);
  const lista = log.list({ limit: 10 });
  assert.equal(lista.length, 3);
  assert.equal(lista[0].model_used, 'm5', 'mais recente primeiro');
  assert.equal(lista[0].id, 'run_000005');
  assert.equal(log.get('run_000005').model_used, 'm5');
  assert.equal(log.get('run_000001'), null, 'saiu do ring buffer');
});
