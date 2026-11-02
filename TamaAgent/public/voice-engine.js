/**
 * Motores de síntese de voz da Kirana (v0.4.2).
 *
 * Existem dois caminhos, e o usuário escolhe qual usar:
 *
 *  1. `browser` — `window.speechSynthesis` do navegador/SO. É o caminho que o
 *     laboratório Voice (porta 1456) usa para a Francisca: NÃO abre processo
 *     Python, NÃO faz chamada de rede, e a fala começa em ~100–300 ms depois de
 *     `speak()`. Em troca, as vozes dependem do que o navegador/SO oferece
 *     (no Windows/Edge existem as vozes "Online (Natural)" em pt-BR).
 *
 *  2. `edge` — worker Python `edge-tts` no servidor (Thalita Neural, etc.).
 *     Funciona em qualquer navegador, mas custa o processo Python + a conexão
 *     com o serviço da Microsoft antes do primeiro som.
 *
 * Regra de escolha (`auto`): se o navegador expõe pelo menos uma voz pt-BR,
 * usa-se o navegador; senão, o servidor. A preferência do usuário é lembrada em
 * localStorage e nunca impede a conversa: se a voz escolhida sumir, o motor cai
 * para outra voz do mesmo motor, depois para o outro motor.
 *
 * Este arquivo NÃO sabe nada de microfone, turno ou fila — isso continua em
 * `public/voice.js`.
 */

import { toSpeechText } from './speech-text.js';

export const ENGINE = { BROWSER: 'browser', EDGE: 'edge', AUTO: 'auto' };

export const VOICE_PREF_KEY = 'kirana.voz.preferencias.v1';

/** Texto curto para prévia (não usa a conversa nem gasta chamada ao modelo). */
export const PREVIEW_TEXT = 'Olá! Esta é a minha voz na Kirana. As eleições aconteceram normalmente.';

/** Nome/URI que identificam as vozes preferidas, em ordem de preferência. */
export const PREFERRED_VOICE_PATTERNS = [/francisca/i, /thalita/i, /maria/i, /helena/i, /antonio/i, /daniel/i];

/**
 * O padrão do Windows para stdio de processo filho é a página de código ANSI,
 * por isso as taxas são números (o `speechSynthesis` usa 0.1–10) e não strings.
 */
export function rateToNumber(rate) {
  if (typeof rate === 'number' && Number.isFinite(rate)) return clampRate(rate);
  const match = /^\s*([+-]?\d+(?:\.\d+)?)\s*%?\s*$/.exec(String(rate ?? ''));
  if (!match) return 1;
  const percent = Number(match[1]);
  return clampRate(1 + percent / 100);
}

function clampRate(value) {
  return Math.min(2, Math.max(0.5, Number(value.toFixed(2))));
}

