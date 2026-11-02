/**
 * Kirana — comandos locais de voz (v0.4.4).
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * ---------------------------
 * Até a v0.4.3 não havia NENHUM vocabulário de comando no código: toda fala
 * reconhecida virava pergunta para o modelo, e durante a resposta o microfone
 * era fechado (meia-duplex). Resultado: "Kirana, pare" não podia funcionar —
 * nem havia ouvinte, nem havia quem interpretasse a ordem.
 *
 * Este módulo é puro (sem DOM, sem rede, sem estado) para poder ser testado de
 * forma determinística, e é a ÚNICA fonte do vocabulário: o controlador de voz
 * (`public/voice.js`) só consome `isStopCommand()`.
 *
 * REGRAS (para não virar gatilho aleatório)
 * -----------------------------------------
 * 1. Sem a palavra de ativação ("Kirana"), o comando só vale quando é uma
 *    ordem CURTA e ANCORADA ("pare", "pare de falar", "pode parar", "silêncio")
 *    e apenas enquanto a Kirana está falando (`requiresWindow`). Assim "acho
 *    que o atendimento para quando o cliente reclama" não interrompe nada.
 * 2. Com a palavra de ativação, basta a ordem junto dela — inclusive no meio de
 *    uma frase ("Kirana, pode parar agora por favor").
 * 3. Perguntas não interrompem: se houver "?" ou palavra interrogativa e
 *    NENHUMA ordem forte, não é comando. "Por que o serviço para?" é pergunta.
 * 4. "para" é ambíguo em português (preposição). Só conta como ordem no fim da
 *    frase ("Kirana, para") ou seguido de "de/tudo/agora/aí/já".
 * 5. Variações de transcrição são absorvidas: acento, capitalização, pontuação
 *    e erros fonéticos do reconhecedor ("Quirana", "Kiranna", "Kirana para").
 */

/** Palavras de ativação conhecidas (normalizadas, sem acento). */
export const WAKE_WORDS = [
  'kirana',
  'quirana',
  'kiranna',
  'quiranna',
  'kyrana',
  'kyarana',
  'carina',
  'kirona',
  'kirana',
  'irana',
];

/** Ordens fortes: inequívocas mesmo sozinhas ("silêncio", "pare", "stop"). */
export const STOP_STRONG = ['pare', 'pari', 'parar', 'silencio', 'stop', 'quieta', 'quieto', 'cala', 'calar', 'chega', 'basta', 'pause'];

/** "para" é preposição em português: só conta em posição de ordem. */
export const STOP_WEAK = ['para'];

/** Palavras que podem acompanhar a ordem sem mudar o sentido. */
const CONNECTIVES = new Set(['por', 'favor', 'agora', 'ja', 'ai', 'so', 'um', 'pouco', 'ta', 'ta', 'bem', 'ok']);

/** Palavras interrogativas: transformam a frase em pergunta. */
const QUESTION_WORDS = new Set(['que', 'qual', 'quais', 'quando', 'como', 'onde', 'quem', 'quanto', 'quantos', 'quantas', 'porque', 'pq', 'sera']);

/** Distância de edição (Levenshtein), para absorver erro de transcrição. */
export function distance(a, b) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let anterior = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const atual = [i];
    for (let j = 1; j <= t.length; j += 1) {
      atual[j] = Math.min(
        anterior[j] + 1,
        atual[j - 1] + 1,
        anterior[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    }
    anterior = atual;
  }
  return anterior[t.length];
}

/**
 * Normaliza fala para comparação: sem acento, sem pontuação, minúscula,
 * espaços simples. Preserva as letras e os números.
 */
export function normalizeSpeech(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove os acentos separados pelo NFD
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // pontuação vira espaço
    .replace(/\s+/g, ' ')
    .trim();
}

/** Palavras de uma fala normalizada. */
export function words(text) {
  const normalized = normalizeSpeech(text);
  return normalized ? normalized.split(' ') : [];
}

/** Verdadeiro se o token é (ou quase é) a palavra de ativação. */
export function isWakeToken(token) {
  if (!token) return false;
  if (WAKE_WORDS.includes(token)) return true;
  // Erro fonético do reconhecedor: "Kimara", "Kirara", "Quirana" (2 edições:
  // k→q e a vogal a mais). Tokens mais longos toleram 2 edições; curtos, 1.
  if (token.length >= 5 && /^[kcqi]/.test(token)) {
    const tolerance = token.length >= 6 ? 2 : 1;
    if (distance(token, 'kirana') <= tolerance) return true;
  }
  return false;
}

/** Verdadeiro se o token é (ou quase é) uma ordem de parada. */
export function isStopToken(token) {
  if (!token) return false;
  if (STOP_STRONG.includes(token) || STOP_WEAK.includes(token)) return true;
  // "parese"? não: só variações de 1 letra de palavras fortes com 4+ letras.
  return token.length >= 4 && STOP_STRONG.some((word) => word.length >= 4 && distance(token, word) <= 1);
}

