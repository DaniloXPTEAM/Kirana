/**
 * Serviço de voz da Kirana (motor Thalita Neural).
 *
 * Reaproveita o worker Python do patch Thalita v0.4.0 (`edge_tts_worker.py`,
 * hash idêntico ao do Gateway v0.4.1) — sem instalar a interface experimental
 * e sem segundo orquestrador. A Kirana só traduz: texto -> MP3 em stream.
 *
 * Contrato interno:
 *   synthesizeStream(text, { signal }) -> { mime, stream, kill, meta }
 *
 * O provedor é EXTERNO e NÃO OFICIAL (Microsoft Edge TTS): pode falhar ou
 * mudar. Por isso existe `status()` e o frontend tem fallback local.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_SPEECH_CHARS, analyzeSpeechText, hasSpeakableContent, sanitizeTextForSpeech } from './tts-text.js';

export const THALITA_VOICE = 'pt-BR-ThalitaMultilingualNeural';

/**
 * Vozes pt-BR aceitas (lista fechada, igual à do worker). Thalita continua
 * sendo o padrão; as demais existem para o usuário escolher na interface.
 */
export const ALLOWED_VOICES = [
  'pt-BR-ThalitaMultilingualNeural',
  'pt-BR-FranciscaNeural',
  'pt-BR-AntonioNeural',
  'pt-BR-BrendaNeural',
  'pt-BR-DonatoNeural',
  'pt-BR-ElzaNeural',
  'pt-BR-FabioNeural',
  'pt-BR-GiovannaNeural',
  'pt-BR-HumbertoNeural',
  'pt-BR-JulioNeural',
  'pt-BR-LeilaNeural',
  'pt-BR-LeticiaNeural',
  'pt-BR-ManuelaNeural',
  'pt-BR-NicolauNeural',
  'pt-BR-ThalitaNeural',
  'pt-BR-ValerioNeural',
  'pt-BR-YaraNeural',
];

/**
 * JSON com escapes ASCII.
 *
 * O `JSON.stringify` normal emite UTF-8 cru. O Python filho, quando o stdio não
 * é UTF-8 (padrão no Windows para pipes: página ANSI cp1252), decodifica esses
 * bytes como cp1252 e o worker recebe "eleiÃ§Ãµes" em vez de "eleições" — e
 * manda isso para o motor, mudando a pronúncia. Gerado assim, o JSON é 100%
 * ASCII e não depende da codificação de nenhum dos dois lados.
 */
