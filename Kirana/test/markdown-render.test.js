/**
 * R10 — Markdown da interface.
 *
 * Defeito relatado: código e títulos apareciam com `\###`, `\-` e ` ``` ` na tela.
 * Investigação (correção pós-0.5.3):
 *   • a interface NUNCA adiciona barras invertidas (testado abaixo) — elas vinham
 *     no texto do modelo, que "escapa" markdown para não ser interpretado;
 *   • o renderizador antigo não conhecia BLOCO de código nem TÍTULO: as três
 *     crases e o jogo-da-velha eram exibidos como texto e o código de várias
 *     linhas era esmagado em um parágrafo.
 *
 * Correção: `public/markdown.js` (extraído de app.js) com bloco de código,
 * títulos, listas, citação, tabela e normalização das barras invertidas — tudo
 * escapado antes de virar HTML.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, formatHtml, normalizeEscapedMarkdown } from '../public/markdown.js';

test('bloco de código: preserva linhas, indentação e linguagem', () => {
  const html = formatHtml('Veja o exemplo:\n\n```js\nfunction soma(a, b) {\n  return a + b;\n}\n```\n\nPronto.');
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /function soma\(a, b\) \{/);
  // A indentação de duas posições sobrevive (dentro do <pre>, sem <br />).
  assert.match(html, /\n  return a \+ b;\n/);
  assert.match(html, /<p>Veja o exemplo:<\/p>/);
  assert.match(html, /<p>Pronto\.<\/p>/);
});

test('bloco de código em Python (o caso da captura de 24/10)', () => {
  const html = formatHtml('```python\ndef eh_par(numero):\n    return numero % 2 == 0\n\nprint(eh_par(4))\n```');
  assert.match(html, /<pre><code class="language-python">/);
  assert.match(html, /def eh_par\(numero\):/);
  assert.match(html, /    return numero % 2 == 0/);
  assert.match(html, /print\(eh_par\(4\)\)/);
});

test('títulos viram h1..h6 e não aparecem como "###"', () => {
  const html = formatHtml('### Resumo\n\nTexto.\n\n## Detalhes\n\nMais.');
  assert.match(html, /<h3>Resumo<\/h3>/);
  assert.match(html, /<h2>Detalhes<\/h2>/);
  assert.doesNotMatch(html, /###/);
});

test('barras invertidas do modelo são normalizadas (\\###, \\-, \\```)', () => {
  const entrada = '\\### Título\n\\- primeiro item\n\\- segundo item\n\\```js\nconst x = 1;\n\\```';
  const html = formatHtml(entrada);
  assert.match(html, /<h3>Título<\/h3>/);
  assert.match(html, /<li>primeiro item<\/li>/);
  assert.match(html, /<pre><code class="language-js">const x = 1;<\/code><\/pre>/);
  assert.doesNotMatch(html, /\\#/);
});

test('normalizeEscapedMarkdown não estraga caminho do Windows nem \\n literal', () => {
  const texto = 'C:\\Users\\danilo\\Kirana\\src\\server.js\nconst quebra = "\\n";';
  assert.equal(normalizeEscapedMarkdown(texto), texto);
});

test('a interface não acrescenta barras invertidas por conta própria', () => {
  const html = formatHtml('### Título\n\n- item\n\ntexto normal');
  assert.doesNotMatch(html, /\\/);
});

test('listas com e sem marcador, e quebra de linha dentro do parágrafo', () => {
  assert.match(formatHtml('- a\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(formatHtml('1. um\n2. dois'), /<ol><li>um<\/li><li>dois<\/li><\/ol>/);
  assert.match(formatHtml('linha um\nlinha dois'), /<p>linha um<br \/>linha dois<\/p>/);
});

test('tabela markdown vira <table> com cabeçalho', () => {
  const html = formatHtml('| Item | Estado |\n| --- | --- |\n| Serviços | ok |\n| Projetos | ok |');
  assert.match(html, /<table><thead><tr><th>Item<\/th><th>Estado<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>Serviços<\/td>/);
});

test('segurança: HTML do modelo é escapado, nunca injetado', () => {
  const html = formatHtml('<img src=x onerror=alert(1)> e <script>alert(2)</script>');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img/);
  assert.equal(escapeHtml('a & b < c'), 'a &amp; b &lt; c');
});

test('bloco de código aberto no meio do streaming é fechado, sem quebrar o resto', () => {
  const html = formatHtml('Começando:\n\n```js\nconst a = 1;');
  assert.match(html, /<pre><code class="language-js">const a = 1;<\/code><\/pre>/);
});

test('código inline continua funcionando e não é formatado por dentro', () => {
  const html = formatHtml('Use `**isto**` para negrito.');
  assert.match(html, /<code>\*\*isto\*\*<\/code>/);
  assert.doesNotMatch(html, /<strong>/);
});