/**
 * Interpreta o miolo da frase (sem a palavra de ativação) como ordem.
 * Devolve a palavra que caracteriza a ordem, ou `null`.
 */
export function orderIn(tokens) {
  const t = tokens.filter((token) => !CONNECTIVES.has(token));
  if (!t.length) return null;
  // Negação inverte o sentido: "não pare" é pedido para CONTINUAR falando.
  if (t.some((token) => token === 'nao' || token === 'nunca' || token === 'jamais')) return null;

  // "pare" / "para" / "silêncio" sozinhos
  if (t.length === 1) {
    if (STOP_WEAK.includes(t[0])) return t[0];
    if (isStopToken(t[0])) return t[0];
    return null;
  }

  // "pare de falar", "para de falar", "pare tudo", "para agora"
  if ((STOP_STRONG.includes(t[0]) || STOP_WEAK.includes(t[0])) && ['de', 'tudo'].includes(t[1])) {
    return t[0];
  }

  // "pode parar", "pode parar tudo"
  if (t[0] === 'pode' && isStopToken(t[1])) return t[1];

  // "cala a boca", "cala boca"
  if (t[0] === 'cala' && (t[1] === 'a' || t[1] === 'boca')) return 'cala';

  // "chega disso", "para com isso"
  if (isStopToken(t[0]) && t.length <= 5) return t[0];

  // Ordem no FIM ("…, para um pouco", "espera, pare"): em português a ordem
  // costuma vir depois do vocativo, e o fim da fala é uma posição inequívoca.
  if (t.length <= 5 && (STOP_STRONG.includes(t.at(-1)) || STOP_WEAK.includes(t.at(-1)))) return t.at(-1);

  return null;
}

/**
 * Decide se uma fala é um comando de interrupção.
 *
 * @param {string} text  transcrição (final ou interina)
 * @param {{interim?: boolean}} [options]
 * @returns {{matched: boolean, kind: 'wake'|'phrase'|null, keyword: string|null,
 *            requiresWindow: boolean, reason: string}}
 *
 * `requiresWindow: true` significa: só vale como comando enquanto a Kirana está
 * falando/processando. Fora disso, é fala comum (não engolir a frase do usuário).
 */
export function isStopCommand(text, { interim = false } = {}) {
  const raw = String(text ?? '');
  const tokens = words(raw);
  const no = { matched: false, kind: null, keyword: null, requiresWindow: false, reason: 'not_a_command' };
  if (!tokens.length) return { ...no, reason: 'empty' };
  if (tokens.length > 12) return { ...no, reason: 'too_long' }; // frase longa não é ordem

  const questionish = /\?/.test(raw) || tokens.some((token) => QUESTION_WORDS.has(token));
  const wakeIndex = tokens.findIndex((token) => isWakeToken(token));

  if (wakeIndex >= 0) {
    const rest = tokens.filter((_, index) => index !== wakeIndex);
    // A ordem pode vir antes ou depois do vocativo: "Pode parar, Kirana" e
    // "Kirana, para um pouco". Olhar a frase inteira sem o vocativo cobre os
    // dois casos; a vizinhança cobre frase longa com ordem colada no nome.
    const around = tokens.slice(Math.max(0, wakeIndex - 3), wakeIndex + 4).filter((_, index, arr) => true)
      .filter((token) => !isWakeToken(token));
    const keyword = orderIn(rest) || orderIn(around);
    // Com a palavra de ativação, a ordem precisa existir — "Kirana, tudo bem?"
    // não interrompe nada.
    if (keyword) {
      return { matched: true, kind: 'wake', keyword, requiresWindow: false, reason: interim ? 'wake_interim' : 'wake' };
    }
    return { ...no, reason: 'wake_without_order' };
  }

  // Sem "Kirana": exigir ordem ancorada e curta.
  const keyword = orderIn(tokens);
  if (!keyword) {
    const trailingOnly = questionish ? null : trailingOrder(tokens);
    if (trailingOnly) {
      return { matched: true, kind: 'phrase', keyword: trailingOnly, requiresWindow: true, reason: 'trailing_order' };
    }
    return { ...no, reason: questionish ? 'question' : 'no_order' };
  }

  // "para de falar" / "pare de falar" / "pode parar" são fortes o bastante para
  // valer mesmo com "?" no fim ("Kirana, para de falar?").
  const strongPhrase = (STOP_WEAK.includes(tokens[0]) || STOP_STRONG.includes(tokens[0]) || tokens[0] === 'pode')
    && (tokens.includes('falar') || tokens.includes('tudo') || tokens.includes('isso'));
  if (questionish && !strongPhrase) return { ...no, reason: 'question_with_order' };

  // Só são aceitas ordens curtas: "silêncio", "pare agora", "pode parar".
  if (tokens.length > 5) return { ...no, reason: 'too_many_words' };

  const trailing = trailingOrder(tokens);
  if (trailing) {
    return { matched: true, kind: 'phrase', keyword: trailing, requiresWindow: true, reason: 'trailing_order' };
  }

  return {
    matched: true,
    kind: 'phrase',
    keyword,
    requiresWindow: true, // sem "Kirana", só interrompe se ela estiver falando
    reason: interim ? 'phrase_interim' : 'phrase',
  };
}

