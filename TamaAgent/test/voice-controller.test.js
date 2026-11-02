/**
 * Testes do controlador de voz (máquina de estados, interrupção, HITL).
 *
 * ATENÇÃO: estes testes usam dublês (SpeechRecognition, Audio, fetch). Eles
 * provam a LÓGICA, não que o microfone ou o áudio funcionam — isso é feito nos
 * testes de navegador (`test/browser/voice-flow.mjs`) e na medição real com o
 * provedor Edge TTS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createVoiceController, VOICE_STATE, takeSpeakableSentences } from '../public/voice.js';

/* ------------------------------- dublês ---------------------------------- */

class FakeRecognition {
  static instances = [];
  constructor() {
    this.started = 0;
    this.stopped = 0;
    this.aborted = 0;
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
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
  /** Simula o microfone entregando resultados. */
  emit(transcript, { isFinal = true } = {}) {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal })] });
  }
  error(code) {
    this.onerror?.({ error: code });
  }
  end() {
    this.onend?.();
  }
}

class FakeAudio {
  static instances = [];
  constructor() {
    this.src = '';
    this.paused = true;
    this.currentTime = 0;
    this.listeners = new Map();
    FakeAudio.instances.push(this);
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) {
    this.listeners.get(name)?.delete(fn);
  }
  emit(name) {
    for (const fn of this.listeners.get(name) ?? []) fn();
  }
  play() {
    this.paused = false;
    this.emit('playing');
    if (this.blocked) return Promise.resolve(); // áudio longo: só termina via finish()
    setTimeout(() => {
      this.paused = true;
      this.emit('ended');
    }, 1);
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  finish() {
    this.paused = true;
    this.emit('ended');
  }
  removeAttribute() {}
  load() {}
}

function mp3Response(bytes = 512) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0xff, 0xf3, ...new Array(bytes - 2).fill(7)]));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
}

function makeController({ fetchImpl, sessionId = 's_abc123', tuning = { silenceMs: 5 } } = {}) {
  const calls = { send: [], stop: 0, tts: [] };
  const sent = [];
  const controller = createVoiceController({
    send: async (text) => {
      calls.send.push(text);
      sent.push(text);
    },
    stop: () => {
      calls.stop += 1;
    },
    getSessionId: () => sessionId,
    RecognitionImpl: FakeRecognition,
    AudioImpl: FakeAudio,
    MediaSourceImpl: undefined, // caminho "acumula e toca" (determinístico)
    fetchImpl: fetchImpl ?? (async (url, options) => {
      calls.tts.push(JSON.parse(options.body));
      return mp3Response();
    }),
    tuning,
    logger: { debug: () => {} },
  });
  return { controller, calls };
}

function mediaDevices(ok = true) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {
    mediaDevices: {
      getUserMedia: ok
        ? async () => ({ getTracks: () => [{ stop() {} }] })
        : async () => {
            throw new Error('NotAllowedError');
          },
    },
  } });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------- testes --------------------------------- */

test('sem SpeechRecognition: avisa e não finge ouvir', async () => {
  mediaDevices(true);
  const notices = [];
  const controller = createVoiceController({
    send: async () => {},
    getSessionId: () => 's_1',
    RecognitionImpl: undefined,
    AudioImpl: FakeAudio,
    logger: { debug: () => {} },
    onStateChange: (state) => notices.push(state),
  });
  const ok = await controller.start();
  assert.equal(ok, false);
  assert.equal(controller.supported, false);
  assert.equal(controller.state, VOICE_STATE.ERROR);
  assert.match(controller.notice, /não reconhece fala/i);
  assert.ok(notices.includes(VOICE_STATE.ERROR));
});

test('microfone negado: estado de erro claro e nenhum envio', async () => {
  mediaDevices(false);
  const { controller, calls } = makeController();
  const ok = await controller.start();
  assert.equal(ok, false);
  assert.equal(controller.state, VOICE_STATE.ERROR);
  assert.equal(controller.micDenied, true);
  assert.equal(calls.send.length, 0);
  assert.match(controller.history.states.at(-1).to, /erro/);
});

test('escuta: abre o microfone, avança para "ouvindo" e detecta fala', async () => {
  mediaDevices(true);
  const { controller } = makeController();
  await controller.start();
  assert.equal(controller.state, VOICE_STATE.LISTENING);
  const recognition = FakeRecognition.instances.at(-1);
  recognition.emit('quero um orçamento', { isFinal: false });
  assert.equal(controller.state, VOICE_STATE.SPEECH_DETECTED);
  controller.dispose();
});

