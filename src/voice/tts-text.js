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
 *
 * ── v0.4.3: implementação única, compartilhada com o navegador ──────────────
 * A limpeza passou a viver em `public/speech-text.js`, que é importado aqui e
 * também pelo cliente. Motivo: na v0.4.2 o motor do navegador falava o texto
 * CRU (a limpeza só existia no servidor) e a voz do Windows lia os asteriscos
 * de `**negrito**`. Uma implementação só, usada pelos dois motores, elimina a
 * possibilidade de divergirem de novo.
 */

import {
  MAX_SPEECH_CHARS as SHARED_MAX_SPEECH_CHARS,
  analyzeSpeechText,
  findLeftoverMarkers,
  findUnspeakableChars,
  hasSpeakableContent as sharedHasSpeakableContent,
  isSpeakableChar,
  toSpeechText,
} from '../../public/speech-text.js';

/** Limite de caracteres enviados ao motor de voz (proteção de custo/abuso). */
export const MAX_SPEECH_CHARS = SHARED_MAX_SPEECH_CHARS;

/**
 * Texto pronto para fala: markdown vira conteúdo, emoji e símbolos saem,
 * acento e pontuação natural ficam. Mesma função usada pelo navegador.
 */
export function sanitizeTextForSpeech(value) {
  return toSpeechText(value);
}

/** Texto útil para fala? (evita mandar "😊" ou markdown vazio ao motor). */
export function hasSpeakableContent(text) {
  return sharedHasSpeakableContent(text);
}

export { analyzeSpeechText, findLeftoverMarkers, findUnspeakableChars, isSpeakableChar, toSpeechText };
