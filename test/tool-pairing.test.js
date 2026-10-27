/**
 * Regressão do defeito de 27/10/2026 — continuação com múltiplas ferramentas.
 *
 * Sintoma: o modelo pedia duas ou mais ferramentas no mesmo turno; a Kirana
 * executava todas, mas o histórico enviado na continuação perdia o segundo
 * resultado em diante. O Gateway v0.4.0 traduzia isso para a Responses API como
 * um `function_call` sem `function_call_output`, e a API respondia
 * `400 invalid_request_error` — a conversa travava depois de "ferramenta ok".
 *
 * Os testes cobrem a montagem do contexto (src/sessions.js) e a barreira de
 * contrato (src/contract.js) nos estados que a auditoria levantou.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildContextMessages } from '../src/sessions.js';
import { validateGatewayPayload, validateToolCallPairing } from '../src/contract.js';
import { loadConfig } from '../src/config.js';

/* -------------------------------------------------------------------------- */
/* Ajuda                                                                      */
/* -------------------------------------------------------------------------- */

const call = (id, name = 'consultar_servicos') => ({ id, name, arguments: '{}' });

/** Mensagem de assistente com N chamadas (o que o modelo devolveu). */
const assistantCalls = (...ids) => ({ role: 'assistant', content: '', toolCalls: ids.map((id) => call(id)) });

/** Resultado de ferramenta como fica persistido na sessão. */
const toolResult = (id) => ({ role: 'tool', toolCallId: id, name: 'consultar_servicos', content: `{"ok":true,"id":"${id}"}` });

/** Converte o histórico da Kirana no formato que sai para o Gateway. */
function toApiMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant') {
      const base = { role: 'assistant', content: typeof m.content === 'string' ? m.content : '' };
      if (m.toolCalls?.length) {
        base.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
      }
      return base;
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

/** Pares efetivamente enviados: usado nos asserts de integridade. */
function pairs(messages) {
  const calls = [];
  const outputs = [];
  for (const m of messages) {
    if (m.role === 'assistant') for (const c of m.tool_calls || []) calls.push(c.id);
    if (m.role === 'tool') outputs.push(m.tool_call_id);
  }
  return { calls, outputs, unpaired: calls.filter((id) => !outputs.includes(id)) };
}

const build = (messages, limit = 24) => toApiMessages(buildContextMessages(messages, limit));

/* -------------------------------------------------------------------------- */
/* 1. Casos obrigatórios da correção                                          */
/* -------------------------------------------------------------------------- */

test('continuação: uma ferramenta mantém chamada e resultado', () => {
  const out = build([{ role: 'user', content: 'liste os serviços' }, assistantCalls('call_1'), toolResult('call_1')]);

  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.deepEqual(pairs(out).unpaired, []);
  assert.equal(out[2].tool_call_id, 'call_1');
});

test('continuação: duas ferramentas no mesmo turno preservam os dois resultados', () => {
  const out = build([
    { role: 'user', content: 'liste os serviços e as soluções' },
    assistantCalls('call_A', 'call_B'),
    toolResult('call_A'),
    toolResult('call_B'),
  ]);

  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'tool']);
  assert.deepEqual(pairs(out).calls, ['call_A', 'call_B']);
  assert.deepEqual(pairs(out).outputs, ['call_A', 'call_B']); // IDs originais, na ordem
  assert.deepEqual(pairs(out).unpaired, []); // ← o defeito antigo deixava 'call_B' aqui
});

test('continuação: três ferramentas no mesmo turno preservam os três resultados', () => {
  const out = build([
    { role: 'user', content: 'faça as três consultas' },
    assistantCalls('call_A', 'call_B', 'call_C'),
    toolResult('call_A'),
    toolResult('call_B'),
    toolResult('call_C'),
  ]);

  assert.equal(out.length, 5);
  assert.deepEqual(pairs(out).outputs, ['call_A', 'call_B', 'call_C']);
  assert.deepEqual(pairs(out).unpaired, []);
});

test('continuação: ferramentas em turnos distintos permanecem íntegras', () => {
  const out = build([
    { role: 'user', content: 'liste os serviços' },
    assistantCalls('call_A'),
    toolResult('call_A'),
    { role: 'user', content: 'agora as soluções' },
    assistantCalls('call_B'),
    toolResult('call_B'),
  ]);

  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'user', 'assistant', 'tool']);
  assert.deepEqual(pairs(out).outputs, ['call_A', 'call_B']);
  assert.deepEqual(pairs(out).unpaired, []);
});

test('continuação: resultado com ID incorreto é descartado', () => {
  const out = build([
    { role: 'user', content: 'liste' },
    assistantCalls('call_A', 'call_B'),
    toolResult('call_A'),
    toolResult('call_INVENTADO'), // não pertence ao turno
    toolResult('call_B'),
  ]);

  assert.deepEqual(pairs(out).outputs, ['call_A', 'call_B']);
  assert.deepEqual(pairs(out).unpaired, []);
  assert.ok(!out.some((m) => m.role === 'tool' && m.tool_call_id === 'call_INVENTADO'));
});

