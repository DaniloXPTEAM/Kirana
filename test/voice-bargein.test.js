/**
 * Barge-in por voz (v0.4.4) — interromper a Kirana falando "Kirana, pare".
 *
 * O que estes testes provam (com dublês determinísticos):
 *   • o microfone fica ABERTO durante a resposta (é o que permite o comando);
 *   • o comando cancela o áudio dos DOIS motores (navegador e servidor);
 *   • a fila, as requisições e as respostas atrasadas são descartadas;
 *   • o comando NÃO é enviado ao modelo e NÃO vira mensagem;
 *   • a Kirana volta a escutar e aceita a próxima fala;
 *   • a própria voz dela não dispara comando (proteção de autoescuta).
 *
 * O que estes testes NÃO provam: que o microfone e o alto-falante reais se
 * comportam assim no Windows. Isso é o roteiro de validação (docs/AUDITORIA-
 * VOZ-V0.4.4.md) — em especial se o reconhecedor do Edge ouve a própria voz.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrowserSpeechEngine } from '../public/voice-engine.js';
import { createVoiceController, VOICE_STATE } from '../public/voice.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  hear(transcript, { isFinal = true } = {}) {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal })] });
  }
}

/** Áudio do servidor: fica tocando até `finish()` (para poder interromper). */
class FakeAudio {
  static instances = [];
  constructor() {
    this.listeners = new Map();
    this.paused = true;
    this.currentTime = 0;
    this.playCount = 0;
    this.src = '';
    FakeAudio.instances.push(this);
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener() {}
  emit(name) {
    for (const fn of this.listeners.get(name) ?? []) fn();
  }
  play() {
    this.playCount += 1;
    this.paused = false;
    this.emit('playing');
    return Promise.resolve(); // só termina com finish()
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

/** Dublê de `speechSynthesis` com eventos fiéis (start/end/error). */
function fakeSpeechHost() {
  const spoken = [];
  const cancelled = [];
  const voice = { name: 'Microsoft Francisca Online (Natural)', lang: 'pt-BR', voiceURI: 'f', localService: true, default: true };
  const host = {
    SpeechSynthesisUtterance: class {
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
      getVoices: () => [voice],
      addEventListener() {},
      removeEventListener() {},
      speak(utterance) {
        spoken.push(utterance);
        setTimeout(() => {
          utterance.onstart?.(new Event('start'));
          // não emite 'end': a fala fica "acontecendo" até ser cancelada
        }, 1);
      },
      cancel() {
        cancelled.push(true);
      },
      get speaking() {
        return spoken.length > 0 && cancelled.length === 0;
      },
    },
  };
  return { host, spoken, cancelled };
}

function mp3Response() {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0xff, 0xf3, 1, 2, 3]));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
}

/**
 * @param {'browser'|'server'} engine  motor usado na fala
 */
function setup({ engine = 'server', tuning = {}, fetchImpl = null } = {}) {
  FakeRecognition.instances = [];
  FakeAudio.instances = [];
  globalThis.navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } };

  const calls = { send: [], stop: 0, tts: [] };
  const speech = fakeSpeechHost();
  const speechEngine = createBrowserSpeechEngine({ host: speech.host });
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
      calls.send.push(text);
    },
    stop: () => {
      calls.stop += 1;
    },
    getSessionId: () => 's_bargein',
    RecognitionImpl: FakeRecognition,
    AudioImpl: FakeAudio,
    MediaSourceImpl: undefined, // caminho "acumula e toca" (determinístico)
    speechEngine,
    storage,
    // 'server' é o nome de exibição; no controlador o motor é ENGINE.EDGE.
    preference: { engine: engine === 'server' ? 'edge' : 'browser', voiceId: null, rate: '+0%' },
    fetchImpl:
      fetchImpl ??
      (async (url, options) => {
        calls.tts.push(JSON.parse(options.body));
        return mp3Response();
      }),
    tuning: { silenceMs: 5, muteAfterSpeechMs: 40, bargeInMuteMs: 40, bargeInListenMs: 300, ...tuning },
    logger: { debug: () => {} },
  });

  return { controller, calls, speech };
}

/** Leva o controlador até o estado "falando", com áudio realmente tocando. */
async function falando(controller, { frase = 'Primeira frase longa o suficiente para virar áudio. ' } = {}) {
  const mic = FakeRecognition.instances.at(-1);
  mic.hear('me fale sobre os serviços', { isFinal: true });
  await sleep(20);
  controller.appendDelta(frase);
  await sleep(80); // pedido de TTS + começo da reprodução
  return mic;
}

