#!/usr/bin/env node
/**
 * Medição REAL da voz (não simulada).
 *
 * Uso: npm run voice:bench [-- 5]
 *
 * Mede, contra o provedor de verdade (Edge TTS / Thalita):
 *   1. latência até o primeiro byte de áudio (o que o usuário "sente" como
 *      demora para a Kirana começar a falar);
 *   2. tempo total de síntese;
 *   3. taxa de fala (palavras por minuto) para checar 150–180 ppm;
 *   4. latência de interrupção (abort do cliente -> processo encerrado).
 *
 * Nada aqui é estimativa: os números são medidos e, se ficarem fora da meta,
 * são publicados fora da meta. Ver docs/VOZ.md.
 */
import { createVoiceService } from '../src/voice/tts.js';

const RUNS = Number(process.argv[2] || 3);
const TEXT = 'Olá! Eu sou a Kirana, da Opportunity AI. Posso ajudar você a entender como a inteligência artificial pode atender seus clientes no WhatsApp e no site. Por onde você quer começar?';

/**
 * Duração real do MP3 (para calcular palavras por minuto sem depender de
 * ffprobe). Percorre os quadros MPEG e soma as amostras.
 */
const BITRATES = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

function mp3DurationSeconds(buffer) {
  let offset = 0;
  let seconds = 0;
  let frames = 0;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }
    const versionBits = (buffer[offset + 1] >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layerBits = (buffer[offset + 1] >> 1) & 0x03; // 1 = layer III
    const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
    const rateIndex = (buffer[offset + 2] >> 2) & 0x03;
    const padding = (buffer[offset + 2] >> 1) & 0x01;
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
    const layer = layerBits === 1 ? 3 : layerBits === 2 ? 2 : 1;
    if (rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) {
      offset += 1;
      continue;
    }
    const table = BITRATES[`${version === 1 ? 1 : 2}-${layer}`];
    const bitrate = table?.[bitrateIndex] * 1000;
    const sampleRate = SAMPLE_RATES[version]?.[rateIndex];
    if (!bitrate || !sampleRate) {
      offset += 1;
      continue;
    }
    const samplesPerFrame = layer === 1 ? 384 : version === 1 ? 1152 : 576;
    const frameLength = Math.floor(((layer === 1 ? 12 : samplesPerFrame / 8) * bitrate) / sampleRate) + padding;
    if (frameLength <= 4) {
      offset += 1;
      continue;
    }
    seconds += samplesPerFrame / sampleRate;
    frames += 1;
    offset += frameLength;
  }
  return frames ? seconds : null;
}

const service = createVoiceService({});
const results = [];

function measureOnce() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let firstByteMs = null;
    let bytes = 0;
    const chunks = [];
    let handle;
    try {
      handle = service.synthesizeStream(TEXT);
    } catch (error) {
      reject(error);
      return;
    }
    handle.stream.on('data', (chunk) => {
      if (firstByteMs === null) firstByteMs = Date.now() - started;
      bytes += chunk.length;
      chunks.push(chunk);
    });
    handle.stream.on('end', () =>
      resolve({ firstByteMs, totalMs: Date.now() - started, bytes, audio: mp3DurationSeconds(Buffer.concat(chunks)) }),
    );
    handle.stream.on('error', reject);
  });
}

/** Latência de interrupção: pede áudio, aborta e confirma que o worker morreu. */
function measureInterrupt() {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const started = Date.now();
    const handle = service.synthesizeStream(TEXT, { signal: controller.signal });
    let killedAt = null;
    let firstByteAt = null;
    handle.child.once('exit', () => {
      killedAt = Date.now();
    });
    handle.stream.once('data', () => {
      firstByteAt = Date.now();
      const abortAt = Date.now();
      controller.abort();
      const timer = setInterval(() => {
        if (killedAt !== null) {
          clearInterval(timer);
          resolve({ interruptMs: killedAt - abortAt, sinceStartMs: firstByteAt - started });
        }
      }, 5);
      setTimeout(() => {
        clearInterval(timer);
        resolve({ interruptMs: null, sinceStartMs: firstByteAt - started });
      }, 3000);
    });
  });
}

const status = await service.status();
console.log(`Motor: ${status.provider} · voz ${status.voice} · disponível: ${status.available ? 'sim' : 'NÃO'}`);
if (!status.available) {
  console.log(`Motivo: ${status.reason || status.note}`);
  process.exitCode = 1;
}

// Aquecimento: a PRIMEIRA síntese de um processo paga conexão TLS/HTTP com o
// serviço da Microsoft. Medimos separado para não maquiar a média.
try {
  const cold = await measureOnce();
  console.log(`aquecimento (1ª síntese do processo): primeiro byte ${cold.firstByteMs} ms · total ${cold.totalMs} ms`);
} catch (error) {
  console.log(`aquecimento falhou: ${error?.message}`);
}

for (let i = 0; i < RUNS; i += 1) {
  try {
    const result = await measureOnce();
    results.push(result);
    const audio = result.audio ? ` · áudio ${result.audio.toFixed(1)} s` : '';
    console.log(`#${i + 1} primeiro byte ${result.firstByteMs} ms · total ${result.totalMs} ms · ${result.bytes} bytes${audio}`);
  } catch (error) {
    console.log(`#${i + 1} falhou: ${error?.message}`);
  }
}

if (results.length) {
  const avg = (key) => Math.round(results.reduce((sum, r) => sum + r[key], 0) / results.length);
  const words = TEXT.split(/\s+/).length;
  const durations = results.map((r) => r.audio).filter(Boolean);
  const audioSeconds = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  console.log(`\nMédia: primeiro byte ${avg('firstByteMs')} ms · total ${avg('totalMs')} ms (${results.length} execuções)`);
  console.log(`Texto de teste: ${TEXT.length} caracteres, ${words} palavras.`);
  if (audioSeconds) {
    const ppm = Math.round((words / audioSeconds) * 60);
    console.log(`Duração do áudio: ${audioSeconds.toFixed(2)} s → ${ppm} palavras/min (meta 150–180 ppm)`);
  }
}

const interrupt = await measureInterrupt();
console.log(
  interrupt.interruptMs === null
    ? `Interrupção: o worker NÃO encerrou em 3 s (medido desde o início: ${interrupt.sinceStartMs} ms)`
    : `Interrupção: ${interrupt.interruptMs} ms entre abort e encerramento do worker (${interrupt.sinceStartMs} ms após o início)`,
);

service.close();
