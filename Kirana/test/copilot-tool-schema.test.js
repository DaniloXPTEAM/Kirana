/** Validação de argumentos e sanitização do estado compartilhado. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { aguiToolToOpenAi, sanitizeSharedState, validateToolArgs, TOOL_NAME_RE } from '../src/copilot/tool-schema.js';

const navigateSchema = {
  type: 'object',
  properties: { page: { type: 'string', enum: ['inicio', 'solucoes', 'labs', 'contato'] } },
  required: ['page'],
  additionalProperties: false,
};

test('converte ferramenta AG-UI para função OpenAI', () => {
  const schema = aguiToolToOpenAi({ name: 'navigateToPage', description: 'navega', parameters: navigateSchema });
  assert.equal(schema.type, 'function');
  assert.equal(schema.function.name, 'navigateToPage');
  assert.deepEqual(schema.function.parameters, navigateSchema);
});

test('rejeita nome de ferramenta fora do padrão', () => {
  assert.equal(aguiToolToOpenAi({ name: '<script>', parameters: {} }), null);
  assert.equal(aguiToolToOpenAi({ name: 'x' }), null);
  assert.equal(aguiToolToOpenAi(null), null);
  assert.ok(TOOL_NAME_RE.test('navigateToPage'));
});

test('aceita argumentos válidos (objeto e JSON em string)', () => {
  assert.equal(validateToolArgs(navigateSchema, { page: 'contato' }).ok, true);
  const fromString = validateToolArgs(navigateSchema, '{"page":"labs"}');
  assert.equal(fromString.ok, true);
  assert.equal(fromString.args.page, 'labs');
});

test('recusa enum fora da lista, campo faltando e campo extra', () => {
  const enumError = validateToolArgs(navigateSchema, { page: 'precos' });
  assert.equal(enumError.ok, false);
  assert.match(enumError.errors[0].message, /lista permitida/);

  const missing = validateToolArgs(navigateSchema, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].path, 'page');

  const extra = validateToolArgs(navigateSchema, { page: 'labs', hack: '1' });
  assert.equal(extra.ok, false);
  assert.equal(extra.errors[0].message, 'campo não previsto');
});

test('recusa JSON inválido e tipos errados', () => {
  assert.equal(validateToolArgs(navigateSchema, '{quebrado').ok, false);
  assert.equal(validateToolArgs({ type: 'object', properties: { n: { type: 'number' } } }, { n: '3' }).ok, false);
  assert.equal(validateToolArgs({ type: 'object', properties: { n: { type: 'integer' } } }, { n: 3.5 }).ok, false);
});

test('respeita minLength, maxLength, pattern e arrays aninhados', () => {
  const schema = {
    type: 'object',
    properties: {
      nome: { type: 'string', minLength: 2, maxLength: 5 },
      email: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
    },
    required: ['nome'],
  };
  assert.equal(validateToolArgs(schema, { nome: 'A' }).ok, false);
  assert.equal(validateToolArgs(schema, { nome: 'Ana' }).ok, true);
  assert.equal(validateToolArgs(schema, { nome: 'Anastacia' }).ok, false);
  assert.equal(validateToolArgs(schema, { nome: 'Ana', email: 'nao-email' }).ok, false);
  assert.equal(validateToolArgs(schema, { nome: 'Ana', email: 'a@b.co' }).ok, true);
  assert.equal(validateToolArgs(schema, { nome: 'Ana', tags: ['c'] }).ok, false);
});

test('estado compartilhado: remove chaves sensíveis e funções', () => {
  const state = sanitizeSharedState({
    page: 'contato',
    formStep: 'ready',
    token: 'segredo',
    apiKey: 'sk-123',
    senha: 'x',
    onClick: () => {},
    nested: { cpf: '000', ok: 1 },
  });

  assert.equal(state.page, 'contato');
  assert.equal(state.token, undefined);
  assert.equal(state.apiKey, undefined);
  assert.equal(state.senha, undefined);
  assert.equal(state.onClick, undefined);
  assert.deepEqual(state.nested, { ok: 1 });
});

test('estado compartilhado: limita quantidade de chaves e profundidade', () => {
  const big = {};
  for (let i = 0; i < 40; i += 1) big[`k${i}`] = i;
  const limited = sanitizeSharedState(big, { maxKeys: 5 });
  assert.equal(Object.keys(limited).length, 5);

  const deep = { a: { b: { c: { d: 'muito fundo' } } } };
  const shallow = sanitizeSharedState(deep, { maxDepth: 2 });
  // Objetos além do limite viram objeto vazio: o valor profundo não passa.
  assert.deepEqual(shallow, { a: { b: { c: {} } } });
  assert.equal(JSON.stringify(shallow).includes('muito fundo'), false);
});

test('estado compartilhado: entradas inválidas viram objeto vazio', () => {
  assert.deepEqual(sanitizeSharedState(null), {});
  assert.deepEqual(sanitizeSharedState('texto'), {});
  assert.deepEqual(sanitizeSharedState([]), {});
});
