/**
 * Motores de fala da Kirana v0.4.2.
 *
 * Cobre o módulo `public/voice-engine.js` (catálogo, escolha, preferência,
 * fala, cancelamento) e a integração com o controlador: quando o motor do
 * navegador está selecionado, NADA é pedido ao servidor; quando não está, o
 * caminho antigo (edge-tts) continua igual.
 *
 * `SpeechSynthesis` de verdade não existe no Node nem em Chromium headless
 * (sem vozes): aqui ele é simulado com um dublê fiel dos eventos
 * `start`/`end`/`error`. O áudio real é validado no navegador do usuário.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENGINE,
  PREFERRED_VOICE_PATTERNS,
  PREVIEW_TEXT,
  VOICE_PREF_KEY,
  createBrowserSpeechEngine,
  describeEngine,
  loadPreference,
  pickVoice,
  rateToNumber,
  rateToPercent,
  savePreference,
} from '../public/voice-engine.js';
import { createVoiceController, VOICE_STATE } from '../public/voice.js';

/* ------------------------------- dublês ---------------------------------- */

function fakeVoice(name, lang, extra = {}) {
  return { name, lang, voiceURI: `${name}-${lang}`, localService: false, default: false, ...extra };
}

const VOICES_PT = [
  fakeVoice('Microsoft Francisca Online (Natural)', 'pt-BR'),
  fakeVoice('Microsoft Antonio Online (Natural)', 'pt-BR'),
  fakeVoice('Microsoft Thalita Online (Natural)', 'pt-BR'),
  fakeVoice('Microsoft Zira', 'en-US'),
];

/** Dublê de `window.speechSynthesis` com a mesma semântica de eventos. */
function fakeSpeechHost({ voices = VOICES_PT, failNext = null, hang = false } = {}) {
  const spoken = [];
  const cancelled = [];
  let currentVoices = voices;
  const listeners = new Set();
  const host = {
    SpeechSynthesisUtterance: class FakeUtterance {
      constructor(text) {
        this.text = text;
        this.voice = null;
        this.lang = '';
        this.rate = 1;
        this.pitch = 1;
        this.onstart = null;
        this.onend = null;
        this.onerror = null;
      }
    },
    speechSynthesis: {
      getVoices: () => currentVoices,
      addEventListener: (name, fn) => name === 'voiceschanged' && listeners.add(fn),
      removeEventListener: (name, fn) => name === 'voiceschanged' && listeners.delete(fn),
      speak(utterance) {
        spoken.push(utterance);
        setTimeout(() => {
          utterance.onstart?.(new Event('start'));
          if (hang) return; // navegador que nunca emite 'end'
          if (failNext) {
            utterance.onerror?.({ error: failNext });
            failNext = null;
            return;
          }
          setTimeout(() => utterance.onend?.(new Event('end')), 2);
        }, 1);
      },
      cancel() {
        cancelled.push(true);
      },
      get speaking() {
        return Boolean(spoken.length);
      },
    },
    setTimeout,
    clearTimeout,
    emitVoicesChanged(next) {
      currentVoices = next;
      for (const fn of listeners) fn();
    },
  };
  return { host, spoken, cancelled };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    get size() {
      return data.size;
    },
    data,
  };
}

/* --------------------------- taxas e catálogo ---------------------------- */

test('taxa: converte porcentagem do servidor para o número do navegador e volta', () => {
  assert.equal(rateToNumber('+8%'), 1.08);
  assert.equal(rateToNumber('-10%'), 0.9);
  assert.equal(rateToNumber('+0%'), 1);
  assert.equal(rateToNumber(1.15), 1.15);
  assert.equal(rateToNumber('lixo'), 1);
  assert.equal(rateToNumber('+900%'), 2, 'nunca passa do limite do navegador');
  assert.equal(rateToPercent(1.08), '+8%');
  assert.equal(rateToPercent(0.9), '-10%');
});