/** Converte a taxa do `speechSynthesis` de volta para a notação `+8%`. */
export function rateToPercent(value) {
  const percent = Math.round((rateToNumber(value) - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

function ptBr(voice) {
  return /^pt[-_]br$/i.test(String(voice?.lang ?? ''));
}

function ptAny(voice) {
  return /^pt([-_]|$)/i.test(String(voice?.lang ?? ''));
}

function normalizeBrowserVoice(voice) {
  return {
    id: `browser:${voice.voiceURI || voice.name}`,
    engine: ENGINE.BROWSER,
    name: voice.name,
    label: `${voice.name} (${voice.lang})${voice.localService ? ' · local' : ' · online'}`,
    lang: voice.lang,
    local: Boolean(voice.localService),
    isDefault: Boolean(voice.default),
    raw: voice,
  };
}

function normalizeEdgeVoice(voice) {
  // `edge:pt-BR-ThalitaMultilingualNeural` — o mesmo formato cobre o worker.
  const shortName = voice.shortName ?? voice.id;
  return {
    id: `edge:${shortName}`,
    engine: ENGINE.EDGE,
    name: shortName,
    label: edgeVoiceLabel(shortName),
    lang: voice.locale ?? voice.lang ?? 'pt-BR',
    local: false,
    isDefault: false,
    raw: voice,
  };
}

const EDGE_LABELS = {
  'pt-BR-ThalitaMultilingualNeural': 'Thalita Multilingual Neural',
  'pt-BR-FranciscaNeural': 'Francisca Neural',
  'pt-BR-AntonioNeural': 'Antônio Neural',
  'pt-BR-BrendaNeural': 'Brenda Neural',
  'pt-BR-DonatoNeural': 'Donato Neural',
  'pt-BR-ElzaNeural': 'Elza Neural',
  'pt-BR-FabioNeural': 'Fábio Neural',
  'pt-BR-GiovannaNeural': 'Giovanna Neural',
  'pt-BR-HumbertoNeural': 'Humberto Neural',
  'pt-BR-JulioNeural': 'Júlio Neural',
  'pt-BR-LeilaNeural': 'Leila Neural',
  'pt-BR-LeticiaNeural': 'Letícia Neural',
  'pt-BR-ManuelaNeural': 'Manuela Neural',
  'pt-BR-NicolauNeural': 'Nicolau Neural',
  'pt-BR-ThalitaNeural': 'Thalita Neural',
  'pt-BR-ValerioNeural': 'Valério Neural',
  'pt-BR-YaraNeural': 'Yara Neural',
};

function edgeVoiceLabel(shortName) {
  return `${EDGE_LABELS[shortName] ?? shortName} — servidor (edge-tts)`;
}

/**
 * Normaliza a resposta de `GET /api/voice/voices`.
 *
 * Tolerante de propósito: aceita `{ shortName }` (formato do worker) mesmo sem
 * o campo `engine`, para que uma versão antiga do servidor não esvazie a lista.
 */
export function normalizeServerVoices(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && (item.shortName || item.id))
    .map((item) => normalizeEdgeVoice(item));
}

/* --------------------------- preferência salva ---------------------------- */

export function loadPreference(storage) {
  try {
    const raw = storage?.getItem?.(VOICE_PREF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const engine = [ENGINE.AUTO, ENGINE.BROWSER, ENGINE.EDGE].includes(parsed.engine) ? parsed.engine : ENGINE.AUTO;
    return {
      engine,
      voiceId: typeof parsed.voiceId === 'string' ? parsed.voiceId : null,
      rate: typeof parsed.rate === 'string' ? parsed.rate : '+0%',
    };
  } catch {
    return null; // storage bloqueado/JSON inválido: volta ao padrão
  }
}

export function savePreference(storage, preference) {
  try {
    storage?.setItem?.(
      VOICE_PREF_KEY,
      JSON.stringify({ engine: preference.engine ?? ENGINE.AUTO, voiceId: preference.voiceId ?? null, rate: preference.rate ?? '+0%' }),
    );
    return true;
  } catch {
    return false; // modo privado/cota: a sessão continua, só não persiste
  }
}

/**
 * Escolhe a voz a usar. Ordem:
 *   1. a voz salva (se ainda existir);
 *   2. Francisca, Thalita, ... (padrões de preferência), na ordem;
 *   3. a voz pt-BR marcada como padrão;
 *   4. qualquer pt-BR; 5. qualquer pt; 6. a primeira da lista.
 */
export function pickVoice(voices, { voiceId = null, engine = null } = {}) {
  const pool = engine ? voices.filter((voice) => voice.engine === engine) : voices.slice();
  if (!pool.length) return null;
  if (voiceId) {
    const saved = pool.find((voice) => voice.id === voiceId);
    if (saved) return saved;
  }
  const ptBrPool = pool.filter((voice) => ptBr(voice));
  for (const pattern of PREFERRED_VOICE_PATTERNS) {
    const match = ptBrPool.find((voice) => pattern.test(`${voice.name} ${voice.raw?.voiceURI ?? ''}`));
    if (match) return match;
  }
  return ptBrPool.find((voice) => voice.isDefault) ?? ptBrPool[0] ?? pool.find((voice) => ptAny(voice)) ?? pool[0];
}

/* ----------------------- motor do navegador (SpeechSynthesis) ------------- */

/**
 * @param {object} options
 * @param {object} [options.host]            `window` (injetável nos testes)
 * @param {Function} [options.now]           relógio (ms)
 * @param {object} [options.logger]
 * @param {number} [options.voicesTimeoutMs] espera pelo catálogo assíncrono
 */
export function createBrowserSpeechEngine({ host = globalThis, now = () => Date.now(), logger = console, voicesTimeoutMs = 2500 } = {}) {
  const synthesis = host.speechSynthesis ?? null;
  const Utterance = host.SpeechSynthesisUtterance ?? null;
  let voicesPromise = null;
  let current = null; // { utterance, resolve, cancelled }

  const available = () => Boolean(synthesis && Utterance && typeof synthesis.speak === 'function');

  function readVoices() {
    try {
      return (synthesis?.getVoices?.() ?? []).map(normalizeBrowserVoice);
    } catch (error) {
      logger.debug?.('[voz] não foi possível listar as vozes do navegador', error?.message);
      return [];
    }
  }

  /**
   * O Chrome/Edge entregam a lista vazia na primeira chamada e disparam
   * `voiceschanged` depois. Sem esperar por isso, escolher voz no início da
   * sessão cairia sempre no motor do servidor.
   */
  function waitForVoices({ timeoutMs = voicesTimeoutMs } = {}) {
    if (!available()) return Promise.resolve([]);
    const immediate = readVoices();
    if (immediate.length) return Promise.resolve(immediate);
    if (voicesPromise) return voicesPromise;
    voicesPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (voices) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        synthesis?.removeEventListener?.('voiceschanged', onChange);
        voicesPromise = null;
        resolve(voices);
      };
      const onChange = () => {
        const voices = readVoices();
        if (voices.length) finish(voices);
      };
      const timer = setTimeout(() => finish(readVoices()), timeoutMs);
      synthesis?.addEventListener?.('voiceschanged', onChange);
      // Alguns navegadores só populam depois de um tick.
      host.setTimeout?.(onChange, 0);
    });
    return voicesPromise;
  }

  /** Lista as vozes do navegador (pt-* primeiro). */
  async function listVoices() {
    const voices = await waitForVoices();
    const ordered = [...voices.filter(ptBr), ...voices.filter((voice) => ptAny(voice) && !ptBr(voice)), ...voices.filter((voice) => !ptAny(voice))];
    return ordered;
  }

  /**
   * Fala um trecho. Resolve quando o áudio termina, rejeita em erro real.
   * Cancelamento não é erro: resolve com `{ cancelled: true }`.
   */
  function speak(text, { voice = null, rate = 1, pitch = 1, onStart, onEnd, lang = 'pt-BR', sanitize = true } = {}) {
    if (!available()) return Promise.reject(Object.assign(new Error('Este navegador não fala texto.'), { code: 'voice_browser_unsupported' }));
    // Segunda barreira (a primeira é o controlador): nada de markdown chega ao
    // motor, porque o `speechSynthesis` lê asterisco, cerquilha e barra em voz
    // alta. A limpeza é idempotente, então rodar duas vezes não muda o texto.
    const clean = String(sanitize ? toSpeechText(text) : text ?? '').trim();
    if (!clean) return Promise.resolve({ cancelled: true, empty: true });

    // Um utterance por vez: nada de sobrepor a resposta anterior.
    cancel();

    const utterance = new Utterance(clean);
    const raw = voice?.raw ?? voice;
    if (raw) {
      utterance.voice = raw;
      utterance.lang = raw.lang || lang;
    } else {
      utterance.lang = lang;
    }
    utterance.rate = rateToNumber(rate);
    utterance.pitch = Math.min(2, Math.max(0, Number(pitch) || 1));

    let resolveFn;
    const done = new Promise((resolve) => {
      resolveFn = resolve;
    });
    const entry = { utterance, resolve: resolveFn, cancelled: false, startedAt: now(), started: null };
    current = entry;

    const settle = (value) => {
      if (current === entry) current = null;
      resolveFn(value);
    };

    utterance.onstart = () => {
      entry.started = now();
      try {
        onStart?.({ at: entry.started });
      } catch (error) {
        logger.debug?.('[voz] onStart falhou', error?.message);
      }
    };
    utterance.onend = () => {
      const value = { cancelled: entry.cancelled, started: entry.started, ended: now() };
      try {
        onEnd?.(value);
      } catch (error) {
        logger.debug?.('[voz] onEnd falhou', error?.message);
      }
      settle(value);
    };
    utterance.onerror = (event) => {
      const code = event?.error || 'voice_browser_error';
      if (entry.cancelled || code === 'canceled' || code === 'interrupted') {
        settle({ cancelled: true, started: entry.started, ended: now() });
        return;
      }
      const error = Object.assign(new Error(browserErrorMessage(code)), { code: `voice_browser_${code}` });
      if (current === entry) current = null;
      resolveFn({ error, started: entry.started, ended: now() });
    };

    try {
      synthesis.speak(utterance);
    } catch (error) {
      if (current === entry) current = null;
      resolveFn({ error: Object.assign(new Error(error?.message || 'Falha ao falar.'), { code: 'voice_browser_failed' }) });
    }
    return done;
  }

  function cancel() {
    if (!current) {
      try {
        synthesis?.cancel?.();
      } catch {
        /* ignora */
      }
      return false;
    }
    const entry = current;
    entry.cancelled = true;
    current = null;
    try {
      synthesis?.cancel?.();
    } catch {
      /* ignora */
    }
    entry.resolve({ cancelled: true, started: entry.started, ended: now() });
    return true;
  }

  return {
    id: 'browser-speech-synthesis',
    engine: ENGINE.BROWSER,
    available,
    listVoices,
    pickVoice: (options) => pickVoice(readVoices(), options),
    speak,
    cancel,
    get speaking() {
      return Boolean(current) || Boolean(synthesis?.speaking);
    },
    /** Usado pelo diagnóstico: qual voz está de fato selecionada agora. */
    currentVoice: () => current?.utterance?.voice?.name ?? null,
    _internal: { readVoices, waitForVoices },
  };
}

function browserErrorMessage(code) {
  switch (code) {
    case 'not-allowed':
      return 'O navegador bloqueou a fala. Toque na tela uma vez e tente de novo.';
    case 'voice-unavailable':
      return 'A voz escolhida não está mais disponível neste navegador.';
    case 'audio-busy':
    case 'audio-hardware':
      return 'O áudio do sistema está ocupado. Feche outros aplicativos que estejam falando.';
    case 'network':
      return 'A voz online não respondeu. Tente outra voz ou o motor do servidor.';
    default:
      return 'Não foi possível falar este trecho.';
  }
}

/* ------------------------------ descrição --------------------------------- */

/** Texto curto que diz ao usuário qual motor está em uso. */
export function describeEngine(engine, voice) {
  if (engine === ENGINE.BROWSER) {
    return voice ? `voz do navegador — ${voice.name}` : 'voz do navegador';
  }
  if (engine === ENGINE.EDGE) {
    return voice ? `servidor edge-tts — ${voice.name}` : 'servidor edge-tts';
  }
  return 'automático';
}
