/**
 * Limpeza de texto para síntese de fala (TTS).
 *
 * Portado de `edge-tts-adapter.js` do patch Thalita v0.4.0 (reaproveitado,
 * não copiado às cegas: aqui vira módulo puro, testável e sem DOM).
 *
 * Regra de ouro: o texto do CHAT NUNCA é alterado. Esta função só produz a
 * versão falada — o histórico guarda o original com emojis e markdown.
 */

/** Limite de caracteres enviados ao motor de voz (proteção de custo/abuso). */
export const MAX_SPEECH_CHARS = 3000;

/** Nomes de emoji comuns que valem ser falados? Não: removidos. */

/**
 * @param {string} value texto original (markdown, emojis, links…)
 * @returns {string} texto pronto para fala (frases, sem marcação)
 */
export function sanitizeTextForSpeech(value) {
  let text = String(value ?? '');

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
  // Emojis, bandeiras, seletores de variação, ZWJ e keycaps.
  text = text.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0E\uFE0F\u200D\u20E3]/gu, '');
  // Símbolos que o sintetizador leria de forma estranha.
  text = text.replace(/[#*|]/g, ' ');
  // Espaços e pontuação.
  text = text.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1');

  // Não trunca: perder o fim de uma frase em silêncio seria pior que recusar.
  // O limite é aplicado (e recusado com erro claro) em `tts.js`.
  return text.trim();
}

/** Texto útil para fala? (evita mandar "😊" ou markdown vazio ao motor). */
export function hasSpeakableContent(text) {
  const clean = sanitizeTextForSpeech(text);
  // Precisa de ao menos uma letra ou número.
  return /[\p{L}\p{N}]/u.test(clean);
}