test('catálogo do navegador: pt-BR primeiro e metadados úteis', async () => {
  const { host } = fakeSpeechHost();
  const engine = createBrowserSpeechEngine({ host });
  const voices = await engine.listVoices();
  assert.equal(voices.length, 4);
  assert.equal(voices[0].engine, ENGINE.BROWSER);
  assert.match(voices[0].id, /^browser:/);
  assert.equal(/^pt[-_]br$/i.test(voices[0].lang), true);
  assert.equal(/^pt[-_]br$/i.test(voices.at(-1).lang), false, 'en-US fica no fim');
});

test('escolha: Francisca é a preferida quando existe; Thalita é a seguinte', () => {
  const engine = createBrowserSpeechEngine({ host: fakeSpeechHost().host });
  const voices = VOICES_PT.map((voice) => ({
    id: `browser:${voice.voiceURI}`,
    engine: ENGINE.BROWSER,
    name: voice.name,
    lang: voice.lang,
    raw: voice,
  }));
  assert.match(pickVoice(voices).name, /Francisca/);
  const semFrancisca = voices.filter((voice) => !/Francisca/.test(voice.name));
  assert.match(pickVoice(semFrancisca).name, /Thalita/);
  const escolhida = pickVoice(voices, { voiceId: voices[1].id });
  assert.equal(escolhida.name, 'Microsoft Antonio Online (Natural)', 'a voz salva vence a preferência');
  assert.equal(pickVoice([], {}), null);
  assert.match(PREFERRED_VOICE_PATTERNS[0].source, /francisca/);
});

test('escolha: voz salva que sumiu cai para outra do mesmo motor', () => {
  const voices = VOICES_PT.map((voice) => ({ id: `browser:${voice.voiceURI}`, engine: ENGINE.BROWSER, name: voice.name, lang: voice.lang, raw: voice }));
  const escolhida = pickVoice(voices, { voiceId: 'browser:inexistente' });
  assert.match(escolhida.name, /Francisca/);
});

/* ----------------------------- preferência ------------------------------- */

test('preferência: salva, lê de volta e tolera lixo', () => {
  const storage = memoryStorage();
  assert.equal(savePreference(storage, { engine: ENGINE.BROWSER, voiceId: 'browser:x', rate: '+8%' }), true);
  assert.deepEqual(loadPreference(storage), { engine: ENGINE.BROWSER, voiceId: 'browser:x', rate: '+8%' });
  assert.ok(storage.data.get(VOICE_PREF_KEY));

  storage.setItem(VOICE_PREF_KEY, '{quebrado');
  assert.equal(loadPreference(storage), null);

  storage.setItem(VOICE_PREF_KEY, JSON.stringify({ engine: 'inexistente', voiceId: 42 }));
  assert.deepEqual(loadPreference(storage), { engine: ENGINE.AUTO, voiceId: null, rate: '+0%' });

  const bloqueado = {
    getItem() {
      throw new Error('acesso negado');
    },
    setItem() {
      throw new Error('cota');
    },
  };
  assert.equal(loadPreference(bloqueado), null);
  assert.equal(savePreference(bloqueado, { engine: ENGINE.EDGE }), false);
});

/* --------------------------- fala do navegador --------------------------- */

test('fala: entrega o texto ao navegador e resolve no fim do áudio', async () => {
  const { host, spoken } = fakeSpeechHost();
  const engine = createBrowserSpeechEngine({ host });
  let started = 0;
  const result = await engine.speak('Olá, estou testando minha voz.', { rate: '+8%', onStart: () => (started += 1) });
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, 'Olá, estou testando minha voz.');
  assert.equal(spoken[0].rate, 1.08);
  assert.equal(started, 1);
  assert.equal(result.cancelled, false);
  assert.ok(result.started <= result.ended);
});

test('fala: sem a API do navegador, falha com código claro', async () => {
  const engine = createBrowserSpeechEngine({ host: {} });
  assert.equal(engine.available(), false);
  await assert.rejects(() => engine.speak('oi'), (error) => error.code === 'voice_browser_unsupported');
});

test('fala: erro do navegador vira erro tratado, não exceção perdida', async () => {
  const { host } = fakeSpeechHost({ failNext: 'not-allowed' });
  const engine = createBrowserSpeechEngine({ host });
  const result = await engine.speak('oi');
  assert.match(result.error.message, /Toque na tela/);
  assert.equal(result.error.code, 'voice_browser_not-allowed');
});

