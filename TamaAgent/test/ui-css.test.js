/**
 * Regressão estática da interface: `hidden` tem que esconder de verdade.
 *
 * Causa do bug: `.composer-status { display: flex }` (regra de autor) vence
 * `[hidden] { display: none }` (regra do navegador). Resultado: o JS marcava
 * `hidden = true` e o indicador continuava visível.
 *
 * A proteção é uma regra global `[hidden] { display: none !important }`.
 * Se alguém remover essa regra, estes testes falham.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('styles.css tem a regra global que faz [hidden] vencer display do autor', () => {
  const rule = css.match(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important[^}]*\}/i);
  assert.ok(rule, 'falta a regra "[hidden] { display: none !important; }"');
});

test('composer-status é o bloco do indicador de geração e tem display de autor', () => {
  const block = css.match(/\.composer-status\s*\{[^}]*\}/);
  assert.ok(block, 'regra .composer-status não encontrada');
  assert.match(block[0], /display:\s*flex/, 'se mudar o display, revise o teste e a regra [hidden]');
});

test('o indicador tem spinner, texto e botão Interromper (elementos que travavam)', () => {
  const composerStart = html.indexOf('id="composer-status"');
  assert.ok(composerStart > -1);
  const snippet = html.slice(composerStart, composerStart + 700);
  assert.match(snippet, /class="spinner"/);
  assert.match(snippet, /id="composer-status-text"/);
  assert.match(snippet, /id="stop"/);
});

test('todo elemento alternado por .hidden existe no HTML', () => {
  const usados = [...appJs.matchAll(/els\.([A-Za-z0-9_]+)\.hidden\s*=/g)].map((m) => m[1]);
  assert.ok(usados.length >= 4, 'esperava vários elementos controlados por hidden');

  // Mapeia as chaves de `els` para ids do HTML declarados no objeto els.
  const elsBlock = appJs.slice(appJs.indexOf('const els = {'), appJs.indexOf('/* ------------------------------- utilidades'));
  for (const chave of new Set(usados)) {
    const declaracao = elsBlock.match(new RegExp(`${chave}:\\s*document\\.getElementById\\('([^']+)'\\)`));
    assert.ok(declaracao, `els.${chave} não é um getElementById — revisar`);
    assert.ok(html.includes(`id="${declaracao[1]}"`), `elemento #${declaracao[1]} não existe no HTML`);
  }
});

test('a interface importa a máquina de estados do compositor', () => {
  assert.match(appJs, /from '\.\/stream-state\.js'/);
  assert.match(appJs, /syncComposer\(/);
  assert.match(appJs, /finalize\(stream/);
});

test('stopGeneration encerra o estado sem esperar a rede', () => {
  const fn = appJs.slice(appJs.indexOf('function stopGeneration'), appJs.indexOf('/* -------------------------------- memória'));
  assert.match(fn, /controller\.abort\(\)/);
  assert.match(fn, /setStreamingUI\(false\)/);
});
