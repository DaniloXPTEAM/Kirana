import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../src/sse.js';

test('parser de SSE: evento simples', () => {
  const parser = createSseParser();
  const events = parser.push('data: {"a":1}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{"a":1}');
});

test('parser de SSE: fragmentos no meio da linha são remontados', () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push('data: {"con'), []);
  assert.deepEqual(parser.push('tent":"oi"}\n'), []);
  const events = parser.push('\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{"content":"oi"}');
});

test('parser de SSE: fragmento no meio do separador (CRLF)', () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push('data: {"x":1}\r'), []);
  const events = parser.push('\n\r\n');
  assert.equal(events.length, 1);
});

test('parser de SSE: vários eventos em um chunk', () => {
  const parser = createSseParser();
  const events = parser.push('data: 1\n\ndata: 2\n\ndata: 3\n\n');
  assert.deepEqual(
    events.map((e) => e.data),
    ['1', '2', '3'],
  );
});

test('parser de SSE: linhas de comentário e campos event', () => {
  const parser = createSseParser();
  const events = parser.push(': keep-alive\n\nevent: delta\ndata: {"ok":true}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'delta');
});

test('parser de SSE: flush entrega frame sem terminador', () => {
  const parser = createSseParser();
  parser.push('data: {"final":true}');
  const events = parser.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{"final":true}');
});

test('parser de SSE: múltiplas linhas data são unidas', () => {
  const parser = createSseParser();
  const events = parser.push('data: linha1\ndata: linha2\n\n');
  assert.equal(events[0].data, 'linha1\nlinha2');
});
