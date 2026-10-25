/**
 * Tradutor Kirana -> AG-UI.
 *
 * ATUALIZAÇÃO DE ARQUITETURA (v0.3.0 final): RUN_STARTED e RUN_FINISHED são
 * emitidos pelo BuiltInAgent do CopilotKit (runFactory), não pelo tradutor.
 * O tradutor cuida do conteúdo: texto, tool calls, confirmações e erros.
 * Os testes abaixo refletem essa divisão de responsabilidade — a cobertura de
 * RUN_STARTED/FINISHED no fluxo real está em copilot-agui-endpoint.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGUI,
  KIRANA_EVENT,
  createAgUiTranslator,
  describeSharedState,
  lastUserText,
  toolResultsFromMessages,
} from '../src/copilot/agui-events.js';

const make = () => createAgUiTranslator({ runId: 'r1' });
const types = (events) => events.map((e) => e.type);

test('delta abre a mensagem uma única vez e acumula conteúdo', () => {
  const t = make();
  const first = t.translate({ type: KIRANA_EVENT.delta, text: 'Olá' });
  const second = t.translate({ type: KIRANA_EVENT.delta, text: ' mundo' });

  assert.deepEqual(types(first), [AGUI.TEXT_MESSAGE_START, AGUI.TEXT_MESSAGE_CONTENT]);
  assert.deepEqual(types(second), [AGUI.TEXT_MESSAGE_CONTENT]);
  assert.equal(first[1].delta, 'Olá');
  assert.equal(second[0].delta, ' mundo');
  assert.equal(first[0].messageId, second[0].messageId, 'mesma mensagem');
});

test('delta vazio não abre mensagem', () => {
  const t = make();
  assert.deepEqual(t.translate({ type: KIRANA_EVENT.delta, text: '' }), []);
});

test('done fecha a mensagem aberta e marca o tradutor como finalizado', () => {
  const t = make();
  t.translate({ type: KIRANA_EVENT.delta, text: 'oi' });
  const events = t.translate({ type: KIRANA_EVENT.done, responseMs: 42 });

  assert.deepEqual(types(events), [AGUI.TEXT_MESSAGE_END, AGUI.CUSTOM]);
  assert.equal(events[1].name, 'kirana.done');
  assert.equal(events[1].value.responseMs, 42);
  assert.equal(t.finalized, true);
});

test('depois de finalizado, novos eventos são ignorados', () => {
  const t = make();
  t.translate({ type: KIRANA_EVENT.done });
  assert.deepEqual(t.translate({ type: KIRANA_EVENT.delta, text: 'tarde demais' }), []);
});

test('ferramenta de frontend sai completa: START + ARGS + END', () => {
  const t = make();
  const events = t.translate({
    type: KIRANA_EVENT.externalTool,
    callId: 'call_1',
    name: 'navigateToPage',
    args: { page: 'contato' },
  });

  assert.deepEqual(types(events), [AGUI.TOOL_CALL_START, AGUI.TOOL_CALL_ARGS, AGUI.TOOL_CALL_END]);
  assert.equal(events[0].toolCallName, 'navigateToPage');
  assert.equal(events[0].toolCallId, 'call_1');
  assert.deepEqual(JSON.parse(events[1].delta), { page: 'contato' });
  assert.equal(events[2].toolCallId, 'call_1');
});

test('tool_start de frontend não duplica a chamada já anunciada', () => {
  const t = make();
  assert.deepEqual(t.translate({ type: KIRANA_EVENT.toolStart, name: 'navigateToPage', kind: 'frontend' }), []);

  const events = t.translate({ type: KIRANA_EVENT.externalTool, callId: 'c1', name: 'navigateToPage', args: {} });
  assert.equal(events.filter((e) => e.type === AGUI.TOOL_CALL_START).length, 1);
});

test('ferramenta de servidor abre no tool_start e fecha no tool_result', () => {
  const t = make();
  const start = t.translate({ type: KIRANA_EVENT.toolStart, name: 'consultar_servicos', kind: 'read' });
  const end = t.translate({ type: KIRANA_EVENT.toolResult, name: 'consultar_servicos', ok: true });

  assert.equal(start[0].type, AGUI.TOOL_CALL_START);
  assert.equal(start[0].toolCallName, 'consultar_servicos');
  assert.deepEqual(types(end), [AGUI.TOOL_CALL_END]);
  assert.equal(end[0].toolCallId, start[0].toolCallId, 'mesmo id nas duas pontas');
});

test('tool_result de ferramenta de frontend não gera END duplicado', () => {
  const t = make();
  t.translate({ type: KIRANA_EVENT.externalTool, callId: 'c9', name: 'fillContactForm', args: {} });
  assert.deepEqual(t.translate({ type: KIRANA_EVENT.toolResult, name: 'fillContactForm', external: true }), []);
});

test('confirmação vira evento CUSTOM com a ação pendente', () => {
  const t = make();
  const events = t.translate({ type: KIRANA_EVENT.confirmation, action: { id: 'a1', tool: 'registrar_interesse_comercial' } });

  assert.equal(events[0].type, AGUI.CUSTOM);
  assert.equal(events[0].name, 'kirana.confirmation');
  assert.equal(events[0].value.action.id, 'a1');
});

test('erro fecha o texto e vira RUN_ERROR com código', () => {
  const t = make();
  t.translate({ type: KIRANA_EVENT.delta, text: 'parcial' });
  const events = t.translate({ type: KIRANA_EVENT.error, error: { code: 'gateway_unreachable', message: 'sem gateway' } });

  assert.deepEqual(types(events), [AGUI.TEXT_MESSAGE_END, AGUI.RUN_ERROR]);
  assert.equal(events[1].code, 'gateway_unreachable');
  assert.equal(events[1].message, 'sem gateway');
  assert.equal(t.finalized, true);
});

test('close() defensivo encerra o texto uma vez (cancelamento/desconexão)', () => {
  const t = make();
  t.translate({ type: KIRANA_EVENT.delta, text: 'meio' });

  const events = t.close('aborted');
  assert.deepEqual(types(events), [AGUI.TEXT_MESSAGE_END, AGUI.CUSTOM]);
  assert.equal(events[1].name, 'kirana.closed');
  assert.equal(events[1].value.reason, 'aborted');
  assert.deepEqual(t.close('aborted'), [], 'não repete o encerramento');
});

test('evento desconhecido é ignorado sem quebrar o stream', () => {
  const t = make();
  assert.deepEqual(t.translate({ type: 'evento_novo_qualquer', foo: 1 }), []);
  assert.deepEqual(t.translate(null), []);
  assert.deepEqual(t.translate(undefined), []);
});

test('lastUserText pega a última mensagem do usuário', () => {
  assert.equal(
    lastUserText({ messages: [{ role: 'user', content: 'primeira' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'última' }] }),
    'última',
  );
  assert.equal(lastUserText({ messages: [{ role: 'user', content: [{ type: 'text', text: 'em partes' }] }] }), 'em partes');
  assert.equal(lastUserText({ messages: [] }), '');
  assert.equal(lastUserText({}), '');
});

test('toolResultsFromMessages extrai os resultados devolvidos pelo navegador', () => {
  const results = toolResultsFromMessages({
    messages: [
      { role: 'user', content: 'oi' },
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true,"protocolo":"INT-1"}' },
      { role: 'tool', toolCallId: 'c2', content: 'texto simples' },
    ],
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].toolCallId, 'c1');
  assert.match(results[0].content, /INT-1/);
  assert.equal(results[1].content, 'texto simples');
});

test('describeSharedState vira contexto legível de página', () => {
  const text = describeSharedState({ page: 'contato', formStep: 'ready' });
  assert.match(text, /page: contato/);
  assert.match(text, /formStep: ready/);
  assert.equal(describeSharedState({}), '');
  assert.equal(describeSharedState(null), '');
});

test('todos os nomes de evento do protocolo usados existem', () => {
  for (const name of ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'CUSTOM', 'RUN_ERROR']) {
    assert.equal(typeof AGUI[name], 'string', name);
    assert.equal(AGUI[name], name, 'nome canônico AG-UI');
  }
});