test('fala: só um trecho por vez — o novo cancela o anterior', async () => {
  const { host, cancelled } = fakeSpeechHost({ hang: true });
  const engine = createBrowserSpeechEngine({ host });
  const primeira = engine.speak('primeira');
  await sleep(10);
  const segunda = engine.speak('segunda');
  const r1 = await primeira;
  assert.equal(r1.cancelled, true);
  assert.ok(cancelled.length >= 1, 'cancel() precisa ser chamado no navegador');
  engine.cancel();
  const r2 = await segunda;
  assert.equal(r2.cancelled, true);
});

test('catálogo assíncrono: espera o evento voiceschanged', async () => {
  const { host } = fakeSpeechHost({ voices: [] });
  const engine = createBrowserSpeechEngine({ host, voicesTimeoutMs: 300 });
  const promise = engine.listVoices();
  await sleep(10);
  host.emitVoicesChanged(VOICES_PT);
  const voices = await promise;
  assert.equal(voices.length, 4);
});

/* ------------------ integração com o controlador de voz ------------------ */

function mp3Response() {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff, 0xf3, 1, 2, 3]));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'audio/mpeg' } },
  );
}

class FakeRecognition {
  static instances = [];
  constructor() {
    this.started = 0;
    this.stopped = 0;
    this.aborted = 0;
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started += 1;
    this.onstart?.();
  }
  stop() {
    this.stopped += 1;
  }
  abort() {
    this.aborted += 1;
  }
  hear(transcript) {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal: true })] });
  }
}

function setupController({ browserVoices = VOICES_PT, preference = null } = {}) {
  FakeRecognition.instances = [];
  globalThis.navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } };
  const { host, spoken } = fakeSpeechHost({ voices: browserVoices });
  const speechEngine = createBrowserSpeechEngine({ host });
  const httpCalls = [];
  const storage = memoryStorage();
  const controller = createVoiceController({
    send: async () => {},
    stop: () => {},
    getSessionId: () => 's_teste',
    RecognitionImpl: FakeRecognition,
    AudioImpl: class {
      addEventListener() {}
      removeEventListener() {}
      play() {
        return Promise.resolve();
      }
      pause() {}
      removeAttribute() {}
      load() {}
    },
    MediaSourceImpl: undefined,
    speechEngine,
    storage,
    preference,
    fetchImpl: async (url, options = {}) => {
      httpCalls.push({ url: String(url), body: options.body });
      if (String(url).includes('/api/voice/voices')) {
        return new Response(JSON.stringify({ voices: [{ shortName: 'pt-BR-ThalitaMultilingualNeural', locale: 'pt-BR' }] }), { status: 200 });
      }
      if (String(url).includes('/api/voice/diagnostics')) return new Response('{"entries":[]}', { status: 200 });
      return mp3Response();
    },
    tuning: { silenceMs: 5, restartDelayMs: 0 },
    logger: { debug: () => {} },
  });
  return { controller, spoken, httpCalls, storage, recognition: () => FakeRecognition.instances.at(-1) };
}

test('integração: com voz do navegador disponível, nada é pedido ao servidor', async () => {
  const { controller, spoken, httpCalls } = setupController();
  await controller.start();
  await sleep(20);
  assert.equal(controller.settings.engine, ENGINE.BROWSER);
  assert.match(controller.settings.voice.name, /Francisca/);

  controller.appendDelta('A primeira frase da resposta tem tamanho suficiente. ');
  await sleep(60);
  controller.endTurn({ aborted: false, error: false });

  assert.equal(spoken.length >= 1, true, 'a fala precisa ir para o speechSynthesis');
  assert.equal(httpCalls.filter((call) => call.url.includes('/api/voice/tts')).length, 0, 'nenhum POST de TTS');
  // O catálogo do servidor só é buscado quando a interface pede: o caminho do
  // navegador não deve tocar a rede para falar.
  assert.equal(httpCalls.filter((call) => call.url.includes('/api/voice/voices')).length, 0);
  controller.dispose();
});