/* --------------------------- 1. o comando existe -------------------------- */

test('1. "Kirana, pare" durante a fala do SERVIDOR interrompe', async () => {
  const { controller, calls } = setup({ engine: 'server' });
  await controller.start();
  const mic = await falando(controller);
  assert.equal(controller.state, VOICE_STATE.SPEAKING);

  mic.hear('Kirana, pare', { isFinal: true });
  await sleep(20);

  assert.equal(controller.state, VOICE_STATE.INTERRUPTED, 'precisa sair de "falando"');
  assert.equal(controller.history.bargeIns, 1);
  assert.deepEqual(calls.send, ['me fale sobre os serviços'], 'o comando virou pergunta para o modelo');
  assert.equal(calls.stop, 1, 'a geração da resposta precisa ser cancelada');
  controller.dispose();
});

test('2. "Kirana, pare" durante a fala do NAVEGADOR interrompe', async () => {
  const { controller, calls, speech } = setup({ engine: 'browser' });
  await controller.start();
  const mic = await falando(controller);
  assert.equal(controller.state, VOICE_STATE.SPEAKING);
  assert.equal(speech.spoken.length >= 1, true, 'o motor do navegador precisa ter falado');

  mic.hear('Kirana, pare', { isFinal: true });
  await sleep(20);

  assert.equal(controller.state, VOICE_STATE.INTERRUPTED);
  assert.equal(controller.history.bargeIns, 1);
  assert.equal(speech.cancelled.length >= 1, true, 'speechSynthesis.cancel() precisa ser chamado');
  assert.deepEqual(calls.send, ['me fale sobre os serviços']);
  controller.dispose();
});

test('3. variações fonéticas do comando interrompem', async () => {
  for (const comando of ['Quirana, pare', 'Kirana, para', 'Pare de falar', 'Pode parar, Kirana', 'Kirana, silêncio']) {
    const { controller } = setup({ engine: 'server' });
    await controller.start();
    const mic = await falando(controller);
    mic.hear(comando, { isFinal: true });
    await sleep(20);
    assert.equal(controller.state, VOICE_STATE.INTERRUPTED, `não interrompeu com: ${comando}`);
    controller.dispose();
  }
});

/* ---------------------- 2. cancelamento de verdade ------------------------ */

test('4. o comando cancela o áudio que está tocando e a fila pendente', async () => {
  const { controller } = setup({ engine: 'server' });
  await controller.start();
  const mic = FakeRecognition.instances.at(-1);
  mic.hear('fale bastante', { isFinal: true });
  await sleep(20);
  controller.appendDelta('Primeira frase longa o suficiente para tocar. Segunda frase longa o suficiente. ');
  await sleep(80);

  const audio = FakeAudio.instances.at(-1);
  assert.equal(audio.paused, false, 'deveria estar tocando');
  const enfileirados = controller.queueSize;

  mic.hear('Kirana, pare', { isFinal: true });
  await sleep(20);

  assert.equal(audio.paused, true, 'o MP3 precisa parar de imediato');
  assert.equal(controller.queueSize, 0, `a fila (${enfileirados}) precisa ser descartada`);
  controller.dispose();
});

test('5. resposta de rede atrasada não volta a tocar depois do comando', async () => {
  let liberar;
  const respostaPresa = new Promise((resolve) => {
    liberar = resolve;
  });
  const { controller } = setup({
    engine: 'server',
    fetchImpl: async () => {
      await respostaPresa; // o TTS só responde DEPOIS do comando
      return mp3Response();
    },
  });
  await controller.start();
  const mic = FakeRecognition.instances.at(-1);
  mic.hear('fale algo', { isFinal: true });
  await sleep(20);
  controller.appendDelta('Uma frase longa o suficiente para pedir áudio. ');
  await sleep(30);

  mic.hear('Kirana, pare', { isFinal: true });
  await sleep(20);
  liberar();
  await sleep(120);

  const tocados = FakeAudio.instances.filter((a) => a.playCount > 0);
  assert.equal(tocados.length, 0, 'áudio obsoleto voltou a tocar depois da interrupção');
  assert.equal(controller.state !== VOICE_STATE.SPEAKING, true);
  controller.dispose();
});

