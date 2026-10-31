import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionStore, buildContextMessages } from '../src/sessions.js';
import { silentLogger } from './helpers.js';

const makeStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-sess-'));
  return createSessionStore({ dataDir: dir, logger: silentLogger });
};

test('cria, recupera e lista sessões', () => {
  const store = makeStore();
  const session = store.create({});
  assert.match(session.id, /^s_/);

  const found = store.get(session.id);
  assert.equal(found.id, session.id);

  store.append(session, { role: 'user', content: 'Olá Kirana, tudo bem?' });
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Olá Kirana, tudo bem?');
  assert.equal(list[0].messageCount, 1);
});

test('título usa a primeira mensagem do usuário e é truncado', () => {
  const store = makeStore();
  const session = store.create({});
  store.append(session, { role: 'user', content: 'a'.repeat(120) });
  assert.ok(store.get(session.id).title.length <= 70);
});

test('apaga sessão e rejeita ids inválidos', () => {
  const store = makeStore();
  const session = store.create({});
  assert.equal(store.delete(session.id), true);
  assert.equal(store.get(session.id), null);
  assert.equal(store.get('../../etc/passwd'), null);
  assert.equal(store.delete('nao-e-um-id'), false);
});

test('ações pendentes são persistidas', () => {
  const store = makeStore();
  const session = store.create({});
  session.pendingAction = { id: 'act_123', tool: 'salvar_memoria', summary: 'teste' };
  store.save(session);
  assert.equal(store.get(session.id).pendingAction.id, 'act_123');
});

test('contexto: mantém apenas as últimas mensagens e começa com usuário', () => {
  const messages = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
  ];
  const context = buildContextMessages(messages, 3);
  assert.equal(context.length, 2);
  assert.equal(context[0].role, 'user');
  assert.equal(context[0].content, 'u2');
});

test('contexto: remove chamada de ferramenta sem resultado', () => {
  const messages = [
    { role: 'user', content: 'consulte os serviços' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'consultar_servicos', arguments: '{}' }],
    },
  ];
  const context = buildContextMessages(messages, 10);
  assert.equal(context.length, 1);
  assert.equal(context[0].role, 'user');
});

test('contexto: mantém par chamada/resultado completo', () => {
  const messages = [
    { role: 'user', content: 'consulte os serviços' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'consultar_servicos', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call_1', name: 'consultar_servicos', content: '{"ok":true}' },
    { role: 'assistant', content: 'Temos seis serviços.' },
  ];
  const context = buildContextMessages(messages, 10);
  assert.equal(context.length, 4);
  assert.equal(context[2].role, 'tool');
});

test('contexto: mensagem tool órfã é descartada', () => {
  const messages = [
    { role: 'user', content: 'oi' },
    { role: 'tool', toolCallId: 'call_x', name: 'consultar_servicos', content: '{}' },
    { role: 'assistant', content: 'olá' },
  ];
  const context = buildContextMessages(messages, 10);
  assert.equal(context.filter((m) => m.role === 'tool').length, 0);
});

test('métricas do turno são registradas', () => {
  const store = makeStore();
  const session = store.create({});
  store.recordMetrics(session, { ttftMs: 800, totalMs: 1500, toolCalls: 2 });
  store.recordMetrics(session, { ttftMs: 1200, totalMs: 2500, aborted: true });
  const reloaded = store.get(session.id);
  assert.equal(reloaded.stats.turns, 2);
  assert.equal(reloaded.stats.toolCalls, 2);
  assert.equal(reloaded.stats.aborted, 1);
  assert.deepEqual(reloaded.stats.ttftMs, [800, 1200]);
});
