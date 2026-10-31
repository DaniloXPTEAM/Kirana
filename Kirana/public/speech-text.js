/**
 * Texto falado da Kirana — módulo único, usado pelos DOIS motores (v0.4.3).
 *
 * ── Por que este arquivo existe ─────────────────────────────────────────────
 * Na v0.4.2 só o **servidor** limpava o texto: `src/voice/tts-text.js` rodava
 * dentro de `/api/voice/tts`. Quando o motor do **navegador** passou a ser o
 * padrão, o texto cru do modelo ia direto para `speechSynthesis.speak()` — e a
 * voz do Windows leu os asteriscos de `**negrito**` em voz alta. Era um caminho
 * novo com a limpeza esquecida.
 *
 * Correção estrutural: a limpeza virou este módulo (ESM puro, sem dependências),
 * importado pelo navegador (`public/voice.js`) e pelo servidor
 * (`src/voice/tts-text.js`, que o worker Python espelha). Uma implementação,
 * três usuários, nenhuma divergência possível.
 *
 * ── Regra de ouro ───────────────────────────────────────────────────────────
 * O texto EXIBIDO nunca é alterado. Este módulo só produz a versão falada:
 * markdown vira conteúdo (sem marcadores), código de bloco não é lido, link
 * vira o rótulo, emoji não é lido, acento e pontuação natural permanecem.
 *
 *   "**Modelo utilizado:** GPT-6."        -> "Modelo utilizado: GPT-6."
 *   "## Serviços\n- WhatsApp\n- CRM"      -> "Serviços WhatsApp CRM"
 *   "Veja [o site](https://x.com)."       -> "Veja o site."
 *   "R$ 1.500,00 (30%) — 2ª feira"        -> igual (nada é destruído)
 */

/** Limite de caracteres enviados ao motor de voz (proteção de custo/abuso). */
export const MAX_SPEECH_CHARS = 3000;

/**
 * Pontuação permitida na fala. Verificada uma a uma contra o motor real:
 * nenhuma delas produz palavra extra (`.` e `,` só ajustam pausa; `%`, `$` e
 * `°` são lidos corretamente como "por cento", "reais" e "graus").
 */
const ALLOWED_PUNCTUATION = new Set([...'.,;:!?\'"()[]{}«»-–—…%/$°']);

/**
 * Seletores de variação (U+FE0E/U+FE0F, keycap U+20E3 e U+E0100–U+E01EF) são
 * "marcas combinantes" para o Unicode, mas invisíveis: ficam órfãos quando o
 * emoji que os acompanhava é removido. Recusados antes da regra geral de marcas.
 */
const VARIATION_SELECTOR = /^[\uFE00-\uFE0F\u20E3\u{E0100}-\u{E01EF}]$/u;

/** Um caractere pode ser falado? */
export function isSpeakableChar(char) {
  if (ALLOWED_PUNCTUATION.has(char)) return true;
  if (/\s/u.test(char)) return true;
  if (VARIATION_SELECTOR.test(char)) return false;
  // Letras (inclui ª e º), números e marcas combinantes (acentos decompostos).
  return /[\p{L}\p{N}\p{M}]/u.test(char);
}

/**
 * Marcadores de formatação que o motor de voz lê em voz alta quando sobram.
 * Lista fechada e explícita (não um `[*_~]` genérico) para não destruir hífens,
 * travessões ou o `*` que faz parte de um cálculo escrito no texto.
 */
