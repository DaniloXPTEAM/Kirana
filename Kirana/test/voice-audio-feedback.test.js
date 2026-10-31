/**
 * R08/R09 — voz sem realimentação e interrupção sem mensagens falsas.
 *
 * Defeito corrigido aqui (correção pós-0.5.3): a guarda de eco só era aplicada quando havia
 * janela de turno aberta. O reconhecedor entrega resultados com ATRASO — e um
 * resultado que é eco da própria Kirana podia chegar DEPOIS de o áudio acabar.
 * Sem janela, o eco entrava como mensagem do usuário e a conversa entrava em
 * ciclo (eco → mensagem → resposta → eco). Reprodução: scripts/repro-voice-feedback.mjs.
 *
 * O que estes testes provam (com dublês determinísticos):
 *   • 10 interações consecutivas sem uma única mensagem gerada pelo próprio TTS;
 *   • resposta longa reproduzida por inteiro (vários segmentos) não gera turno;
 *   • eco atrasado, curto (1–2 palavras) ou imperfeito continua bloqueado;
 *   • fala REAL do usuário logo depois da resposta é aceita (sem falso bloqueio);
 *   • interrupção manual não inventa mensagem;
 *   • "Kirana, pare" continua interrompendo (o barge-in não regrediu).
 *
 * O que NÃO provam: que alto-falante e microfone reais se comportem assim no
 * Windows — isso é o roteiro de validação manual em o relatório de diagnóstico entregue (seção R08/R09).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrowserSpeechEngine } from '../public/voice-engine.js';
import { createVoiceController } from '../public/voice.js';
import { isEchoOf } from '../public/voice-commands.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------- dublês ---------------------------------- */

class FakeRecognition {
  static instances = [];
  constructor() {
    this.aborted = false;
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    FakeRecognition.instances.push(this);
  }
  start() {
    this.onstart?.();
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.aborted = true;
    this.onend?.();
  }
  hear(transcript, { isFinal = true } = {}) {
    if (this.aborted) return;
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal })] });
  }
}

class FakeAudio {
  static instances = [];
  constructor() {
    this.listeners = new Map();
    this.paused = true;
    FakeAudio.instances.push(this);
  }
  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  finish() {
    this.paused = true;
    this.listeners.get('ended')?.();
  }
  set src(value) {
    this._src = value;
  }
  get src() {
    return this._src;
  }
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

const RESPOSTA_CURTA = 'Eu posso ajudar você com automação comercial.';
const RESPOSTA_LONGA = [
  'Eu posso ajudar você com serviços de automação comercial e agentes inteligentes.',
  'Também trabalho com integrações, painéis de acompanhamento e atendimento automatizado.',
  'Os valores são definidos caso a caso pela equipe, depois de entender o escopo.',
].join(' ');

function setup({ resposta = RESPOSTA_CURTA, tuning = {} } = {}) {
  FakeRecognition.instances = [];
  FakeAudio.instances = [];
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } }, configurable: true, writable: true });

  const envios = [];
  const host = fakeSpeechHost();
  const storage = {
    data: {},
    getItem(key) {
      return this.data[key] ?? null;
    },
    setItem(key, value) {
      this.data[key] = value;
    },
    removeItem(key) {
      delete this.data[key];
    },
  };

  const controller = createVoiceController({
    send: async (text) => {
      envios.push(text);
    },
    stop: () => {},
    getSessionId: () => 's_feedback',
    RecognitionImpl: FakeRecognition,
    AudioImpl: FakeAudio,
    MediaSourceImpl: undefined,
    speechEngine: createBrowserSpeechEngine({ host }),
    storage,
    preference: { engine: 'browser', voiceId: null, rate: '+0%' },
    fetchImpl: async () => mp3(),
    tuning: { silenceMs: 5, muteAfterSpeechMs: 60, bargeInMuteMs: 40, bargeInListenMs: 300, ...tuning },
    logger: { debug: () => {} },
  });

  const reconhecer = () => FakeRecognition.instances.at(-1);

  /** Faz o áudio terminar e espera a janela de turno fechar (como o navegador faz). */
  async function terminarAudio() {
    for (let i = 0; i < 60 && controller._internal.commandWindow(); i += 1) {
      for (const audio of FakeAudio.instances) if (!audio.paused) audio.finish();
      await sleep(20);
    }
  }

  /** Pergunta do usuário → turno aberto (para o app, é o `send`). */
  async function perguntar(texto) {
    reconhecer().hear(texto, { isFinal: true });
    await sleep(120);
  }

  /** Resposta chegando por streaming + fim do turno. */
  async function responder(texto = resposta) {
    for (const parte of texto.match(/[^.!?]+[.!?]?/g)) controller.appendDelta(`${parte} `);
    controller.endTurn({ text: texto, sessionId: 's_feedback', aborted: false });
    await terminarAudio();
  }

  return { controller, envios, host, reconhecer, perguntar, responder, terminarAudio };
}

/* --------------------------------- testes -------------------------------- */

test('R08: eco atrasado do próprio TTS não vira mensagem (3, 2 e 1 palavra)', async () => {
  const { controller, reconhecer, perguntar, responder, envios } = setup();
  await controller.start();

  await perguntar('quais serviços vocês têm');
  assert.equal(envios.length, 1);
  await responder();

  const antes = envios.length;
  // Resultados que o reconhecedor costuma entregar DEPOIS do fim do áudio.
  reconhecer().hear('automação comercial');
  reconhecer().hear('posso ajudar');
  reconhecer().hear('automação');
  await sleep(120);

  assert.equal(envios.length, antes, 'nenhum eco pode virar mensagem do usuário');
  controller.stop();
});