test('6. interrupções consecutivas não deixam áudio antigo tocar', async () => {
  const { controller } = setup({ engine: 'server' });
  await controller.start();
  const mic = FakeRecognition.instances.at(-1);

  for (let i = 1; i <= 3; i += 1) {
    mic.hear(`pergunta ${i}`, { isFinal: true });
    await sleep(20);
    controller.appendDelta(`Resposta ${i} com uma frase longa o suficiente. `);
    await sleep(60);
    mic.hear('Kirana, pare', { isFinal: true });
    await sleep(30);
    assert.equal(controller.history.bargeIns, i, `interrupção ${i} não registrada`);
  }
  await sleep(80);
  const tocandoAgora = FakeAudio.instances.filter((a) => !a.paused);
  assert.equal(tocandoAgora.length, 0, 'sobrou áudio tocando depois das interrupções');
  controller.dispose();
});

/* ------------------- 3. o comando não vira mensagem ---------------------- */

test('7. o comando não é enviado ao modelo e não vira mensagem', async () => {
  const { controller, calls } = setup({ engine: 'server' });
  await controller.start();
  const mic = await falando(controller);
  mic.hear('Kirana, pare', { isFinal: true });
  await sleep(40);
  assert.deepEqual(calls.send, ['me fale sobre os serviços']);
  assert.equal(controller._internal.transcript, '', 'a ordem ficou no buffer da transcrição');
  controller.dispose();
});

test('8. "Kirana, pare" quando ela NÃO está falando também não vira pergunta', async () => {
  const { controller, calls } = setup({ engine: 'server' });
  await controller.start();
  const mic = FakeRecognition.instances.at(-1);
  mic.hear('Kirana, pare', { isFinal: true });
  await sleep(40);
  assert.deepEqual(calls.send, [], 'a ordem foi enviada ao modelo');
  assert.equal(controller.history.commandsIgnored, 1);
  assert.match(controller.notice, /não estou falando/i);
  controller.dispose();
});

/* -------------------- 4. volta a escutar e continua --------------------- */

test('9. depois do comando, volta a ouvir e aceita a próxima pergunta', async () => {
  const { controller, calls } = setup({ engine: 'server' });
  await controller.start();
  const mic = await falando(controller);

  mic.hear('Kirana, pare', { isFinal: true });
  await sleep(60); // janela curta pós-barge-in
  assert.ok(
    [VOICE_STATE.INTERRUPTED, VOICE_STATE.LISTENING].includes(controller.state),
    `estado inesperado: ${controller.state}`,
  );

  mic.hear('e sobre o crm?', { isFinal: true });
  await sleep(40);
  assert.deepEqual(calls.send, ['me fale sobre os serviços', 'e sobre o crm?'], 'a conversa não continuou');
  controller.dispose();
});

test('10. depois do comando a resposta nova é falada normalmente', async () => {
  const { controller, speech } = setup({ engine: 'browser' });
  await controller.start();
  const mic = await falando(controller);
  mic.hear('Kirana, pare', { isFinal: true });
  await sleep(60);

  mic.hear('qual o prazo do projeto?', { isFinal: true });
  await sleep(40);
  controller.appendDelta('O prazo é de quatro semanas. ');
  await sleep(60);

  const textos = speech.spoken.map((u) => u.text);
  assert.equal(
    textos.some((t) => /quatro semanas/.test(t)),
    true,
    `a resposta nova não foi falada: ${JSON.stringify(textos)}`,
  );
  controller.dispose();
});

/* -------------------------- 5. sem falso positivo ------------------------ */

test('11. pergunta comum durante a fala não interrompe', async () => {
  const { controller, calls } = setup({ engine: 'server' });
  await controller.start();
  const mic = await falando(controller);
  for (const fala of ['por que o WhatsApp para de funcionar?', 'quanto custa o plano?', 'me fale do crm']) {
    mic.hear(fala, { isFinal: true });
    await sleep(15);
  }
  assert.equal(controller.history.bargeIns, 0, 'falso positivo de interrupção');
  assert.equal(controller.state, VOICE_STATE.SPEAKING);
  assert.deepEqual(calls.send, ['me fale sobre os serviços']);
  controller.dispose();
});

test('12. a própria voz da Kirana não dispara comando (autoescuta)', async () => {
  const { controller } = setup({ engine: 'server' });
  await controller.start();
  const mic = await falando(controller, { frase: 'Se quiser, eu posso parar de falar e esperar. ' });
  // o alto-falante devolve o que ela mesma disse, e a transcrição erra o final
  mic.hear('se quiser eu posso parar de falar e esperar', { isFinal: true });
  await sleep(30);
  assert.equal(controller.history.bargeIns, 0, 'a fala da própria Kirana interrompeu a si mesma');
  assert.equal(controller.history.echoBlocked >= 1, true, 'o eco precisa ser contado');
  controller.dispose();
});

