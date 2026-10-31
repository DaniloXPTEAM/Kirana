/**
 * Testes da limpeza de texto para fala.
 *
 * Regra central: a limpeza existe SÓ para o áudio. O texto do chat permanece
 * intacto — por isso os testes verificam que a função é pura (não muta) e que
 * nada de markdown/emoji/URL chega ao motor de voz.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeTextForSpeech, hasSpeakableContent, MAX_SPEECH_CHARS } from '../src/voice/tts-text.js';

test('remove emojis mantendo o texto falável', () => {
  const out = sanitizeTextForSpeech('Olá! 👋😊 Tudo bem? 🚀');
  assert.equal(out, 'Olá! Tudo bem?');
  assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(out), false);
});

test('remove marcação de markdown', () => {
  const out = sanitizeTextForSpeech('## Título\n\n**negrito** e *itálico* e ~~riscado~~');
  assert.equal(out.includes('#'), false);
  assert.equal(out.includes('*'), false);
  assert.equal(out.includes('~'), false);
  assert.match(out, /Título/);
  assert.match(out, /negrito/);
});

test('remove links e URLs mas mantém o rótulo', () => {
  const out = sanitizeTextForSpeech('Veja [nosso site](https://opportunity.ia.br) ou https://exemplo.com/x');
  assert.match(out, /nosso site/);
  assert.equal(out.includes('http'), false);
});

test('descarta blocos de código e mantém código inline sem as crases', () => {
  const md = 'Antes\n```js\nconst x = 1;\n```\nUse `npm run start` depois.';
  const out = sanitizeTextForSpeech(md);
  assert.equal(out.includes('const x'), false);
  assert.equal(out.includes('```'), false);
  assert.match(out, /npm run start/);
});

test('remove listas, citações e tabelas', () => {
  const out = sanitizeTextForSpeech('- item um\n- item dois\n> citado\n| a | b |');
  assert.equal(out.includes('-'), false);
  assert.equal(out.includes('>'), false);
  assert.equal(out.includes('|'), false);
  assert.match(out, /item um/);
  assert.match(out, /a, b/);
});

test('não altera o texto original (função pura)', () => {
  const original = '**Olá** 👋 [link](https://x.com)';
  const copy = String(original);
  sanitizeTextForSpeech(original);
  assert.equal(original, copy);
});

test('texto vazio ou só símbolos não é falável', () => {
  assert.equal(hasSpeakableContent(''), false);
  assert.equal(hasSpeakableContent('😊 *** ---'), false);
  assert.equal(hasSpeakableContent('Olá'), true);
});

test('a limpeza não trunca: o limite é aplicado (e recusado) no serviço', () => {
  const long = `${'a'.repeat(MAX_SPEECH_CHARS + 500)}.`;
  assert.equal(sanitizeTextForSpeech(long).length, long.length);
});

test('normaliza espaços sem criar pausas falsas na fala', () => {
  const out = sanitizeTextForSpeech('Olá   mundo .\n\n  Tudo   bem ?');
  assert.equal(out, 'Olá mundo. Tudo bem?');
  assert.equal(/\s{2,}/.test(out), false);
});
