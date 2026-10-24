import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchema } from '../src/validation.js';

const schema = {
  type: 'object',
  properties: {
    nome: { type: 'string', minLength: 2, maxLength: 10 },
    canal: { type: 'string', enum: ['email', 'whatsapp'] },
    idade: { type: 'integer', minimum: 0, maximum: 120 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
  },
  required: ['nome'],
  additionalProperties: false,
};

test('aceita objeto válido', () => {
  assert.deepEqual(validateJsonSchema(schema, { nome: 'Ana', canal: 'email', idade: 30, tags: ['a'] }), []);
});

test('recusa campo obrigatório ausente', () => {
  const errors = validateJsonSchema(schema, {});
  assert.equal(errors.length, 1);
  assert.match(errors[0].path, /nome/);
});

test('recusa tipo errado', () => {
  const errors = validateJsonSchema(schema, { nome: 5 });
  assert.ok(errors.some((e) => /string/.test(e.message)));
});

test('recusa valor fora do enum', () => {
  const errors = validateJsonSchema(schema, { nome: 'Ana', canal: 'pombo' });
  assert.ok(errors.some((e) => /valor deve ser um de/.test(e.message)));
});

test('respeita minLength/maxLength', () => {
  assert.ok(validateJsonSchema(schema, { nome: 'A' }).length > 0);
  assert.ok(validateJsonSchema(schema, { nome: 'A'.repeat(11) }).length > 0);
});

test('respeita mínimo e máximo numérico', () => {
  assert.ok(validateJsonSchema(schema, { nome: 'Ana', idade: -1 }).length > 0);
  assert.ok(validateJsonSchema(schema, { nome: 'Ana', idade: 200 }).length > 0);
});

test('respeita maxItems e valida itens', () => {
  assert.ok(validateJsonSchema(schema, { nome: 'Ana', tags: ['a', 'b', 'c'] }).length > 0);
  assert.ok(validateJsonSchema(schema, { nome: 'Ana', tags: [1] }).length > 0);
});

test('additionalProperties: false bloqueia campos extras', () => {
  const errors = validateJsonSchema(schema, { nome: 'Ana', senha: 'x' });
  assert.ok(errors.some((e) => /não permitido/.test(e.message)));
});

test('pattern de e-mail', () => {
  const emailSchema = { type: 'object', properties: { email: { type: 'string', pattern: '^[^@]+@[^@]+$' } } };
  assert.equal(validateJsonSchema(emailSchema, { email: 'a@b.co' }).length, 0);
  assert.equal(validateJsonSchema(emailSchema, { email: 'invalido' }).length, 1);
});
