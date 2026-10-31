/**
 * Reconhecedor CUMULATIVO — o comportamento real do SpeechRecognition contínuo.
 *
 * Em modo `continuous`, o navegador mantém em `event.results` TODOS os resultados
 * desde que a sessão abriu e informa em `event.resultIndex` qual é o primeiro que
 * mudou. A sessão da Kirana nunca é recriada (v0.4.4, para ouvir "Kirana, pare"),
 * então a lista só cresce. Se o controlador lê `results` desde o índice 0, as falas
 * antigas do usuário e os ecos antigos da própria voz voltam a entrar a cada evento
 * e viram uma mensagem única: "pergunta antiga + resposta da Kirana" — que a guarda
 * de eco não reconhece (a sobreposição fica abaixo de 80%).
 *
 * Os dublês dos outros testes mandam sempre UM resultado com resultIndex 0 e por isso
 * nunca reproduziram isso. Este arquivo reproduz.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createVoiceController } from '../public/voice.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CumulativeRecognition {
  static instances = [];
  constructor() {
    this.list = [];
    CumulativeRecognition.instances.push(this);
  }
  start() {
    this.onstart?.();
  }
  stop() {}
  abort() {}
  /** Entrega um resultado do jeito do navegador: lista acumulada + resultIndex do que mudou. */
  hear(transcript, { isFinal = true } = {}) {
    const last = this.list.at(-1);
    if (last && !last.isFinal) this.list.pop(); // o interino é substituído pelo seu final
    const entry = Object.assign([{ transcript }], { isFinal });
    this.list.push(entry);
    this.onresult?.({ resultIndex: this.list.length - 1, results: this.list });
  }
}

class FakeAudio {
  constructor() {
    this.listeners = new Map();
    this.paused = true;
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) {
    this.listeners.get(name)?.delete(fn);
  }
  fire(name) {
    for (const fn of this.listeners.get(name) ?? []) fn();
  }
  play() {
    this.paused = false;
    this.fire('playing');
    setTimeout(() => {
      this.paused = true;
      this.fire('ended');
    }, 1);
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  load() {}
}

function mp3() {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([0xff, 0xf3, ...new Array(254).fill(7)]));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
}

function setup() {
  CumulativeRecognition.instances = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    configurable: true,
    writable: true,
  });
  const sent = [];
  const controller = createVoiceController({
    send: async (text) => {
      sent.push(text);
    },
    stop: () => {},
    getSessionId: () => 's_teste',
    RecognitionImpl: CumulativeRecognition,
    AudioImpl: FakeAudio,
    MediaSourceImpl: undefined,
    fetchImpl: async (url) => {
      if (String(url).includes('/api/voice/diagnostics')) return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      return mp3();
    },
    tuning: { silenceMs: 5, restartDelayMs: 0 },
    logger: { debug: () => {} },
  });
  return { controller, sent, mic: () => CumulativeRecognition.instances.at(-1) };
}

async function waitFor(cond, ms = 2500) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condição não atendida no prazo');
    await sleep(10);
  }
}

/** Espera o microfone voltar a aceitar fala (fora da janela de comando). */
const waitMic = (controller) =>
  waitFor(() => controller._internal.isRecognizerLive() && !controller._internal.commandWindow());

const PERGUNTA = 'Posso corrigir esse erro que tu fica ouvindo você mesma e respondendo você mesmo';
const RESPOSTA = 'Pode sim. Foi um erro meu. Interpretei sua repetição como se você estivesse falando de outra pessoa.';

/** Usuário pergunta e a Kirana responde falando; devolve quando o microfone voltou. */
async function umTurnoCompleto({ controller, sent, mic }) {
  await controller.start();
  mic().hear(PERGUNTA);
  await waitFor(() => sent.length === 1);
  controller.appendDelta(RESPOSTA);
  controller.endTurn();
  await sleep(50);
  await waitMic(controller);
}

test('eco tardio da resposta NÃO reenvia a pergunta antiga junto (lista cumulativa)', async () => {
  const ctx = setup();
  try {
    await umTurnoCompleto(ctx);
    // O navegador entrega o eco da resposta como um NOVO resultado; a lista agora é [pergunta, eco].
    ctx.mic().hear('Pode sim. Foi um erro meu. Interpretei sua repetição como se você estivesse falando de outra pessoa');
    await sleep(120);
    assert.equal(ctx.sent.length, 1, `nada novo deveria ter sido enviado; enviado: ${JSON.stringify(ctx.sent)}`);
    assert.equal(ctx.sent[0], PERGUNTA);
  } finally {
    ctx.controller.dispose();
  }
});

test('nova fala real do usuário é enviada SOZINHA, sem as falas e ecos anteriores', async () => {
  const ctx = setup();
  try {
    await umTurnoCompleto(ctx);
    ctx.mic().hear('Pode sim. Foi um erro meu. Interpretei sua repetição como se você estivesse falando de outra pessoa');
    await sleep(60);
    await sleep(2600); // passa a janela da guarda de eco: a próxima fala é do usuário
    await waitMic(ctx.controller);
    ctx.mic().hear('Quais serviços a Opportunity oferece');
    await waitFor(() => ctx.sent.length === 2);
    assert.equal(ctx.sent[1], 'Quais serviços a Opportunity oferece', `veio misturado: ${JSON.stringify(ctx.sent[1])}`);
  } finally {
    ctx.controller.dispose();
  }
});