test('integração: sem voz no navegador, cai para o motor do servidor', async () => {
  const { controller, spoken, httpCalls } = setupController({ browserVoices: [] });
  await controller.start();
  await sleep(20);
  assert.equal(controller.settings.engine, ENGINE.EDGE);
  controller.appendDelta('A primeira frase da resposta tem tamanho suficiente. ');
  await sleep(60);
  controller.endTurn({ aborted: false, error: false });
  assert.equal(spoken.length, 0);
  assert.equal(httpCalls.filter((call) => call.url.includes('/api/voice/tts')).length >= 1, true);
  controller.dispose();
});

test('integração: escolha do usuário é salva e respeitada na sessão seguinte', async () => {
  const primeira = setupController();
  await primeira.controller.start();
  await primeira.controller.refreshVoices({ includeServer: true, force: true });
  const escolha = primeira.controller.setVoice('edge:pt-BR-ThalitaMultilingualNeural');
  assert.equal(escolha.engine, ENGINE.EDGE);
  assert.equal(primeira.controller.settings.voice.name, 'pt-BR-ThalitaMultilingualNeural');
  primeira.controller.dispose();

  // novo controlador, mesmo localStorage: a preferência volta
  globalThis.navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } };
  const segundo = createVoiceController({
    send: async () => {},
    stop: () => {},
    getSessionId: () => 's_teste',
    RecognitionImpl: FakeRecognition,
    AudioImpl: class {
      play() {
        return Promise.resolve();
      }
      pause() {}
      addEventListener() {}
      removeEventListener() {}
    },
    speechEngine: createBrowserSpeechEngine({ host: fakeSpeechHost().host }),
    storage: primeira.storage,
    fetchImpl: async () =>
      new Response(JSON.stringify({ voices: [{ shortName: 'pt-BR-ThalitaMultilingualNeural', locale: 'pt-BR' }] }), { status: 200 }),
    tuning: { silenceMs: 5 },
    logger: { debug: () => {} },
  });
  await segundo.refreshVoices({ includeServer: true, force: true });
  assert.equal(segundo.settings.engine, ENGINE.EDGE);
  assert.equal(segundo.settings.voice.name, 'pt-BR-ThalitaMultilingualNeural');
  segundo.dispose();
});

test('integração: interromper cancela a fala do navegador na hora', async () => {
  const { controller, spoken } = setupController();
  await controller.start();
  await sleep(20);
  controller.appendDelta('Uma frase longa o suficiente para começar a falar agora. ');
  await sleep(40);
  assert.equal(spoken.length >= 1, true);
  controller.interrupt({ stopGeneration: false });
  assert.equal(controller.state, VOICE_STATE.INTERRUPTED);
  assert.equal(controller.queueSize, 0);
  controller.dispose();
});

test('integração: prévia fala sem entrar no histórico nem chamar o modelo', async () => {
  const { controller, spoken, httpCalls } = setupController();
  await controller.start();
  await sleep(20);
  await controller.previewVoice();
  assert.equal(spoken.at(-1).text, PREVIEW_TEXT);
  assert.equal(httpCalls.filter((call) => call.url.includes('/api/chat')).length, 0);
  assert.equal(controller.history.turns, 0);
  controller.dispose();
});

test('integração: diagnóstico registra motor e voz de cada segmento', async () => {
  const { controller } = setupController();
  await controller.start();
  await sleep(20);
  controller.appendDelta('Uma frase longa o suficiente para falar agora mesmo. ');
  await sleep(80);
  controller.endTurn({ aborted: false, error: false });
  const registro = controller.diagnostics.at(-1);
  assert.equal(registro.engine, ENGINE.BROWSER);
  assert.match(registro.voice, /Francisca/);
  assert.equal(registro.outcome, 'played');
  assert.equal(typeof registro.playbackStart, 'number');
  controller.dispose();
});

test('describeEngine: texto honesto sobre quem está falando', () => {
  assert.match(describeEngine(ENGINE.BROWSER, { name: 'Francisca' }), /voz do navegador — Francisca/);
  assert.match(describeEngine(ENGINE.EDGE, { name: 'Thalita' }), /servidor edge-tts — Thalita/);
});
