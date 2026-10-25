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

import { MAX_SPEECH_CHARS, hasSpeakableContent, sanitizeTextForSpeech } from './tts-text.js';

export const THALITA_VOICE = 'pt-BR-ThalitaMultilingualNeural';

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
  logger,
} = {}) {
  const speechRate = ALLOWED_RATES.includes(rate) ? rate : DEFAULT_RATE;
  const log = logger?.child?.('voice') ?? logger;
  const active = new Set();
  const pyArgs = platform === 'win32' && pythonCommand === 'py' ? ['-3'] : [];

  const enabled = provider !== 'disabled';

  /** Executa um worker e coleta saída (usado pelo status e pelo catálogo). */
  function runWorkerOnce(args, { timeoutMs = 25_000, input = null } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(pythonCommand, [...pyArgs, workerPath, ...args], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
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
      const found = Array.isArray(voices) && voices.some((v) => v.shortName === THALITA_VOICE);
      return {
        available: Boolean(found),
        provider: 'edge-tts',
        voice: THALITA_VOICE,
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
        voice: THALITA_VOICE,
        rate: speechRate,
        checkMs: Date.now() - started,
        reason: error?.code || 'voice_unavailable',
        note: 'Provedor externo não oficial: pode estar temporariamente fora do ar.',
      };
    }
  }

  /**
   * Sintetiza em streaming. Devolve o child process para permitir abort
   * imediato (barge-in) sem esperar o fim do áudio.
   */
  function synthesizeStream(rawText, { signal } = {}) {
    if (!enabled) throw new VoiceError('Modo de voz desativado na configuração.', { code: 'voice_disabled' });
    const text = sanitizeTextForSpeech(rawText);
    if (!text || !hasSpeakableContent(text)) {
      throw new VoiceError('Não há conteúdo falável nesta resposta.', { code: 'voice_empty_text', status: 400 });
    }
    if (text.length > MAX_SPEECH_CHARS) {
      throw new VoiceError('Texto acima do limite de fala.', { code: 'voice_text_too_long', status: 413 });
    }
    if (signal?.aborted) throw new VoiceError('Requisição cancelada.', { code: 'voice_aborted', status: 499 });

    const child = spawnImpl(pythonCommand, [...pyArgs, workerPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    active.add(child);

    const startedAt = Date.now();
    const meta = { voice: THALITA_VOICE, rate: speechRate, provider: 'edge-tts', chars: text.length, firstByteMs: null, totalMs: null, bytes: 0 };

    if (child.stdout) {
      child.stdout.once('data', () => {
        meta.firstByteMs = Date.now() - startedAt;
      });
      child.stdout.on('data', (chunk) => {
        meta.bytes += chunk.length;
      });
    }

    const cleanup = () => {
      active.delete(child);
      meta.totalMs = Date.now() - startedAt;
    };
    child.on('close', cleanup);
    child.on('error', cleanup);

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

    if (child.stdin) child.stdin.end(JSON.stringify({ text, rate: speechRate }));

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
    voice: THALITA_VOICE,
    rate: speechRate,
    status,
    synthesizeStream,
    close,
    get activeCount() {
      return active.size;
    },
  };
}
