/**
 * Limpeza de texto para síntese de fala (TTS).
 *
 * Regra de ouro: o texto do CHAT NUNCA é alterado. Esta função só produz a
 * versão falada — o histórico guarda o original com emojis e markdown.
 *
 * ── Política de caracteres (v0.4.1) ──────────────────────────────────────────
 * A v0.4.0 removia emojis por categoria Unicode (`\p{Extended_Pictographic}`),
 * o que deixava passar símbolos que o motor de voz FALA EM VOZ ALTA com um
 * nome totalmente diferente do texto. Medido com o provedor real (Thalita):
 *
 *   £  -> +4608 bytes de áudio  (lido como "libra"/"libras" em pt-BR)
 *   ♎  -> +5184 bytes           (nome do signo)
 *   ⚖️ -> +8064 bytes
 *   ©  -> +3600 bytes,  ™ -> +3888 bytes,  ✅ -> +5760 bytes
 *
 * Era essa a origem da palavra "Libra" ao fim de frases: um caractere
 * invisível-para-o-leitor no texto exibido, mas audível na fala.
 *
 * Por isso a partir da v0.4.1 usa-se LISTA DE PERMISSÃO: só letras, números,
 * marcas de acentuação, espaço e uma pontuação fechada chegam ao motor.
 * Qualquer outro caractere é substituído por espaço (nunca removido no meio de
 * uma palavra sem separador). O que sobra é auditável: `analyzeSpeechText()`
 * informa exatamente o que foi descartado.
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
 * Seletores de variação (U+FE0E/U+FE0F, keycap U+20E3 e U+E0100–U+E01EF) são "marcas
 * combinantes" para o Unicode, mas na prática são invisíveis e ficam órfãos
 * quando o emoji que os acompanhava é removido — por isso são recusados aqui,
 * antes da regra geral de marcas.
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
 * @param {string} value texto original (markdown, emojis, links…)
 * @returns {string} texto pronto para fala (frases, sem marcação)
 */
export function sanitizeTextForSpeech(value) {
  let text = String(value ?? '');

  // --- 1. estruturais: blocos que não devem ser lidos ---------------------
  // Blocos de código: removidos por completo (não devem ser lidos).
  text = text.replace(/```[\s\S]*?```/g, ' ');
  // Código inline: mantém o conteúdo, sem as crases.
  text = text.replace(/`([^`]*)`/g, '$1');
  // Imagens markdown -> alt; links -> rótulo.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // URLs soltas.
  text = text.replace(/https?:\/\/\S+|www\.\S+/g, ' ');
  // HTML.
  text = text.replace(/<[^>]+>/g, ' ');
  // Títulos, citações, listas e numeração no início da linha.
  text = text.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '');
  // Ênfase e riscado.
  text = text.replace(/[*_~]{1,3}/g, '');
  // Tabelas markdown: remove as barras, mantém as células.
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_, cells) => cells.replace(/\s*\|\s*/g, ', '));
  // Separadores horizontais.
  text = text.replace(/^\s*([-*_]\s*){3,}$/gm, ' ');

  // --- 2. política de caracteres (lista de permissão) --------------------
  let dropped = 0;
  let out = '';
  for (const char of text) {
    if (isSpeakableChar(char)) {
      out += char;
    } else {
      // Vira espaço: separa palavras em vez de colá-las, e nunca é falado.
      out += ' ';
      dropped += 1;
    }
  }

  // --- 3. espaços e pontuação -------------------------------------------
  out = out
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([,;:])(\s*)([,;:])+/g, '$1')
    .trim();

  return out;
}

/**
 * Diagnóstico da limpeza: o que vai ser falado e o que foi descartado.
 * Usado pela instrumentação (`text_sent_to_tts`) e pelos testes.
 *
 * @param {string} value texto original
 * @returns {{text: string, chars: number, dropped: number, droppedChars: string[]}}
 */
export function analyzeSpeechText(value) {
  const raw = String(value ?? '');
  const text = sanitizeTextForSpeech(raw);
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
  const clean = sanitizeTextForSpeech(text);
  // Precisa de ao menos uma letra ou número.
  return /[\p{L}\p{N}]/u.test(clean);
}

/**
 * Garante que nada fora da política chegue ao motor (última barreira).
 * Retorna `null` quando o texto é seguro. Usado no servidor antes do worker.
 */
export function findUnspeakableChars(text) {
  const bad = [];
  for (const char of String(text ?? '')) {
    if (!isSpeakableChar(char)) bad.push(char);
  }
  return bad.length ? bad : null;
}