/**
 * Ordem no FIM de uma fala curta com a palavra de ativação mal reconhecida.
 *
 * O reconhecedor do navegador erra "Kirana" com frequência ("Kimara", "Quirana",
 * "Kirara"). Exigir que a palavra de ativação seja reconhecida jogaria fora
 * justamente o caso mais comum. Aqui vale a estrutura da ordem: fala curta que
 * TERMINA numa ordem inequívoca ("kimara pare", "…silêncio"), desde que não
 * haja negação ("não pare" é o contrário) e apenas na janela de fala.
 */
function trailingOrder(tokens) {
  if (!tokens.length || tokens.length > 4) return null;
  if (tokens.some((token) => token === 'nao' || token === 'nunca')) return null;
  const last = tokens.at(-1);
  if (!STOP_STRONG.includes(last) && !STOP_WEAK.includes(last)) return null;
  const head = tokens.slice(0, -1).filter((token) => !CONNECTIVES.has(token));
  // "pare" sozinho já foi tratado antes; aqui interessa o que vem ANTES.
  return head.length >= 1 && head.length <= 2 ? last : null;

  return {
    matched: true,
    kind: 'phrase',
    keyword,
    requiresWindow: true, // sem "Kirana", só interrompe se ela estiver falando
    reason: interim ? 'phrase_interim' : 'phrase',
  };
}

/**
 * O que foi ouvido enquanto ela fala é FALA DO USUÁRIO por cima da dela?
 *
 * Só é com folga: pelo menos `minWords` palavras, `minNovelWords` delas e a fração
 * `minNovelty` AUSENTES do que a Kirana está dizendo. Eco com erros de reconhecimento troca poucas palavras
 * e fica abaixo disso; uma pergunta nova do usuário quase não compartilha palavras
 * com a resposta. Errar para o lado do "não interromper" é o desejado: interromper
 * a si mesma por causa do próprio eco é o defeito que esta guarda existe para evitar.
 */
export function isUserSpeechOverSpeech(candidate, spoken, { minWords = 4, minNovelWords = 3, minNovelty = 0.6 } = {}) {
  const candidateWords = words(candidate);
  if (candidateWords.length < minWords) return false;
  if (isEchoOf(candidate, spoken)) return false;
  const spokenWords = tokenSet(spoken);
  const novel = candidateWords.filter((word) => !spokenWords.has(word)).length;
  // Palavras funcionais ("o", "para") coincidem por acaso, então a proporção sozinha
  // engana: também se exige um número mínimo de palavras novas.
  return novel >= minNovelWords && novel / candidateWords.length >= minNovelty;
}

/** Palavras de uma transcrição, para comparação de eco. */
export function tokenSet(text) {
  return new Set(words(text));
}

/**
 * A fala reconhecida é, provavelmente, a própria voz da Kirana voltando pelo
 * alto-falante? Compara com o que ela está falando neste turno.
 *
 * Usado como proteção de autoescuta: mesmo com o microfone aberto durante a
 * resposta (necessário para o barge-in), nada do que ela mesma diz pode virar
 * comando ou mensagem.
 */
export function isEchoOf(candidate, spoken) {
  const candidateWords = words(candidate);
  const spokenWords = tokenSet(spoken);
  if (!spokenWords.size || candidateWords.length === 0) return false;

  const normalizedCandidate = normalizeSpeech(candidate);
  const normalizedSpoken = normalizeSpeech(spoken);

  // (1) CONTENÇÃO — o critério principal, e o mais seguro.
  //
  // correção pós-0.5.3 — antes, um fragmento de 1 ou 2 palavras do próprio TTS passava
  // limpo: a regra de sobreposição exigia `candidateWords.length >= 3` e a de
  // contenção exigia 6 caracteres. Era por aí que a cauda do alto-falante
  // ("posso ajudar", "ajudar você") virava mensagem do usuário e reiniciava o
  // ciclo de autoescuta. Se o que o microfone ouviu está DENTRO do que a
  // Kirana acabou de falar, é eco — não importa o tamanho.
  if (normalizedCandidate.length >= 6 && normalizedSpoken.includes(normalizedCandidate)) return true;
  // 1 palavra: só é eco se ela estiver falando essa palavra agora. Sem isso,
  // "pare" sozinho — o comando mais comum — seria descartado.
  if (candidateWords.length === 1) return spokenWords.has(candidateWords[0]) && candidateWords[0].length >= 4;

  // (2) SOBREPOSIÇÃO — para transcrições imperfeitas (o reconhecedor erra
  // palavras). Vale a partir de 2 palavras: duas palavras certas em duas é
  // eco; em uma fala nova do usuário dificilmente as duas coincidem.
  const overlap = candidateWords.filter((word) => spokenWords.has(word)).length / candidateWords.length;
  if (candidateWords.length >= 3) return overlap >= 0.8;
  return overlap >= 1 && normalizedCandidate.length >= 8;
}