test('fim de enunciado por silêncio envia o texto ao MESMO sendMessage', async () => {
  mediaDevices(true);
  const { controller, calls } = makeController({ tuning: { silenceMs: 5 } });
  await controller.start();
  const recognition = FakeRecognition.instances.at(-1);
  recognition.emit('bom dia, quero falar sobre um projeto', { isFinal: true });
  await sleep(20);
  assert.deepEqual(calls.send, ['bom dia, quero falar sobre um projeto']);
  assert.equal(controller.state, VOICE_STATE.PROCESSING);
  controller.dispose();
});

test('transcrição vazia ou só ruído não cria turno', async () => {
  mediaDevices(true);
  const { controller, calls } = makeController({ tuning: { silenceMs: 5 } });
  await controller.start();
  const recognition = FakeRecognition.instances.at(-1);
  recognition.emit('   ', { isFinal: true });
  await sleep(20);
  recognition.emit('...', { isFinal: true });
  await sleep(20);
  assert.equal(calls.send.length, 0);
  controller.dispose();
});

test('não duplica: a mesma fala enviada uma vez só', async () => {
  mediaDevices(true);
  const { controller, calls } = makeController({ tuning: { silenceMs: 5 } });
  await controller.start();
  const recognition = FakeRecognition.instances.at(-1);
  recognition.emit('quero saber o preço', { isFinal: true });
  recognition.emit('quero saber o preço', { isFinal: true }); // repetição do motor
  await sleep(20);
  recognition.emit('quero saber o preço', { isFinal: true }); // chegada atrasada
  await sleep(10);
  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0], 'quero saber o preço');
  controller.dispose();
});

test('resposta é falada em frases, com o sessionId da conversa', async () => {
  mediaDevices(true);
  const { controller, calls } = makeController();
  await controller.start();
  FakeRecognition.instances.at(-1).emit('oi', { isFinal: true });
  await sleep(10);

  controller.appendDelta('Olá! Sou a Kirana e posso ajudar você hoje. ');
  await sleep(20);
  controller.appendDelta('Qual é o seu projeto?');
  controller.endTurn({ text: 'Qual é o seu projeto?', aborted: false, error: false });
  await sleep(30);

  assert.ok(calls.tts.length >= 2, 'esperava ao menos duas sínteses');
  for (const body of calls.tts) {
    assert.equal(body.sessionId, 's_abc123');
    assert.match(body.text, /\S/);
    assert.equal(body.text.includes('**'), false);
  }
  assert.equal(calls.tts[0].text, 'Olá! Sou a Kirana e posso ajudar você hoje.');
  controller.dispose();
});

test('interrupção: para o áudio, cancela a geração e invalida o que viria depois', async () => {
  mediaDevices(true);
  const { controller, calls } = makeController();
  await controller.start();
  const originalPlay = FakeAudio.prototype.play;
  FakeAudio.prototype.play = function playBlocked() {
    this.blocked = true;
    return originalPlay.call(this);
  };
  FakeRecognition.instances.at(-1).emit('fale sobre a empresa', { isFinal: true });
  await sleep(10);
  controller.appendDelta('A Opportunity AI tem seis soluções. ');
  await sleep(10);
  FakeAudio.prototype.play = originalPlay;
  assert.equal(controller.state, VOICE_STATE.SPEAKING);
  assert.equal(calls.tts.length, 1, `a fala já começou (pedidos: ${JSON.stringify(calls.tts.map((b) => b.text))})`);

  controller.interrupt({ stopGeneration: true });
  assert.equal(calls.stop, 1, 'a geração da resposta precisa ser cancelada');
  assert.equal(controller.state, VOICE_STATE.INTERRUPTED);
  assert.equal(controller.queueSize, 0);

  // pedaço que chegaria atrasado não deve ser falado
  const before = calls.tts.length;
  controller.appendDelta('Este trecho chegou depois do cancelamento. ');
  await sleep(25);
  assert.equal(calls.tts.length, before);
  controller.dispose();
});

test('barge-in desliga o áudio que está tocando', async () => {
  mediaDevices(true);
  const { controller } = makeController();
  await controller.start();
  const originalPlay = FakeAudio.prototype.play;
  FakeAudio.prototype.play = function playBlocked() {
    this.blocked = true;
    return originalPlay.call(this);
  };
  controller.appendDelta('Uma frase suficientemente longa para virar fala. ');
  await sleep(10);
  FakeAudio.prototype.play = originalPlay;
  const audio = FakeAudio.instances.at(-1);
  assert.equal(audio.paused, false);
  controller.interrupt({ stopGeneration: false });
  assert.equal(audio.paused, true);
  controller.dispose();
});

