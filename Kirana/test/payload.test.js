/**
 * Testes do payload enviado a POST /v1/chat/completions.
 *
 * Contexto: o Gateway v0.2.0 respondeu HTTP 400 `unsupported_parameter` para
 * `temperature` no Windows (24/10/2026). Estes testes existem para impedir
 * regressão: qualquer campo fora do contrato precisa falhar aqui, não no
 * gateway do usuário.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChatPayload,
  sanitizeMessage,
  sanitizeMessages,
  assertAllowedFields,
  stripField,
  extractUnsupportedField,
  GATEWAY_ALLOWED_FIELDS,
} from '../src/payload.js';

const messages = [
  { role: 'system', content: 'Você é Kirana.' },
  { role: 'user', content: 'Oi' },
];

test('payload padrão NÃO contém temperature (regressão do erro 400)', () => {
  const payload = buildChatPayload({ model: 'gpt-6-luna', messages });
  assert.equal('temperature' in payload, false, 'temperature não deve ser enviado ao Gateway v0.2.0');
});

test('payload padrão contém apenas model, messages e stream', () => {
  const payload = buildChatPayload({ model: 'gpt-6-luna', messages });
  assert.deepEqual(Object.keys(payload).sort(), ['messages', 'model', 'stream']);
  assert.equal(payload.stream, true);
});

test('payload padrão não envia max_tokens, tool_choice nem parallel_tool_calls', () => {
  const payload = buildChatPayload({
    model: 'gpt-6-luna',
    messages,
    tools: [{ type: 'function', function: { name: 'consultar_servicos', parameters: { type: 'object', properties: {} } } }],
    toolChoice: 'auto',
  });
  assert.equal('max_tokens' in payload, false);
  assert.equal('tool_choice' in payload, false);
  assert.equal('parallel_tool_calls' in payload, false);
});

test('todos os campos do payload pertencem à allowlist do gateway', () => {
  const payload = buildChatPayload({
    model: 'gpt-6-luna',
    messages,
    tools: [{ type: 'function', function: { name: 'x', parameters: { type: 'object', properties: {} } } }],
    flags: { sendTemperature: true, sendMaxTokens: true, sendToolChoice: true },
    temperature: 0.6,
    maxTokens: 500,
  });
  for (const field of Object.keys(payload)) {
    assert.ok(GATEWAY_ALLOWED_FIELDS.includes(field), `campo não previsto: ${field}`);
  }
});

test('tools entram apenas quando há ferramentas na rodada', () => {
  assert.equal('tools' in buildChatPayload({ model: 'm', messages, tools: [] }), false);
  assert.equal('tools' in buildChatPayload({ model: 'm', messages, tools: undefined }), false);
  const withTools = buildChatPayload({ model: 'm', messages, tools: [{ type: 'function', function: { name: 'a', parameters: {} } }] });
  assert.equal(Array.isArray(withTools.tools), true);
  assert.equal(withTools.tools.length, 1);
});

test('campos opcionais entram só com opt-in explícito', () => {
  const off = buildChatPayload({ model: 'm', messages, temperature: 0.7, maxTokens: 800, toolChoice: 'auto', tools: [{ type: 'function', function: { name: 'a', parameters: {} } }] });
  assert.equal('temperature' in off, false);
  assert.equal('max_tokens' in off, false);
  assert.equal('tool_choice' in off, false);

  const on = buildChatPayload({
    model: 'm',
    messages,
    temperature: 0.7,
    maxTokens: 800,
    toolChoice: 'auto',
    tools: [{ type: 'function', function: { name: 'a', parameters: {} } }],
    flags: { sendTemperature: true, sendMaxTokens: true, sendToolChoice: true },
  });
  assert.equal(on.temperature, 0.7);
  assert.equal(on.max_tokens, 800);
  assert.equal(on.tool_choice, 'auto');
});

test('assertAllowedFields barra campo fora do contrato', () => {
  assert.throws(() => assertAllowedFields({ model: 'm', messages, stream: true, top_p: 0.9 }), /não permitido/);
  assert.throws(() => assertAllowedFields({ model: 'm', messages, stream: true, presence_penalty: 1 }), /não permitido/);
});

test('sanitizeMessage remove chaves internas e nunca envia content null', () => {
  const assistant = sanitizeMessage({
    role: 'assistant',
    content: '',
    id: 'm_1',
    at: '2026-10-24T00:00:00.000Z',
    model: 'gpt-6-luna',
    ttftMs: 900,
    aborted: false,
    usage: { total_tokens: 3 },
    toolCalls: [{ id: 'call_1', name: 'consultar_servicos', arguments: '{"consulta":"crm"}' }],
  });
  assert.deepEqual(Object.keys(assistant).sort(), ['content', 'role', 'tool_calls']);
  assert.equal(assistant.content, '');
  assert.equal(assistant.tool_calls[0].function.name, 'consultar_servicos');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"consulta":"crm"}');

  const nullContent = sanitizeMessage({ role: 'assistant', content: null, toolCalls: [{ id: 'c', name: 'x', arguments: '{}' }] });
  assert.equal(nullContent.content, '');
});

test('sanitizeMessage converte mensagem de ferramenta para o formato OpenAI', () => {
  const tool = sanitizeMessage({ role: 'tool', toolCallId: 'call_9', name: 'consultar_servicos', content: '{"ok":true}' });
  assert.deepEqual(tool, { role: 'tool', tool_call_id: 'call_9', content: '{"ok":true}' });
});

test('sanitizeMessages preserva ordem e descarta inválidas', () => {
  const out = sanitizeMessages([{ role: 'user', content: 'oi' }, { content: 'sem role' }, { role: 'assistant', content: 'olá' }]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant']);
});

test('extractUnsupportedField reconhece o erro real do Gateway v0.2.0', () => {
  const realMessage =
    '{"error":{"code":"unsupported_parameter","message":"Unsupported request field: temperature. This gateway only forwards validated ChatGPT-plan-compatible fields."}}';
  assert.equal(extractUnsupportedField(400, realMessage), 'temperature');
  assert.equal(extractUnsupportedField(400, { error: { message: 'Unsupported request field: `top_p`.' } }), 'top_p');
  assert.equal(extractUnsupportedField(400, { error: { code: 'unsupported_parameter', param: 'max_tokens' } }), 'max_tokens');
  assert.equal(extractUnsupportedField(400, { error: { code: 'unsupported_parameter', field: 'seed' } }), 'seed');
});

test('extractUnsupportedField ignora erros que não são de campo', () => {
  assert.equal(extractUnsupportedField(500, 'boom'), null);
  assert.equal(extractUnsupportedField(401, '{"error":{"message":"unauthorized"}}'), null);
  assert.equal(extractUnsupportedField(400, '{"error":{"message":"mensagem inválida"}}'), null);
});

test('stripField remove apenas o campo pedido', () => {
  const payload = { model: 'm', messages, stream: true, temperature: 1 };
  const { payload: next, removed } = stripField(payload, 'temperature');
  assert.equal(removed, true);
  assert.equal('temperature' in next, false);
  assert.equal('temperature' in payload, true, 'não deve mutar o objeto original');
  assert.deepEqual(stripField(next, 'temperature'), { payload: next, removed: false });
});