export function toAsciiJson(value) {
  return JSON.stringify(value).replace(/[\u007F-\uFFFF]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Ambiente que força UTF-8 no processo filho (2ª barreira). */
export function pythonUtf8Env(base = process.env) {
  return { ...base, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
}

/**
 * Velocidades aceitas pelo worker. Lista fechada de propósito: o valor vai
 * para o motor externo e não deve ser arbitrário.
 *
 * O padrão é +8% porque a voz em velocidade natural mede ~146 palavras/min,
 * logo abaixo da faixa desejada (150–180). Medido com `npm run voice:bench`.
 */
export const ALLOWED_RATES = ['-20%', '-15%', '-10%', '-5%', '+0%', '+5%', '+8%', '+10%', '+15%', '+20%'];
export const DEFAULT_RATE = '+8%';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER = path.join(HERE, 'edge_tts_worker.py');

export class VoiceError extends Error {
  constructor(message, { code = 'voice_error', status = 503 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {object} options
 * @param {string} [options.pythonCommand]  ex.: 'python3' ou 'py -3'
 * @param {string} [options.workerPath]
 * @param {Function} [options.spawnImpl]    injetável para testes
 * @param {string} [options.provider]       'edge' (padrão) | 'disabled'
 */
export function createVoiceService({
  pythonCommand = process.env.KIRANA_EDGE_TTS_PYTHON || (process.platform === 'win32' ? 'py' : 'python3'),
  workerPath = DEFAULT_WORKER,
  spawnImpl = spawn,
  platform = process.platform,
  provider = process.env.KIRANA_TTS_PROVIDER || 'edge',
  rate = process.env.KIRANA_TTS_RATE || DEFAULT_RATE,
  voice = process.env.KIRANA_TTS_VOICE || THALITA_VOICE,
  logger,
} = {}) {
  const speechRate = ALLOWED_RATES.includes(rate) ? rate : DEFAULT_RATE;
  const defaultVoice = ALLOWED_VOICES.includes(voice) ? voice : THALITA_VOICE;
  const log = logger?.child?.('voice') ?? logger;
  const active = new Set();
  /**
   * Instrumentação (v0.4.1): um registro por segmento falado, em memória e com
   * teto. Guarda o texto EXATO que foi enviado ao motor e o que foi descartado,
   * para comparar `text_displayed` (no navegador) com `text_sent_to_tts`.
   * Só existe em RAM: não vai para disco, não vai para o histórico e não
   * contém credenciais.
   */
  const diagnostics = [];
  const DIAG_LIMIT = 50;
  const pyArgs = platform === 'win32' && pythonCommand === 'py' ? ['-3'] : [];

  const enabled = provider !== 'disabled';

  /** Executa um worker e coleta saída (usado pelo status e pelo catálogo). */
  function runWorkerOnce(args, { timeoutMs = 25_000, input = null } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(pythonCommand, [...pyArgs, workerPath, ...args], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: pythonUtf8Env(),
      });
      const out = [];
      const err = [];
      let settled = false;
      const timer = setTimeout(() => {
        child.kill?.();
        finish(new VoiceError('Voz: tempo esgotado ao consultar o motor.', { code: 'voice_timeout', status: 504 }));
      }, timeoutMs);

      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      }

      child.stdout?.on('data', (chunk) => out.push(chunk));
      child.stderr?.on('data', (chunk) => err.push(chunk));
      child.on('error', () => finish(new VoiceError('Python não encontrado para o motor de voz.', { code: 'voice_python_missing' })));
      child.on('close', (code) => {
        if (code !== 0) {
          finish(new VoiceError('O motor de voz não respondeu.', { code: 'voice_provider_failed' }));
          return;
        }
        finish(null, { stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() });
      });

      if (input !== null && child.stdin) child.stdin.end(input);
    });
  }

  /** O motor está utilizável agora? (não chama a rede: só verifica o worker) */
  async function status() {
    if (!enabled) {
      return { available: false, provider: 'disabled', voice: THALITA_VOICE, rate: speechRate, reason: 'KIRANA_TTS_PROVIDER=disabled' };
    }
    const started = Date.now();
    try {
      const { stdout } = await runWorkerOnce(['--list-voices'], { timeoutMs: 20_000 });
      const voices = JSON.parse(stdout.toString('utf8') || '[]');
      const found = Array.isArray(voices) && voices.some((v) => v.shortName === defaultVoice);
      return {
        available: Boolean(found),
        provider: 'edge-tts',
        voice: defaultVoice,
        rate: speechRate,
        voiceFound: Boolean(found),
        catalogSize: Array.isArray(voices) ? voices.length : 0,
        checkMs: Date.now() - started,
        note: found ? null : 'A voz Thalita não está no catálogo do provedor.',
      };
    } catch (error) {
      return {
        available: false,
        provider: 'edge-tts',
        voice: defaultVoice,
        rate: speechRate,
        checkMs: Date.now() - started,
        reason: error?.code || 'voice_unavailable',
        note: 'Provedor externo não oficial: pode estar temporariamente fora do ar.',
      };
    }
  }

  /**
   * Catálogo de vozes pt-BR do provedor (com cache curto).
   *
   * A interface usa isto para oferecer as vozes do servidor ao lado das vozes
   * do navegador. Falha de rede/provedor devolve lista vazia — nunca impede a
   * conversa, porque o motor do navegador não depende disto.
   */
  const catalogCache = { at: 0, voices: [] };
  async function listVoices({ force = false, ttlMs = 5 * 60_000 } = {}) {
    if (!enabled) return [];
    if (!force && catalogCache.voices.length && Date.now() - catalogCache.at < ttlMs) return catalogCache.voices;
    try {
      const { stdout } = await runWorkerOnce(['--list-voices'], { timeoutMs: 20_000 });
      const items = JSON.parse(stdout.toString('utf8') || '[]');
      const voices = (Array.isArray(items) ? items : [])
        .filter((item) => ALLOWED_VOICES.includes(item?.shortName))
        .map((item) => ({ shortName: item.shortName, locale: item.locale ?? 'pt-BR', gender: item.gender ?? null, status: item.status ?? null }));
      catalogCache.voices = voices;
      catalogCache.at = Date.now();
      return voices;
    } catch {
      return catalogCache.voices; // último catálogo conhecido, se houver
    }
  }

  /**
   * Verifica se o texto chega íntegro ao worker (acentos inclusive).
   *
   * Existe porque a corrupção Node→Python no Windows é silenciosa: o áudio sai,
   * só sai errado. O `doctor` chama isto e compara.
   */
  async function selfCheck() {
    const probe = 'A inteligência está ótima, eleições e português.';
    try {
      const { stdout } = await runWorkerOnce(['--self-check'], { timeoutMs: 20_000, input: toAsciiJson({ text: probe }) });
      const result = JSON.parse(stdout.toString('utf8'));
      return { ...result, probe, ok: Boolean(result.roundTrip) };
    } catch (error) {
      return { ok: false, probe, error: error?.code || 'voice_self_check_failed' };
    }
  }

  /**
   * Sintetiza em streaming. Devolve o child process para permitir abort
   * imediato (barge-in) sem esperar o fim do áudio.
   */
  function synthesizeStream(rawText, { signal, turnId = null, segmentId = null, sessionId = null, voice = null } = {}) {
    if (!enabled) throw new VoiceError('Modo de voz desativado na configuração.', { code: 'voice_disabled' });
    const analysis = analyzeSpeechText(rawText);
    const text = analysis.text;
    if (!text || !hasSpeakableContent(text)) {
      throw new VoiceError('Não há conteúdo falável nesta resposta.', { code: 'voice_empty_text', status: 400 });
    }
    if (text.length > MAX_SPEECH_CHARS) {
      throw new VoiceError('Texto acima do limite de fala.', { code: 'voice_text_too_long', status: 413 });
    }
    if (signal?.aborted) throw new VoiceError('Requisição cancelada.', { code: 'voice_aborted', status: 499 });
    const chosenVoice = voice ?? defaultVoice;
    if (!ALLOWED_VOICES.includes(chosenVoice)) {
      throw new VoiceError('Voz não suportada neste servidor.', { code: 'voice_invalid_voice', status: 400 });
    }

    const child = spawnImpl(pythonCommand, [...pyArgs, workerPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: pythonUtf8Env(),
    });
    active.add(child);

    const startedAt = Date.now();
    const meta = { voice: chosenVoice, rate: speechRate, provider: 'edge-tts', chars: text.length, firstByteMs: null, totalMs: null, bytes: 0 };

    const record = {
      at: new Date().toISOString(),
      sessionId,
      turnId,
      segmentId,
      receivedChars: String(rawText ?? '').length,
      text_sent_to_tts: text,
      voice: chosenVoice,
      chars: text.length,
      dropped: analysis.dropped,
      droppedChars: analysis.droppedChars,
      firstByteMs: null,
      totalMs: null,
      bytes: 0,
      outcome: 'started',
    };
    diagnostics.push(record);
    if (diagnostics.length > DIAG_LIMIT) diagnostics.shift();

    if (child.stdout) {
      child.stdout.once('data', () => {
        meta.firstByteMs = Date.now() - startedAt;
        record.firstByteMs = meta.firstByteMs;
      });
      child.stdout.on('data', (chunk) => {
        meta.bytes += chunk.length;
        record.bytes = meta.bytes;
      });
    }

    const cleanup = (code) => {
      active.delete(child);
      meta.totalMs = Date.now() - startedAt;
      record.totalMs = meta.totalMs;
      record.bytes = meta.bytes;
      if (record.outcome === 'started') {
        record.outcome = signal?.aborted ? 'aborted' : code === 0 ? 'ok' : 'failed';
      }
    };
    child.on('close', cleanup);
    child.on('error', () => {
      record.outcome = 'error';
      cleanup(-1);
    });

    // Aborto: mata o processo (o worker para de gerar áudio imediatamente).
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* já morto */
      }
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('close', () => signal?.removeEventListener?.('abort', onAbort));

    // Sempre JSON ASCII: independe da codificação do stdio do Python no Windows.
    if (child.stdin) child.stdin.end(toAsciiJson({ text, rate: speechRate, voice: chosenVoice }));

    return { mime: 'audio/mpeg', stream: child.stdout, child, meta, text };
  }

  function close() {
    for (const child of active) {
      try {
        child.kill();
      } catch {
        /* ignora */
      }
    }
    active.clear();
  }

  return {
    provider: enabled ? 'edge-tts' : 'disabled',
    voice: defaultVoice,
    voices: ALLOWED_VOICES,
    rate: speechRate,
    status,
    listVoices,
    selfCheck,
    synthesizeStream,
    close,
    get activeCount() {
      return active.size;
    },
    /** Registros de instrumentação (mais recente por último). */
    diagnostics(filter = {}) {
      return diagnostics.filter((entry) => (!filter.sessionId || entry.sessionId === filter.sessionId)).slice();
    },
    clearDiagnostics() {
      diagnostics.length = 0;
    },
  };
}