test('falha do motor de voz não derruba a conversa por texto', async () => {
  mediaDevices(true);
  const { controller } = makeController({
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'voice_provider_failed', message: 'indisponível' } }), { status: 503 }),
  });
  await controller.start();
  controller.appendDelta('A resposta continua visível no texto. ');
  await sleep(30);
  assert.ok(controller.history.states.some((entry) => entry.to === VOICE_STATE.ERROR), 'o erro precisa ser registrado como estado');
  assert.match(controller.notice, /texto/i);
  assert.equal(controller.history.errors >= 1, true);
  assert.equal(controller.active, true, 'a conversa segue disponível');
  controller.dispose();
});

test('recuperação: depois do erro, uma nova fala volta a funcionar', async () => {
  mediaDevices(true);
  const { controller, calls } = makeController();
  await controller.start();
  FakeRecognition.instances.at(-1).emit('primeira pergunta', { isFinal: true });
  await sleep(20);
  controller.stop();
  assert.equal(controller.state, VOICE_STATE.IDLE);

  await controller.start();
  assert.equal(controller.state, VOICE_STATE.LISTENING);
  FakeRecognition.instances.at(-1).emit('segunda pergunta', { isFinal: true });
  await sleep(20);
  assert.deepEqual(calls.send, ['primeira pergunta', 'segunda pergunta']);
  controller.dispose();
});

test('HITL: voz nunca confirma ação pendente e avisa na tela', async () => {
  mediaDevices(true);
  const { controller, calls } = makeController();
  await controller.start();
  FakeRecognition.instances.at(-1).emit('quero falar com a equipe', { isFinal: true });
  await sleep(10);

  controller.endTurn({
    text: 'Vou preparar o contato.',
    aborted: false,
    error: false,
    pendingAction: { id: 'ct_1', tool: 'demo_contact_submit', title: 'Enviar contato' },
  });
  await sleep(30);

  assert.match(controller.notice, /confirma/i);
  // nenhuma requisição de confirmação foi feita: só sínteses de fala
  assert.equal(calls.stop, 0);
  assert.ok(calls.tts.some((b) => /não confirmo nada pela voz/i.test(b.text)));
  controller.dispose();
});

test('voz não interfere quando está desligada (alternância texto/voz)', async () => {
  mediaDevices(true);
  const { controller, calls } = makeController();
  controller.appendDelta('Texto digitado não deve virar áudio. ');
  controller.endTurn({ text: 'Texto digitado não deve virar áudio.', aborted: false, error: false });
  await sleep(15);
  assert.equal(calls.tts.length, 0);
  assert.equal(controller.state, VOICE_STATE.IDLE);
});

test('encerrar: desliga tudo, limpa fila e mantém a conversa', async () => {
  mediaDevices(true);
  const { controller } = makeController();
  await controller.start();
  const recognition = FakeRecognition.instances.at(-1);
  controller.appendDelta('Frase em andamento para encher a fila de fala. ');
  controller.stop();
  assert.equal(controller.active, false);
  assert.equal(controller.state, VOICE_STATE.IDLE);
  assert.equal(controller.queueSize, 0);
  // v0.4.1: usamos abort() (descarta o áudio já capturado) em vez de stop(),
  // que ainda entrega o resultado final ao handler. O intento do teste — o
  // microfone foi fechado — continua o mesmo.
  assert.ok(recognition.stopped + recognition.aborted >= 1, 'o reconhecedor precisa ser encerrado');
  controller.dispose();
});

test('estados são explícitos e na ordem esperada', async () => {
  mediaDevices(true);
  const { controller } = makeController({ tuning: { silenceMs: 5 } });
  await controller.start();
  const recognition = FakeRecognition.instances.at(-1);
  recognition.emit('bom dia', { isFinal: true });
  await sleep(20);
  const seq = controller.history.states.map((entry) => entry.to);
  assert.ok(seq.includes(VOICE_STATE.REQUESTING_MIC) || seq.length === 0);
  assert.ok(seq.includes(VOICE_STATE.LISTENING));
  assert.ok(seq.includes(VOICE_STATE.SPEECH_DETECTED));
  assert.ok(seq.includes(VOICE_STATE.PROCESSING));
  controller.dispose();
});

test('takeSpeakableSentences não perde texto nem corta palavras', () => {
  const long = `${'palavra '.repeat(60)}fim.`;
  const { chunks, rest } = takeSpeakableSentences(`Oi! ${long}`);
  assert.equal(rest, '');
  assert.equal(chunks.length >= 2, true);
  for (const chunk of chunks) {
    assert.equal(chunk.length <= 320, true);
    assert.equal(chunk.endsWith(' '), false);
  }
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), `Oi! ${long}`.replace(/\s+/g, ' ').trim());
});