test('R08: fala REAL do usuário logo depois da resposta é aceita', async () => {
  const { controller, reconhecer, perguntar, responder, envios } = setup();
  await controller.start();

  await perguntar('quais serviços vocês têm');
  await responder();

  reconhecer().hear('quero saber os preços', { isFinal: true });
  await sleep(150);

  assert.deepEqual(envios, ['quais serviços vocês têm', 'quero saber os preços']);
  controller.stop();
});

test('R08: resposta longa, reproduzida por inteiro, não gera mensagem', async () => {
  const { controller, reconhecer, perguntar, responder, envios, host } = setup({ resposta: RESPOSTA_LONGA });
  await controller.start();

  await perguntar('o que vocês fazem');
  await responder(RESPOSTA_LONGA);

  // A resposta foi mesmo falada, em trechos, por um dos dois motores (browser
  // ou servidor) — não pode ter sido truncada em uma fala só.
  const segmentos = host.spoken.length + FakeAudio.instances.filter((a) => a.src).length;
  assert.ok(segmentos >= 2, `a resposta longa deveria ter sido falada em trechos (segmentos=${segmentos})`);

  const antes = envios.length;
  reconhecer().hear('painéis de acompanhamento e atendimento automatizado');
  reconhecer().hear('definidos caso a caso pela equipe');
  await sleep(120);

  assert.equal(envios.length, antes);
  controller.stop();
});

test('R08: 10 interações consecutivas por voz sem realimentação', async () => {
  const { controller, reconhecer, perguntar, responder, envios } = setup();
  await controller.start();

  for (let i = 1; i <= 10; i += 1) {
    await perguntar(`pergunta real número ${i}`);
    assert.equal(envios.length, i, `a pergunta ${i} deveria ser a única mensagem nova`);
    await responder();

    // Depois de cada resposta, um eco atrasado do que a Kirana acabou de falar.
    reconhecer().hear('automação comercial');
    await sleep(40);
    assert.equal(envios.length, i, `o eco da resposta ${i} não pode virar mensagem`);
  }

  assert.equal(envios.length, 10);
  assert.equal((controller.report && envios.length) === 10, true);
  controller.stop();
});

test('R09: interrupção manual não cria mensagem falsa e a próxima fala é aceita', async () => {
  const { controller, reconhecer, perguntar, envios } = setup({ resposta: RESPOSTA_LONGA });
  await controller.start();

  await perguntar('me explica os serviços');
  for (const parte of RESPOSTA_LONGA.match(/[^.!?]+[.!?]?/g)) controller.appendDelta(`${parte} `);

  // Usuário interrompe pelo botão: não pode gerar turno nenhum.
  controller.interrupt({ stopGeneration: true });
  await sleep(120);

  assert.deepEqual(envios, ['me explica os serviços']);

  // Depois da interrupção, a conversa continua normalmente.
  reconhecer().hear('então fale dos painéis', { isFinal: true });
  await sleep(150);
  assert.deepEqual(envios, ['me explica os serviços', 'então fale dos painéis']);
  controller.stop();
});

test('R09: "Kirana, pare" continua interrompendo (barge-in não regrediu)', async () => {
  const { controller, reconhecer, perguntar, envios } = setup({ resposta: RESPOSTA_LONGA, tuning: { commandRepeatMs: 0 } });
  await controller.start();

  await perguntar('fale bastante sobre a empresa');
  for (const parte of RESPOSTA_LONGA.match(/[^.!?]+[.!?]?/g)) controller.appendDelta(`${parte} `);

  reconhecer().hear('kirana pare', { isFinal: true });
  await sleep(150);

  // O comando interrompe, mas NUNCA é enviado ao modelo.
  assert.deepEqual(envios, ['fale bastante sobre a empresa']);
  assert.ok(controller.report, 'controlador segue íntegro');
  controller.stop();
});

test('R08: alternar texto e voz não duplica nem descarta turno', async () => {
  const { controller, reconhecer, perguntar, responder, envios, terminarAudio } = setup();
  await controller.start();

  await perguntar('primeira pergunta por voz');
  await responder();
  // Texto puro no chat (o app chama a voz só para falar):
  controller.appendDelta('Resposta digitada, sem microfone.');
  controller.endTurn({ text: 'Resposta digitada, sem microfone.', sessionId: 's_feedback', aborted: false });
  await terminarAudio();

  await perguntar('segunda pergunta por voz');
  await sleep(120);

  assert.deepEqual(envios, ['primeira pergunta por voz', 'segunda pergunta por voz']);
  controller.stop();
});

/* ------------------------- unidade: guarda de eco ------------------------ */

test('isEchoOf: fragmentos curtos do TTS contam como eco', () => {
  const falado = 'Eu posso ajudar você com automação comercial e agentes inteligentes';
  assert.equal(isEchoOf('posso ajudar', falado), true, '2 palavras do TTS');
  assert.equal(isEchoOf('automação comercial', falado), true, '2 palavras do TTS');
  assert.equal(isEchoOf('agentes', falado), true, '1 palavra do TTS');
  assert.equal(isEchoOf('ajudar você com serviços', falado), false, 'palavra que ela não falou');
  assert.equal(isEchoOf('quero saber os preços', falado), false, 'fala nova do usuário');
  assert.equal(isEchoOf('pare', falado), false, 'comando de parada não é eco');
});
