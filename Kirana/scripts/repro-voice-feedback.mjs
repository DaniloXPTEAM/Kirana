/**
 * REPRODUÇÃO do defeito relatado: a Kirana escuta a própria voz.
 *
 * Hipótese investigada: o reconhecedor fica ABERTO durante a resposta (é o que
 * permite o barge-in "Kirana, pare"). Resultados de fala chegam com ATRASO — e
 * um resultado que é eco da própria Kirana pode chegar DEPOIS do turno acabar,
 * quando a janela de bloqueio (`commandWindow()`) já voltou a `false`.
 *
 * No código atual a guarda de eco só é aplicada quando `window` é verdadeira:
 *
 *     if (window && isEchoOf(heard, spokenText)) { ... }
 *
 * Sem janela → sem guarda de eco → o eco vira mensagem do usuário → ciclo.
 *
 * Rodar: node scripts/repro-voice-feedback.mjs
 */
import { createBrowserSpeechEngine } from '../public/voice-engine.js';
import { createVoiceController } from '../public/voice.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeRecognition {
  static instances = [];
  constructor() {
    this.started = 0;
    this.aborted = false;
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    FakeRecognition.instances.push(this);
  }
  start() { this.started += 1; this.onstart?.(); }
  stop() { this.onend?.(); }
  abort() { this.aborted = true; this.onend?.(); }
  hear(transcript, { isFinal = true } = {}) {
    if (this.aborted) return;
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal })] });
  }
}

class FakeAudio {
  constructor() { this.listeners = new Map(); this.paused = true; (globalThis.__audios ??= []).push(this); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  finish() { this.paused = true; this.listeners.get('ended')?.(); }
  set src(v) { this._src = v; }
  get src() { return this._src; }
}

function fakeSpeechHost() {
  const host = {
    spoken: [],
    cancel() {},
    speak(utterance) {
      host.spoken.push(utterance.text);
      setTimeout(() => utterance.onend?.(), 5);
    },
  };
  return host;
}

const mp3 = () =>
  new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });

const RESPOSTA =
  'Eu posso ajudar você com serviços de automação comercial e agentes inteligentes. ' +
  'Também trabalho com integrações e painéis de acompanhamento.';

async function cenario(titulo, { falaEco, esperaMs, esperado = 'bloquear' }) {
  FakeRecognition.instances = [];
  globalThis.__audios = [];
  globalThis.navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } };

  const envios = [];
  const storage = {
    data: {},
    getItem(k) { return this.data[k] ?? null; },
    setItem(k, v) { this.data[k] = v; },
    removeItem(k) { delete this.data[k]; },
  };

  const c = createVoiceController({
    send: async (text) => { envios.push(text); },
    stop: () => {},
    getSessionId: () => 's_repro',
    RecognitionImpl: FakeRecognition,
    AudioImpl: FakeAudio,
    MediaSourceImpl: undefined,
    speechEngine: createBrowserSpeechEngine({ host: fakeSpeechHost() }),
    storage,
    preference: { engine: 'browser', voiceId: null, rate: '+0%' },
    fetchImpl: async () => mp3(),
    tuning: { silenceMs: 5, muteAfterSpeechMs: 60, bargeInMuteMs: 40, bargeInListenMs: 300 },
    logger: { debug: () => {} },
  });

  await c.start();

  // 1) O usuário pergunta de verdade: isso abre o turno.
  FakeRecognition.instances.at(-1).hear('quais serviços vocês têm', { isFinal: true });
  await sleep(120);
  if (!envios.length) {
    console.log(`(cenário sem envio inicial — ${titulo})`);
    c.stop();
    return 0;
  }

  // 2) A resposta chega por streaming e é falada (TTS do navegador).
  for (const parte of RESPOSTA.match(/[^.!?]+[.!?]?/g)) c.appendDelta(`${parte} `);
  c.endTurn({ text: RESPOSTA, sessionId: 's_repro', aborted: false });

  // O áudio TERMINA de tocar (comportamento normal do navegador). Sem isto o
  // controlador fica em 'turn_busy' e o teste não mede o que interessa.
  for (let i = 0; i < 40 && c._internal.commandWindow(); i += 1) {
    for (const audio of globalThis.__audios ?? []) if (!audio.paused) audio.finish();
    await sleep(25);
  }

  // 3) Passa o tempo do áudio + janela surda: a Kirana já terminou de falar.
  await sleep(esperaMs);

  // 4) O reconhecedor entrega um resultado ATRASADO — eco da própria voz.
  const enviosAntes = envios.length;
  FakeRecognition.instances.at(-1)?.hear(falaEco, { isFinal: true });
  await sleep(120);

  const novos = envios.slice(enviosAntes);
  if (process.env.KIRANA_DEBUG) {
    console.log('   trace:', JSON.stringify(c.report().trace));
    console.log('   counters:', JSON.stringify(c.report().counters));
    console.log('   instâncias:', FakeRecognition.instances.length, 'vivas:', FakeRecognition.instances.filter(i=>!i.aborted).length);
  }
  const enviou = novos.length > 0;

  // Cada cenário tem UM desfecho correto:
  //   'bloquear' → é eco da própria voz: nada pode ser enviado;
  //   'aceitar'  → é fala real do usuário: precisa ser enviada.
  const passou = esperado === 'bloquear' ? !enviou : enviou;
  const rotulo = passou
    ? esperado === 'bloquear'
      ? 'ok — eco bloqueado'
      : 'ok — fala real aceita'
    : esperado === 'bloquear'
      ? `FALHA — eco virou mensagem: "${novos[0]}"`
      : 'FALHA — fala real foi descartada (guarda surda)';
  console.log(`${rotulo.padEnd(52)} | ${titulo}`);
  c.stop();
  return passou ? 0 : 1;
}

const casos = [
  ['eco de 3 palavras depois do turno', { falaEco: 'ajudar você com', esperaMs: 400, esperado: 'bloquear' }],
  ['eco de 2 palavras depois do turno', { falaEco: 'posso ajudar', esperaMs: 400, esperado: 'bloquear' }],
  ['trecho do TTS depois do turno', { falaEco: 'automação comercial e agentes', esperaMs: 700, esperado: 'bloquear' }],
  ['fala real do usuário depois do turno', { falaEco: 'quero saber os preços', esperaMs: 400, esperado: 'aceitar' }],
];

let falhas = 0;
console.log('\n=== REPRODUÇÃO: eco do próprio TTS virando mensagem ===\n');
for (const [titulo, opts] of casos) falhas += await cenario(titulo, opts);
console.log(`\ncenários com desfecho errado: ${falhas} de ${casos.length}`);
process.exit(falhas ? 1 : 0);