test('continuação: resultado duplicado é enviado uma única vez', () => {
  const out = build([
    { role: 'user', content: 'liste' },
    assistantCalls('call_A', 'call_B'),
    toolResult('call_A'),
    toolResult('call_B'),
    toolResult('call_B'), // repetido (retry do backend, por exemplo)
  ]);

  const outputs = pairs(out).outputs;
  assert.deepEqual(outputs, ['call_A', 'call_B']);
  assert.equal(outputs.filter((id) => id === 'call_B').length, 1);
  assert.deepEqual(pairs(out).unpaired, []);
});

test('continuação: histórico incompleto derruba o grupo inteiro (sem chamada órfã)', () => {
  const out = build([
    { role: 'user', content: 'liste' },
    assistantCalls('call_A', 'call_B'),
    toolResult('call_A'),
    // resultado de call_B nunca foi persistido (turno abortado no meio do grupo)
  ]);

  // Sem o par completo, nem a chamada nem o resultado parcial vão para o Gateway.
  assert.deepEqual(out.map((m) => m.role), ['user']);
  assert.deepEqual(pairs(out).unpaired, []);
});

test('continuação: depois das ferramentas, a resposta final do modelo é preservada', () => {
  const out = build([
    { role: 'user', content: 'liste os serviços e as soluções' },
    assistantCalls('call_A', 'call_B'),
    toolResult('call_A'),
    toolResult('call_B'),
    { role: 'assistant', content: 'São seis soluções disponíveis.' },
    { role: 'user', content: 'e os preços?' },
  ]);

  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'assistant', 'user']);
  assert.equal(out[4].content, 'São seis soluções disponíveis.');
  assert.deepEqual(pairs(out).unpaired, []);
});

/* -------------------------------------------------------------------------- */
/* 2. Barreira de contrato (src/contract.js)                                  */
/* -------------------------------------------------------------------------- */

const payload = (messages) => ({ model: 'gpt-6-luna', messages: [{ role: 'system', content: 's' }, ...messages], stream: true });

test('contrato: continuação corrigida passa na checagem de emparelhamento', () => {
  const messages = build([
    { role: 'user', content: 'liste os serviços e as soluções' },
    assistantCalls('call_A', 'call_B'),
    toolResult('call_A'),
    toolResult('call_B'),
  ]);
  assert.deepEqual(validateGatewayPayload(payload(messages), { allowOptInFields: true, checkToolPairing: true }), []);
});

test('contrato: detecta chamada de ferramenta sem resultado e não envia', () => {
  // Payload como a versão anterior montava: `assistant` anunciando duas
  // chamadas e só o primeiro resultado. É o que tomava 400 do Gateway.
  const quebrado = [
    { role: 'user', content: 'liste' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_A', type: 'function', function: { name: 'consultar_servicos', arguments: '{}' } },
      { id: 'call_B', type: 'function', function: { name: 'list_services', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_A', content: '{"ok":true}' },
  ];
  const errors = validateGatewayPayload(payload(quebrado), { allowOptInFields: true, checkToolPairing: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /sem resultado correspondente: "call_B"/);
});

test('continuação: o contexto reparado nunca aciona a barreira de contrato', () => {
  const out = build([
    { role: 'user', content: 'liste' },
    assistantCalls('call_A', 'call_B'),
    toolResult('call_A'), // call_B sem resultado no histórico
  ]);
  assert.deepEqual(validateGatewayPayload(payload(out), { allowOptInFields: true, checkToolPairing: true }), []);
});

test('contrato: ação ainda em execução não é cobrada quando declarada pendente', () => {
  const messages = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_pendente', type: 'function', function: { name: 'x', arguments: '{}' } }] },
  ];
  assert.equal(validateToolCallPairing(messages).length, 1); // sem resultado: cobra
  assert.deepEqual(validateToolCallPairing(messages, { pendingToolCallIds: ['call_pendente'] }), []); // em execução: isenta
});

test('contrato: detecta resultado duplicado e resultado sem chamada anterior', () => {
  const duplicado = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_A', content: '{"ok":true}' },
    { role: 'tool', tool_call_id: 'call_A', content: '{"ok":true}' },
  ];
  const erroDup = validateToolCallPairing(duplicado);
  assert.equal(erroDup.length, 1);
  assert.match(erroDup[0].message, /duplicado/);

  const orfao = [{ role: 'tool', tool_call_id: 'call_Z', content: '{"ok":true}' }];
  const erroOrfao = validateToolCallPairing(orfao);
  assert.equal(erroOrfao.length, 1);
  assert.match(erroOrfao[0].message, /sem chamada correspondente/);
});

test('contrato: a checagem de emparelhamento é opt-in (formato não muda para outros usos)', () => {
  const messages = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'x', arguments: '{}' } }] },
  ];
  assert.deepEqual(validateGatewayPayload(payload(messages), { allowOptInFields: true }), []);
  assert.equal(validateGatewayPayload(payload(messages), { allowOptInFields: true, checkToolPairing: true }).length, 1);
});

/* -------------------------------------------------------------------------- */
/* 3. Versão em fonte única                                                    */
/* -------------------------------------------------------------------------- */

test('logs mostram a versão do package.json', async () => {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(loadConfig({}).version, pkg.version);
  assert.equal(loadConfig({}).version, '0.5.3');
});
