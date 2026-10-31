/**
 * Renderizador Markdown da interface da Kirana — mínimo, seguro, sem dependências.
 *
 * correção pós-0.5.3 — extraído de `public/app.js` para poder ser testado fora do navegador.
 *
 * O que o defeito relatado mostrou (código e títulos com `\###`, `\-`, ` ``` `
 * visíveis na tela):
 *
 *   1. O renderizador antigo tratava apenas `**negrito**`, `*itálico*`, código
 *      INLINE e listas. Bloco de código (` ``` `) e título (`#`) não existiam:
 *      as três crases e o jogo-da-velha apareciam como texto, e o código de
 *      várias linhas era esmagado dentro de um `<p>` com `<br />`.
 *   2. A interface NUNCA acrescenta barras invertidas — a checagem está no
 *      teste. As barras vinham no TEXTO DO MODELO (modelo "escapando" markdown
 *      para não ser interpretado). Como o texto vai para a fala e para a cópia,
 *      a barra sobrava na tela. Aqui elas são normalizadas na renderização
 *      (`normalizeEscapedMarkdown`), sem alterar o que fica salvo na sessão.
 *
 * Segurança: tudo é escapado ANTES de qualquer formatação, e o HTML produzido
 * só usa tags de uma lista fixa. Nada de `innerHTML` com texto do modelo cru.
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Remove a barra invertida que o modelo coloca antes de marcadores de markdown
 * (`\###`, `\-`, `\*\*`, ``\``` ``). Só mexe em marcadores no início de linha ou
 * em pares de formatação — `C:\Users\danilo` e `\n` dentro de código ficam como
 * estão.
 */
export function normalizeEscapedMarkdown(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\\(\s*)(#{1,6}\s)/, '$1$2') // \### Título
        .replace(/^\\(\s*)([-*+]\s)/, '$1$2') // \- item
        .replace(/^\\(\s*)(\d+[.)]\s)/, '$1$2') // \1. item
        .replace(/^\\(\s*)(```)/, '$1$2') // \``` bloco
        .replace(/^\\(\s*)(>\s)/, '$1$2'), // \> citação
    )
    .join('\n')
    .replace(/\\([*_`~])/g, '$1');
}

const CODE_FENCE = /^\s*(\\)?```\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*•]\s+/;
const ORDERED = /^\s*\d+[.)]\s+/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function inlineHtml(line) {
  // A ordem importa: código inline primeiro (o conteúdo dele não é formatado),
  // depois negrito, itálico e links.
  const parts = [];
  const guardado = (html) => `\u0000${parts.push(html) - 1}\u0000`;
  let working = line.replace(/`([^`]+)`/g, (_m, code) => guardado(`<code>${escapeHtml(code)}</code>`));
  working = escapeHtml(working);
  working = working
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/(https?:\/\/[^\s<)"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  return working.replace(/\u0000(\d+)\u0000/g, (_m, index) => parts[Number(index)]);
}

function tableHtml(rows) {
  const cells = (row) =>
    row
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => cell.trim());
  const head = cells(rows[0]);
  const body = rows.slice(1).map(cells).filter((r) => r.some((c) => c !== ''));
  const thead = `<thead><tr>${head.map((c) => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>`
    : '';
  return `<table>${thead}${tbody}</table>`;
}

/**
 * Markdown → HTML. Blocos suportados: parágrafo, título (#..######), lista com e
 * sem marcador, citação, tabela e BLOCO DE CÓDIGO com a linguagem preservada.
 * Quebras de linha dentro do parágrafo viram `<br />`; dentro do bloco de código
 * são preservadas literalmente.
 */
export function formatHtml(text) {
  const source = normalizeEscapedMarkdown(text);
  const lines = source.split(/\r?\n/);
  const out = [];
  let paragraph = [];
  let list = null; // { type: 'ul' | 'ol', items: [] }
  let code = null; // { lang, lines: [] }

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.map(inlineHtml).join('<br />')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.type}>${list.items.map((item) => `<li>${inlineHtml(item)}</li>`).join('')}</${list.type}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // --- bloco de código ---------------------------------------------------
    if (code) {
      if (/^\s*(\\)?```/.test(line)) {
        const lang = code.lang ? ` class="language-${escapeHtml(code.lang)}"` : '';
        out.push(`<pre><code${lang}>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    const fence = line.match(CODE_FENCE);
    if (fence) {
      flushParagraph();
      flushList();
      code = { lang: fence[2] || '', lines: [] };
      continue;
    }

    // --- linha vazia: fecha blocos ----------------------------------------
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    // --- título ------------------------------------------------------------
    const heading = line.match(HEADING);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length, 6);
      out.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`);
      continue;
    }

    // --- citação -----------------------------------------------------------
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${inlineHtml(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }

    // --- tabela ------------------------------------------------------------
    if (TABLE_ROW.test(line) && TABLE_SEP.test(lines[i + 1] ?? '')) {
      flushParagraph();
      flushList();
      const rows = [line];
      i += 2; // pula o separador
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(lines[i]);
        i += 1;
      }
      i -= 1;
      out.push(tableHtml(rows));
      continue;
    }

    // --- listas ------------------------------------------------------------
    if (BULLET.test(line)) {
      flushParagraph();
      if (list?.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(line.replace(BULLET, ''));
      continue;
    }
    if (ORDERED.test(line)) {
      flushParagraph();
      if (list?.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(line.replace(ORDERED, ''));
      continue;
    }

    // --- texto comum -------------------------------------------------------
    flushList();
    paragraph.push(line);
  }

  // Bloco de código não fechado (streaming interrompido): fecha mesmo assim.
  if (code) {
    const lang = code.lang ? ` class="language-${escapeHtml(code.lang)}"` : '';
    out.push(`<pre><code${lang}>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
  }
  flushParagraph();
  flushList();
  return out.join('');
}
