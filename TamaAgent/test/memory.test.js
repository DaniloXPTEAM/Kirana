import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryStore, MemoryError } from '../src/memory.js';
import { silentLogger } from './helpers.js';

const makeStore = (limits = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-mem-'));
  return { store: createMemoryStore({ dataDir: dir, limits, logger: silentLogger }), dir };
};

test('memória exige consentimento explícito', () => {
  const { store } = makeStore();
  assert.throws(
    () => store.upsert({ key: 'nome', value: 'Ana', consent: false }),
    (error) => error instanceof MemoryError && error.code === 'consent_required',
  );
  assert.equal(store.list().length, 0);
});

test('memória grava, atualiza pela chave e remove', () => {
  const { store } = makeStore();
  const first = store.upsert({ key: 'Nome', value: 'Ana', consent: true });
  assert.equal(store.list().length, 1);

  const updated = store.upsert({ key: 'nome', value: 'Ana Paula', consent: true });
  assert.equal(updated.id, first.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].value, 'Ana Paula');

  assert.equal(store.remove(first.id), true);
  assert.equal(store.list().length, 0);
});

test('memória bloqueia dados sensíveis', () => {
  const { store } = makeStore();
  assert.throws(() => store.upsert({ key: 'senha', value: 'abc123', consent: true }), /sensível/);
  assert.throws(() => store.upsert({ key: 'documento', value: '123.456.789-00', consent: true }), /sensível/);
  assert.throws(() => store.upsert({ key: 'cartao', value: '4111 1111 1111 1111', consent: true }), /sensível/);
});

test('memória limita o número de itens', () => {
  const { store } = makeStore({ maxItems: 2 });
  store.upsert({ key: 'a', value: '1', consent: true });
  store.upsert({ key: 'b', value: '2', consent: true });
  assert.throws(() => store.upsert({ key: 'c', value: '3', consent: true }), /Limite/);
});

test('memória persiste em disco e respeita orçamento de prompt', () => {
  const { store, dir } = makeStore();
  store.upsert({ key: 'empresa', value: 'ACME', consent: true });
  store.upsert({ key: 'preferencia', value: 'x'.repeat(60), consent: true });

  const reloaded = createMemoryStore({ dataDir: dir, limits: {}, logger: silentLogger });
  assert.equal(reloaded.list().length, 2);

  const budgetItems = reloaded.promptItems(30);
  assert.ok(budgetItems.length <= 1);
});

test('memória pode ser limpa', () => {
  const { store } = makeStore();
  store.upsert({ key: 'a', value: '1', consent: true });
  store.clear();
  assert.equal(store.list().length, 0);
});
