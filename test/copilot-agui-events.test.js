/** Tradutor de eventos Kirana -> AG-UI (protocolo puro, sem rede). */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AGUI, KIRANA_EVENT, createAgUiTranslator, lastUserText, describeSharedState } from '../src/copilot/agui-events.js';

const make = () => createAgUiTranslator({ threadId: 't1', runId: 'r1' });

test('delta abre e mantém uma única mensagem de texto', () => {
  const t = make();
  const first = t.translate({ type: KIRANA_EVENT.delta, text: 'Olá' });
  const second = t.translate({ type: KIRANA_EVENT.delta, text: ' mundo' });

  assert.deepEqual(first.map((e) => e.type), [AGUI.TEXT_MESSAGE_START, AGUI.TEXT_MESSAGE_CONTENT]);
  assert.deepEqual(second.map((e) => e.type), [AGUI.TEXT_MESSAGE_CONTENT]);
  assert.equal(first[1].delta, 'Olá');
  assert.equal(second[0].delta, ' mundo');
});

test('done fecha a mensagem e finaliza o run', () => {
  const t = make();
  t.translate({ type: KIRANA_EVENT.delta, text: 'oi' });
  const events = t.translate({ type: KIRANA_EVENT.done, responseMs: 12 });

  const types = events.map((e) => e.type);
  assert.ok(types.includes(AGUI.TEXT_MESSAGE_END));
  assert.equal(types.at(-1), AGUI.RUN_FINISHED);
  assert.equal(events.at(-1).threadId, 't1');
  assert.equal(events.at(-1).runId, 'r1');
  assert.equal(t.finished, true);
});

test('depois de finalizado, o tradutor ignora novos eventos', () => {
  const t = make();
  t.translate({ type: KIRANA_EVENT.done });
  assert.deepEqual(t.translate({ type: KIRANA_EVENT.delta, text: 'tarde demais' }), []);
});

test('ferramenta de frontend vira TOOL_CALL completo com argumentos', () => {
  const t = make();
  const events = t.translate({
    type: KIRANA_EVENT.externalTool,
    callId: 'call_1',
    name: 'navigateToPage',
    args: { page: 'contato' },
  });

  assert.deepEqual(events.map((e) => e.type), [AGUI.TOOL_CALL_START, AGUI.TOOL_CALL_ARGS, AGUI.TOOL_CALL_END]);
  assert.equal(events[0].toolCallName, 'navigateToPage');
  assert.equal(events[0].toolCallId, 'call_1');
  assert.deepEqual(JSON.parse(events[1].delta), { page: 'contato' });
  assert.equal(events[2].toolCallId, 'call_1');
});

test('tool_start de frontend não duplica a chamada (quem anuncia é external_tool)', () => {
  const t = make();
  assert.deepEqual(t.translate({ type: KIRANA_EVENT.toolStart, name: 'navigateToPage', kind: 'frontend' }), []);

  const events = t.translate({ type: KIRANA_EVENT.externalTool, callId: 'c1', name: 'navigateToPage', args: {} });
  assert.equal(events.filter((e) => e.type === AGUI.TOOL_CALL_START).length, 1);
});

test('ferramenta de servidor abre e fecha a chamada', () => {
  const t = make();
  const start = t.translate({ type: KIRANA_EVENT.toolStart, name: 'consultar_servicos', kind: 'read' });
  const end = t.translate({ type: KIRANA_EVENT.toolResult, name: 'consultar_servicos', ok: true });

  assert.equal(start[0].type, AGUI.TOOL_CALL_START);
  assert.equal(start[0].toolCallName, 'consultar_servicos');
  assert.equal(end[0].type, AGUI.TOOL_CALL_END);
  assert.equal(end[0].toolCallId, start[0].toolCallId);
});

test('STEP_STARTED abre uma vez mesmo com várias rodadas do modelo', () => {
  const t = make();
  const first = t.translate({ type: KIRANA_EVENT.start, model: 'gpt-6-luna' });
  const second = t.translate({ type: KIRANA_EVENT.start, model: 'gpt-6-luna' });

  assert.equal(first.filter((e) => e.type === AGUI.STEP_STARTED).length, 1);
  assert.equal(second.filter((e) => e.type === AGUI.STEP_STARTED).length, 0);
  assert.equal(second.filter((e) => e.type === AGUI.CUSTOM).length, 1);
});

test('confirmação pendente é exposta como evento CUSTOM', () => {
  const t = make();
  const events = t.translate({ type: KIRANA_EVENT.confirmation, action: { id: 'a1', tool: 'registrar_interesse_comercial' } });
  assert.equal(events[0].type, AGUI.CUSTOM);
  assert.equal(events[0].name, 'kirana.confirmation');
  assert.equal(events[0].value.action.id, 'a1');
});

test('erro encerra com RUN_ERROR e sem RUN_FINISHED', () => {
  const t = make();
  t.translate({ type: KIRANA_EVENT.delta, text: 'parcial' });
  const events = t.translate({ type: KIRANA_EVENT.error, error: { code: 'gateway_unreachable', message: 'sem gateway' } });
  const types = events.map((e) => e.type);

  assert.ok(types.includes(AGUI.TEXT_MESSAGE_END));
  assert.equal(types.at(-1), AGUI.RUN_ERROR);
  assert.ok(!types.includes(AGUI.RUN_FINISHED));
  assert.equal(events.at(-1).code, 'gateway_unreachable');
});

test('close() defensivo finaliza como abortado (cancelamento/desconexão)', () => {
  const t = make();
  t.translate({ type: KIRANA_EVENT.delta, text: 'meio' });
  const events = t.close({ reason: 'aborted' });

  assert.equal(events.at(-1).type, AGUI.RUN_FINISHED);
  assert.equal(events.at(-1).result.aborted, true);
  assert.equal(events.at(-1).result.reason, 'aborted');
});

test('evento desconhecido não quebra o tradutor', () => {
  const t = make();
  const events = t.translate({ type: 'algo_novo', foo: 1 });
  assert.equal(events[0].type, AGUI.CUSTOM);
});

test('lastUserText extrai texto de string e de partes', () => {
  assert.equal(lastUserText({ messages: [{ role: 'user', content: 'primeira' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'última' }] }), 'última');
  assert.equal(lastUserText({ messages: [{ role: 'user', content: [{ type: 'text', text: 'parte' }] }] }), 'parte');
  assert.equal(lastUserText({ messages: [] }), '');
});

test('describeSharedState vira contexto de sistema legível', () => {
  const text = describeSharedState({ page: 'contato', formStep: 'ready' });
  assert.match(text, /page: contato/);
  assert.match(text, /formStep: ready/);
  assert.equal(describeSharedState({}), '');
});