const FORMAT_CHARS = /[*_~`#|>]/gu;

/**
 * @param {string} value texto original (markdown, emojis, links…)
 * @param {object} [options]
 * @param {boolean} [options.keepUrls] manter URLs por extenso (padrão: remover,
 *   porque uma URL é soletrada letra por letra)
 * @returns {string} texto pronto para fala
 */
export function toSpeechText(value, { keepUrls = false } = {}) {
  let text = String(value ?? '');

  // --- 1. blocos que não devem ser lidos em voz alta ----------------------
  // Código de bloco: sai inteiro (inclusive o conteúdo: ninguém quer ouvir
  // "const x igual a 1 ponto e vírgula").
  text = text.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  text = text.replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ');

  // --- 2. markdown inline ------------------------------------------------
  // Imagens -> texto alternativo; links -> rótulo (a URL não é falada).
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Links em estilo de referência e autolinks.
  text = text.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, keepUrls ? '$1' : ' ');
  // Código inline: mantém o conteúdo, sem as crases.
  text = text.replace(/`([^`]*)`/g, '$1');
  // HTML.
  text = text.replace(/<[^>]+>/g, ' ');

  // --- 3. estrutura de linha --------------------------------------------
  // Linha separadora de tabela (|---|---|): sai antes, senão viraria "traço,
  // traço" na fala.
  text = text.replace(/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, ' ');
  // Cercas de tabela: as barras verticais viram pausa, as células ficam.
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_, cells) => ` ${cells.replace(/\s*\|\s*/g, ', ')} `);
  // Separadores horizontais.
  text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' . ');
  // Títulos ATX (#, ##…): o texto fica, a marcação sai.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  // Citações (>).
  text = text.replace(/^\s{0,3}>+\s?/gm, '');
  // Listas com marcador ou numeradas: o item vira fala; `*` de lista não pode
  // ser confundido com ênfase, por isso esta regra vem antes.
  text = text.replace(/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/gm, '');
  // Restos de marcador no início de linha (ex.: "* " solto após o passo acima).
  text = text.replace(/^\s*[*+]\s+/gm, '');

  // --- 4. URLs soltas ----------------------------------------------------
  if (!keepUrls) text = text.replace(/(?:https?:\/\/|www\.)\S+/gi, ' ');

  // --- 5. sobras de formatação ------------------------------------------
  // Aqui já não existe asterisco legítimo: todos viraram espaço. O hífen e o
  // travessão NÃO estão nesta lista (são pontuação falável).
  text = text.replace(FORMAT_CHARS, ' ');

  // --- 6. política de caracteres (lista de permissão) --------------------
  let out = '';
  for (const char of text) out += isSpeakableChar(char) ? char : ' ';

  // --- 7. espaços e pontuação natural -----------------------------------
  out = out
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    // depois de um `.` não pode sobrar espaço antes de um ponto duplicado
    .replace(/\.{2,}(?!\.)/g, '.')
    .trim();

  return out;
}

/**
 * Diagnóstico da limpeza: o que vai ser falado e o que foi descartado.
 * @param {string} value texto original
 */
export function analyzeSpeechText(value) {
  const raw = String(value ?? '');
  const text = toSpeechText(raw);
  const droppedChars = [];
  const seen = new Set();
  for (const char of raw) {
    if (isSpeakableChar(char)) continue;
    const key = `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    droppedChars.push(`${key} ${JSON.stringify(char)}`);
  }
  return {
    text,
    chars: text.length,
    dropped: Math.max(0, [...raw].length - [...text].length),
    droppedChars,
  };
}

/** Texto útil para fala? (evita mandar "😊" ou markdown vazio ao motor). */
export function hasSpeakableContent(text) {
  return /[\p{L}\p{N}]/u.test(toSpeechText(text));
}

/**
 * Garante que nada fora da política chegue ao motor (última barreira).
 * Retorna `null` quando o texto é seguro.
 */
export function findUnspeakableChars(text) {
  const bad = [];
  for (const char of String(text ?? '')) {
    if (!isSpeakableChar(char)) bad.push(char);
  }
  return bad.length ? bad : null;
}

/** Marcadores de formatação que ainda restaram (deve ser sempre vazio). */
export function findLeftoverMarkers(text) {
  const found = [];
  for (const char of String(text ?? '')) {
    if (FORMAT_CHARS.test(char)) found.push(char);
    FORMAT_CHARS.lastIndex = 0; // a regex tem /g: não carregar estado entre chars
  }
  return found.length ? [...new Set(found)] : null;
}