/* --------------------------- 6. diagnóstico ----------------------------- */

test('13. a latência do comando é medida e registrada', async () => {
  const { controller } = setup({ engine: 'server' });
  await controller.start();
  const mic = await falando(controller);
  mic.hear('Kirana, pare', { isFinal: true });
  await sleep(20);

  const [registro] = controller.bargeIns;
  assert.ok(registro, 'nenhum comando registrado');
  assert.equal(registro.keyword, 'pare');
  assert.equal(typeof registro.latencyMs, 'number');
  assert.equal(registro.latencyMs >= 0, true);
  assert.ok(registro.audioStoppedAt >= registro.detectedAt);
  assert.equal(registro.engine, 'edge');

  const relatorio = await controller.report();
  assert.equal(relatorio.bargeIns.length, 1);
  assert.equal(relatorio.counters.bargeIns, 1);
  assert.equal(relatorio.echoGuard.micDuringPlayback, true, 'o microfone precisa estar aberto durante a fala');
  controller.dispose();
});

test('14. o microfone continua aberto durante a fala (é o que permite o comando)', async () => {
  const { controller } = setup({ engine: 'server' });
  await controller.start();
  await falando(controller);
  assert.equal(controller._internal.isRecognizerLive(), true);
  assert.equal(controller._internal.micSuspended(), false);
  assert.ok(controller._internal.commandWindow(), 'deveria estar na janela de comando');
  controller.dispose();
});

/* ------------------- 7. o que a v0.4.3 já garantia ---------------------- */

test('15. o comando não faz o Markdown voltar a ser falado', async () => {
  const { controller, speech } = setup({ engine: 'browser' });
  await controller.start();
  const mic = await falando(controller, { frase: '**Modelo utilizado:** GPT-6. ' });
  const falado = speech.spoken.map((u) => u.text).join(' ');
  assert.equal(/[*_`#]/.test(falado), false, `símbolo de markdown falado: ${falado}`);
  assert.match(falado, /Modelo utilizado/);

  mic.hear('Kirana, pare', { isFinal: true });
  await sleep(20);
  assert.equal(controller.history.bargeIns, 1);
  controller.dispose();
});

test('16. a interrupção pelo botão continua funcionando igual', async () => {
  const { controller } = setup({ engine: 'server' });
  await controller.start();
  await falando(controller);
  await controller.toggle(); // toque no botão durante a fala
  assert.equal(controller.state, VOICE_STATE.INTERRUPTED);
  assert.ok(controller.history.states.some((s) => s.to === VOICE_STATE.INTERRUPTED && s.reason === 'manual'));
  controller.dispose();
});

test('17. interromper enquanto a resposta está sendo PROCESSADA (sem áudio ainda)', async () => {
  const { controller, calls } = setup({ engine: 'server' });
  await controller.start();
  const mic = FakeRecognition.instances.at(-1);
  mic.hear('fale sobre os planos', { isFinal: true });
  await sleep(20);
  assert.equal(controller.state, VOICE_STATE.PROCESSING);

  mic.hear('Kirana, pare', { isFinal: true });
  await sleep(20);
  assert.equal(controller.history.bargeIns, 1, 'o comando não interrompeu o processamento');
  assert.equal(calls.stop, 1, 'a geração precisa ser abortada');
  assert.deepEqual(calls.send, ['fale sobre os planos']);
  controller.dispose();
});

test('18. comando de uma palavra dito durante a fala interrompe', async () => {
  const { controller } = setup({ engine: 'server' });
  await controller.start();
  const mic = await falando(controller, { frase: 'A Opportunity tem seis frentes de trabalho. ' });
  mic.hear('pare', { isFinal: false }); // interino, uma palavra
  await sleep(20);
  assert.equal(controller.history.bargeIns, 1, '"pare" (interino) não interrompeu');
  controller.dispose();
});

test('19. interino repetido não gera duas interrupções nem mensagens duplicadas', async () => {
  const { controller, calls } = setup({ engine: 'server' });
  await controller.start();
  const mic = await falando(controller);
  mic.hear('Kirana, pare', { isFinal: false });
  mic.hear('Kirana, pare', { isFinal: false });
  mic.hear('Kirana, pare', { isFinal: true });
  await sleep(40);
  assert.equal(controller.history.bargeIns, 1, 'mais de uma interrupção pela mesma ordem');
  assert.deepEqual(calls.send, ['me fale sobre os serviços']);
  controller.dispose();
});
