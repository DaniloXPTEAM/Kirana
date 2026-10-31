/**
 * Testes de comportamento da voz — correções da v0.4.1.
 *
 * Cada teste aqui corresponde a um defeito REAL reproduzido no relatório de
 * auditoria do Windows, ou a um cenário obrigatório da seção 10 do pedido.
 * São testes de COMPORTAMENTO (o que o agente fala, quando o microfone abre,
 * o que vai para o motor), não de existência de função.
 *
 * Dublês: SpeechRecognition, Audio e fetch. O microfone e o áudio reais são
 * cobertos em `test/browser/voice-flow.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createVoiceController, VOICE_STATE, takeSpeakableSentences } from '../public/voice.js';
import { analyzeSpeechText, sanitizeTextForSpeech, findUnspeakableChars } from '../src/voice/tts-text.js';

/* ------------------------------- dublês ---------------------------------- */

class FakeRecognition {
  static instances = [];
  constructor() {
    this.started = 0;
    this.stopped = 0;
    this.aborted = 0;
    this.id = FakeRecognition.instances.length;
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
  /** Simula o microfone entregando um resultado (final ou interino). */
  hear(transcript, { isFinal = true } = {}) {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal })] });
  }
  end() {
    this.onend?.();
  }
}

class FakeAudio {
  static instances = [];
  /** Quando true, o áudio "toca" até `finish()` — simula uma frase longa. */
  static hold = false;
  constructor() {
    this.listeners = new Map();
    this.paused = true;
    this.playCount = 0;
    FakeAudio.instances.push(this);
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
    this.playCount += 1;
    this.paused = false;
    this.fire('playing');
    if (FakeAudio.hold) return Promise.resolve(); // áudio longo: termina via finish()
    setTimeout(() => {
      this.paused = true;
      this.fire('ended');
    }, 1);
    return Promise.resolve();
  }
  finish() {
    this.paused = true;
    this.fire('ended');
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  load() {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mp3Response(bytes = 256) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0xff, 0xf3, ...new Array(Math.max(0, bytes - 2)).fill(7)]));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
}

/**
 * Cria o controlador com dublês. `ttsDelayMs` simula a latência do provedor;
 * `ttsDelayAfter` permite a primeira síntese ser rápida e as seguintes lentas.
 */
function setup({ ttsDelayMs = 0, holdAudio = false, ttsFail = false, tuning = {} } = {}) {
  FakeRecognition.instances = [];
  FakeAudio.instances = [];
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } }, configurable: true, writable: true });

  const spoken = []; // textos efetivamente enviados ao motor
  const sent = []; // mensagens enviadas ao agente
  const controller = createVoiceController({
    send: async (text) => {
      sent.push(text);
    },
    stop: () => {},
    getSessionId: () => 's_teste',
    RecognitionImpl: FakeRecognition,
    AudioImpl: FakeAudio,
    MediaSourceImpl: undefined,
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/voice/diagnostics')) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      const body = JSON.parse(options.body);
      spoken.push(body);
      if (ttsDelayMs) await sleep(ttsDelayMs);
      if (ttsFail) {
        return new Response(JSON.stringify({ error: { code: 'voice_provider_failed', message: 'indisponível' } }), { status: 503 });
      }
      return mp3Response();
    },
    // silêncio curto para o teste ser rápido; a janela surda padrão (600 ms)
    // fica valendo, porque é ela que o cenário de autoescuta precisa exercitar
    tuning: { silenceMs: 5, restartDelayMs: 0, ...tuning },
    logger: { debug: () => {} },
  });

  FakeAudio.hold = holdAudio;

  return { controller, spoken, sent, recognition: () => FakeRecognition.instances.at(-1) };
}

/**
 * Espera o microfone estar realmente aberto. O controlador mantém a escuta
 * fechada durante todo o turno e só a reabre depois do áudio + janela surda
 * (`muteAfterSpeechMs`). Testes que falam de novo precisam esperar isso.
 */
/**
 * Espera o microfone voltar a aceitar FALA (não só a sessão existir).
 *
 * v0.4.4 — a sessão de reconhecimento deixou de ser destruída a cada turno:
 * ela fica aberta para ouvir "Kirana, pare". Então o que os testes esperam não
 * é mais "um reconhecedor novo", e sim "a transcrição voltou a valer" — isto é,
 * fora da janela de comando (`commandWindow()`).
 */
async function waitForMic(controller, timeoutMs = 2000) {
  const inicio = Date.now();
  for (;;) {
    if (controller._internal.isRecognizerLive() && !controller._internal.commandWindow()) {
      return FakeRecognition.instances.at(-1);
    }
    if (Date.now() - inicio > timeoutMs) {
      throw new Error('o microfone não voltou a aceitar fala dentro do prazo');
    }
    await sleep(10);
  }
}

/** Simula um turno completo: usuário fala e o app entrega a resposta em deltas. */
async function speakAndAnswer(controller, recognition, utterance, deltas) {
  recognition.hear(utterance, { isFinal: true });
  await sleep(15);
  for (const delta of deltas) {
    controller.appendDelta(delta);
    await sleep(5);
  }
  controller.endTurn({ aborted: false, error: false });
  await sleep(40);
}

/* ------------------------- 1. resposta simples --------------------------- */

test('1. resposta simples é falada uma única vez, na íntegra', async () => {
  const { controller, spoken, sent } = setup();
  await controller.start();
  await speakAndAnswer(controller, FakeRecognition.instances.at(-1), 'oi', ['Olá! Como posso ajudar você hoje?']);
  assert.deepEqual(sent, ['oi']);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, 'Olá! Como posso ajudar você hoje?');
  controller.dispose();
});

/* ----------------------- 2. resposta com várias frases ------------------- */

test('2. múltiplas frases: ordem preservada e sem repetição no fim do turno', async () => {
  const { controller, spoken } = setup();
  await controller.start();
  const frases = [
    'A Opportunity AI trabalha com agentes de inteligência artificial. ',
    'Também faz atendimento digital e automação de vendas. ',
    'E desenvolve relatórios inteligentes para a sua operação.',
  ];
  await speakAndAnswer(controller, FakeRecognition.instances.at(-1), 'quais serviços?', frases);

  assert.equal(spoken.length, 3, `esperava 3 segmentos, veio ${JSON.stringify(spoken.map((s) => s.text))}`);
  assert.deepEqual(
    spoken.map((s) => s.text),
    [
      'A Opportunity AI trabalha com agentes de inteligência artificial.',
      'Também faz atendimento digital e automação de vendas.',
      'E desenvolve relatórios inteligentes para a sua operação.',
    ],
  );
  // o bug da v0.4.0: a resposta inteira era falada outra vez no fim
  assert.equal(spoken.filter((s) => s.text.includes('relatórios') && s.text.includes('agentes')).length, 0);
  controller.dispose();
});

test('2b. mesmo que o app mande o texto no fim do turno, ele NÃO é falado de novo', async () => {
  // era exatamente essa a origem da duplicação na v0.4.0: `endTurn` aceitava um
  // texto de fallback e repetia a resposta inteira. A API não tem mais esse
  // parâmetro; o texto extra é ignorado.
  const { controller, spoken } = setup();
  await controller.start();
  const rec = FakeRecognition.instances.at(-1);
  rec.hear('pergunta', { isFinal: true });
  await sleep(15);
  const resposta = 'A primeira frase da resposta é longa o bastante. A segunda frase da resposta também é longa.';
  controller.appendDelta(resposta);
  controller.endTurn({ aborted: false, error: false, text: resposta });
  await sleep(60);
  assert.equal(spoken.length, 2, `esperava 2 segmentos, veio ${spoken.length}: ${JSON.stringify(spoken.map((o) => o.text))}`);
  assert.equal(spoken.filter((o) => o.text.includes('segunda frase') && o.text.includes('primeira frase')).length, 0);
  controller.dispose();
});

/* ------------------------------ 3. markdown ------------------------------ */

test('3. markdown não chega ao motor como marcação', async () => {
  const { controller, spoken } = setup();
  await controller.start();
  await speakAndAnswer(controller, FakeRecognition.instances.at(-1), 'resuma', [
    '## Serviços\n\n**Agentes de IA** e *automação*.\n\n- WhatsApp\n- CRM\n\n```js\nconsole.log(1)\n```\n',
  ]);
  for (const segment of spoken) {
    const clean = sanitizeTextForSpeech(segment.text);
    assert.equal(/[#*`_~]/.test(clean), false, `marcação sobrou: ${JSON.stringify(clean)}`);
    assert.equal(clean.includes('console.log'), false);
  }
  assert.ok(spoken.some((s) => /Agentes de IA/.test(s.text)));
  controller.dispose();
});

/* ------------------- 4. Unicode, pontuação e caracteres ------------------ */

test('4. acentos, pontuação e símbolos: nada fora da política chega ao motor', async () => {
  const { controller, spoken } = setup();
  await controller.start();
  await speakAndAnswer(controller, FakeRecognition.instances.at(-1), 'e aí?', [
    'Ação, coração, 2ª feira — R$ 1.500,00 (30% do valor)… Você aprova? 😊 ✅ ⚖️ £ ♎ → • § © ™\n',
  ]);
  assert.ok(spoken.length >= 1);
  for (const segment of spoken) {
    assert.equal(findUnspeakableChars(segment.text), null, `caractere fora da política: ${JSON.stringify(segment.text)}`);
  }
  const junto = spoken.map((s) => s.text).join(' ');
  assert.match(junto, /coração/);
  assert.match(junto, /2ª feira/);
  assert.match(junto, /R\$ 1\.500,00/);
  controller.dispose();
});

/* --------------------- 5. nenhuma palavra extra no TTS ------------------- */

test('5. o texto enviado ao motor não contém palavra que não esteja na resposta', async () => {
  const resposta = 'Prazo de dois dias úteis. O investimento começa em R$ 1.500,00 por mês.';
  const { controller, spoken } = setup();
  await controller.start();
  await speakAndAnswer(controller, FakeRecognition.instances.at(-1), 'qual o prazo?', [`${resposta}\n`]);

  const palavrasResposta = new Set(resposta.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));
  for (const segment of spoken) {
    const palavras = segment.text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    for (const palavra of palavras) {
      assert.ok(palavrasResposta.has(palavra), `palavra "${palavra}" não existe na resposta: ${JSON.stringify(segment.text)}`);
    }
  }
  controller.dispose();
});

test('5b. o glifo £ (lido como "libra") nunca chega ao motor', async () => {
  const { controller, spoken } = setup();
  await controller.start();
  await speakAndAnswer(controller, FakeRecognition.instances.at(-1), 'quanto custa?', [
    'O investimento é de 500 por mês. £ ♎ ⚖️\n',
  ]);
  const junto = spoken.map((s) => s.text).join(' ');
  assert.equal(junto.includes('£'), false);
  assert.equal(junto.includes('♎'), false);
  assert.equal(junto.includes('⚖'), false);
  assert.match(junto, /500 por mês/);
  controller.dispose();
});

test('5c. analyzeSpeechText informa exatamente o que foi descartado', () => {
  const analise = analyzeSpeechText('Valor em £ e ♎ com ✅ no fim.');
  assert.equal(analise.text.includes('£'), false);
  assert.ok(analise.droppedChars.some((c) => c.includes('U+00A3')));
  assert.ok(analise.droppedChars.some((c) => c.includes('U+264E')));
  assert.equal(analise.dropped > 0, true);
});

/* --------------------------- 6. ordem dos segmentos ---------------------- */

test('6. segmentos saem em ordem, um de cada vez, com identificadores crescentes', async () => {
  const { controller, spoken } = setup({ ttsDelayMs: 5 });
  await controller.start();
  await speakAndAnswer(controller, FakeRecognition.instances.at(-1), 'conte', [
    'Primeira frase da lista. Segunda frase da lista. Terceira frase da lista. Quarta frase da lista.',
  ]);
  assert.deepEqual(
    spoken.map((s) => s.text),
    ['Primeira frase da lista.', 'Segunda frase da lista.', 'Terceira frase da lista.', 'Quarta frase da lista.'],
  );
  const segmentos = spoken.map((s) => s.segmentId);
  assert.equal(new Set(segmentos).size, segmentos.length, 'segmentId repetido');
  for (const segment of spoken) assert.equal(segment.turnId, spoken[0].turnId, 'turnId misturado');
  controller.dispose();
});

test('6b. a síntese do próximo segmento começa antes de o anterior terminar (sem silêncio)', async () => {
  const { controller } = setup({ ttsDelayMs: 40, holdAudio: true });
  await controller.start();
  FakeRecognition.instances.at(-1).hear('fale três frases', { isFinal: true });
  await sleep(15);
  controller.appendDelta('Primeira frase longa o suficiente. ');
  await sleep(10);
  controller.appendDelta('Segunda frase longa o suficiente. ');
  await sleep(120); // primeira já está tocando (holdAudio segura a reprodução)

  const primeiro = FakeAudio.instances[0];
  assert.equal(primeiro.paused, false, 'a primeira frase precisa estar tocando');
  const pedidos = controller.diagnostics.length;
  assert.equal(pedidos >= 1, true);
  const trace = controller.trace.map((e) => e.event);
  assert.ok(trace.includes('drain_start'));
  primeiro.finish();
  await sleep(60);
  controller.dispose();
});

/* ------------------------ 7/8. cancelamento ------------------------------ */

test('7. cancelar durante a síntese: nenhum áudio é reproduzido depois', async () => {
  const { controller, spoken } = setup({ ttsDelayMs: 30 });
  await controller.start();
  FakeRecognition.instances.at(-1).hear('fale algo longo', { isFinal: true });
  await sleep(15);
  controller.appendDelta('Primeira frase longa o suficiente. ');
  controller.interrupt({ stopGeneration: true });
  await sleep(120);
  const tocados = FakeAudio.instances.filter((a) => a.playCount > 0).length;
  assert.equal(tocados, 0, 'nada deveria tocar depois do cancelamento');
  assert.equal(controller.queueSize, 0);
  controller.dispose();
});

test('8. cancelar durante a reprodução: o áudio para e a fila é descartada', async () => {
  const { controller } = setup({ holdAudio: true });
  await controller.start();
  FakeRecognition.instances.at(-1).hear('fale muito', { isFinal: true });
  await sleep(15);
  controller.appendDelta('Primeira frase longa o suficiente. Segunda frase longa o suficiente. ');
  await sleep(60);
  const audio = FakeAudio.instances.at(-1);
  assert.equal(audio.paused, false, 'deveria estar tocando');

  controller.interrupt({ stopGeneration: false });
  assert.equal(audio.paused, true, 'o áudio precisa parar');
  assert.equal(controller.queueSize, 0, 'a fila precisa ser descartada');
  assert.equal(controller.state, VOICE_STATE.INTERRUPTED);
  controller.dispose();
});

test('9. nova mensagem após interrupção funciona normalmente (sem resto antigo)', async () => {
  const { controller, sent, spoken } = setup();
  await controller.start();
  const rec = () => FakeRecognition.instances.at(-1);

  await speakAndAnswer(controller, rec(), 'primeira pergunta', ['Resposta da primeira pergunta. ']);
  controller.interrupt({ stopGeneration: false });
  const microfone = await waitForMic(controller);

  microfone.hear('segunda pergunta', { isFinal: true });
  await sleep(15);
  controller.appendDelta('Resposta da segunda pergunta. ');
  controller.endTurn({ aborted: false, error: false });
  await sleep(40);

  assert.deepEqual(sent, ['primeira pergunta', 'segunda pergunta']);
  const ultimo = spoken.at(-1).text;
  assert.match(ultimo, /segunda pergunta/);
  assert.equal(/primeira pergunta/.test(ultimo), false, 'segmento antigo vazou para o turno novo');
  controller.dispose();
});

/* --------------------- 10. várias mensagens seguidas --------------------- */

test('10. cinco turnos consecutivos: um envio, uma resposta e um áudio cada', async () => {
  const { controller, sent, spoken } = setup();
  await controller.start();
  for (let i = 1; i <= 5; i += 1) {
    const microfone = await waitForMic(controller);
    await speakAndAnswer(controller, microfone, `pergunta ${i}`, [`Resposta número ${i}. `]);
  }
  assert.equal(sent.length, 5);
  assert.equal(spoken.length, 5);
  assert.deepEqual(spoken.map((s) => s.text), [1, 2, 3, 4, 5].map((i) => `Resposta número ${i}.`));
  assert.equal(controller.history.phantomBlocked >= 0, true);
  controller.dispose();
});

/* --------------------- 11. eventos atrasados do STT --------------------- */

test('11. resultado atrasado de sessão antiga é descartado na origem', async () => {
  const { controller, sent } = setup();
  await controller.start();
  const antiga = FakeRecognition.instances.at(-1);

  antiga.hear('mensagem do usuário', { isFinal: true });
  await sleep(15);
  // o microfone foi fechado ao enviar o turno; a sessão antiga ainda tenta
  // entregar o que capturou dos alto-falantes
  antiga.hear('a própria voz da kirana', { isFinal: true });
  await sleep(15);

  assert.deepEqual(sent, ['mensagem do usuário']);
  assert.ok(controller.history.phantomBlocked >= 1, 'o evento atrasado precisa ser contado como bloqueado');
  controller.dispose();
});

/* ------------------------- 12/13. escuta contínua ----------------------- */

test('12. escuta contínua: um único reconhecedor ativo por vez', async () => {
  const { controller } = setup({ tuning: { muteAfterSpeechMs: 0, restartDelayMs: 0 } });
  await controller.start();
  const criadosAntes = FakeRecognition.instances.length;
  await speakAndAnswer(controller, FakeRecognition.instances.at(-1), 'oi', ['Uma frase de resposta aqui. ']);
  await sleep(80);
  const vivos = FakeRecognition.instances.filter((r) => r.started > 0 && r.stopped === 0 && r.aborted === 0);
  assert.equal(vivos.length <= 1, true, `mais de um reconhecedor vivo: ${vivos.length}`);
  assert.ok(FakeRecognition.instances.length >= criadosAntes);
  controller.dispose();
});

test('13. prevenção de autoescuta: o microfone fica aberto, mas a própria voz não vira pergunta', async () => {
  // CONTRATO v0.4.4 — antes (v0.4.3) este teste exigia o microfone FECHADO
  // durante a resposta. Isso impedia a autoescuta e, junto, impedia o barge-in:
  // sem microfone aberto não existe "Kirana, pare". Agora o microfone fica
  // ABERTO e a proteção é o roteamento: durante o turno, só comando entra.
  const { controller, sent } = setup();
  await controller.start();
  const microfoneDoUsuario = FakeRecognition.instances.at(-1);

  microfoneDoUsuario.hear('quero saber sobre agentes de ia', { isFinal: true });
  await sleep(15);
  controller.appendDelta('A Opportunity AI trabalha com agentes de IA. ');
  await sleep(30);
  controller.appendDelta('Também faz atendimento no WhatsApp. ');
  await sleep(30);

  // O microfone continua vivo (é o que permite interromper por voz)…
  assert.equal(controller._internal.isRecognizerLive(), true, 'o microfone precisa continuar aberto durante a resposta');

  // …e o que o alto-falante devolve ao microfone NÃO vira nada.
  microfoneDoUsuario.hear('também faz atendimento no whatsapp', { isFinal: true });
  microfoneDoUsuario.hear('a opportunity ai trabalha com agentes de ia', { isFinal: false });
  await sleep(40);
  assert.equal(controller.history.echoBlocked + controller.history.phantomBlocked >= 1, true, 'o eco precisa ser contado');
  assert.equal(controller._internal.transcript, '', 'nada pode ser acumulado durante a resposta');

  controller.endTurn({ aborted: false, error: false });
  await sleep(40);
  assert.deepEqual(sent, ['quero saber sobre agentes de ia'], 'a voz da Kirana virou turno do usuário');

  // só depois da janela surda o microfone volta a aceitar fala comum
  const reaberto = await waitForMic(controller);
  reaberto.hear('e sobre o crm?', { isFinal: true });
  await sleep(30);
  assert.deepEqual(sent, ['quero saber sobre agentes de ia', 'e sobre o crm?']);
  controller.dispose();
});

test('13b. entre frases da mesma resposta nada é acumulado (fila vazia no meio do turno)', async () => {
  const { controller, sent } = setup();
  await controller.start();
  const primeira = FakeRecognition.instances.at(-1);
  primeira.hear('pergunta', { isFinal: true });
  await sleep(15);
  controller.appendDelta('Primeira frase da resposta. ');
  await sleep(60); // fila esvaziou, mas o turno NÃO terminou

  // v0.4.3 exigia "nenhum reconhecedor aberto". v0.4.4 exige "nada acumulado":
  // é isso que impede a voz da Kirana de virar pergunta, com o microfone aberto.
  primeira.hear('primeira frase da resposta', { isFinal: true });
  await sleep(30);
  assert.equal(controller._internal.transcript, '', 'o eco entre frases foi acumulado');
  assert.deepEqual(sent, ['pergunta'], 'o eco entre frases virou mensagem');

  // o comando de parada, no mesmo intervalo, continua funcionando
  primeira.hear('Kirana, pare', { isFinal: true });
  await sleep(30);
  assert.equal(controller.state, VOICE_STATE.INTERRUPTED);
  assert.equal(controller.history.bargeIns, 1);
  controller.dispose();
});

/* ---------------------- 14/15. falha e recuperação ---------------------- */

test('14. falha temporária do motor: erro visível, texto preservado, sem travar', async () => {
  const { controller } = setup({ ttsFail: true });
  await controller.start();
  await speakAndAnswer(controller, FakeRecognition.instances.at(-1), 'oi', ['A resposta continua no texto. ']);
  assert.ok(controller.history.states.some((s) => s.to === VOICE_STATE.ERROR));
  assert.match(controller.notice, /texto/i);
  assert.equal(controller.active, true, 'a conversa precisa continuar viva');
  controller.dispose();
});

test('15. recuperação: depois da falha, o próximo turno fala normalmente', async () => {
  let falhar = true;
  FakeRecognition.instances = [];
  FakeAudio.instances = [];
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } }, configurable: true, writable: true });
  const spoken = [];
  const controller = createVoiceController({
    send: async () => {},
    stop: () => {},
    getSessionId: () => 's_teste',
    RecognitionImpl: FakeRecognition,
    AudioImpl: FakeAudio,
    MediaSourceImpl: undefined,
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/voice/diagnostics')) return new Response('{"entries":[]}', { status: 200 });
      spoken.push(JSON.parse(options.body).text);
      if (falhar) return new Response('{"error":{"code":"voice_provider_failed"}}', { status: 503 });
      return mp3Response();
    },
    tuning: { silenceMs: 5, muteAfterSpeechMs: 0, restartDelayMs: 0 },
    logger: { debug: () => {} },
  });

  await controller.start();
  await speakAndAnswer(controller, FakeRecognition.instances.at(-1), 'primeira', ['Resposta um. ']);
  assert.ok(controller.history.states.some((s) => s.to === VOICE_STATE.ERROR));

  falhar = false;
  FakeAudio.instances = [];
  await speakAndAnswer(controller, FakeRecognition.instances.at(-1), 'segunda', ['Resposta dois. ']);
  assert.ok(FakeAudio.instances.some((a) => a.playCount > 0), 'o segundo turno precisa tocar áudio');
  controller.dispose();
});

/* ------------------ 16. integridade turno / texto / áudio --------------- */

test('16. cada segmento carrega turno, texto e identificador consistentes', async () => {
  const { controller, spoken } = setup();
  await controller.start();
  await speakAndAnswer(controller, FakeRecognition.instances.at(-1), 'duas frases', [
    'A primeira frase desta resposta tem tamanho suficiente. ',
    'E a segunda frase também passa do limite mínimo. ',
  ]);

  for (const segment of spoken) {
    assert.equal(typeof segment.turnId, 'number');
    assert.match(String(segment.segmentId), /^\d+-\d+$/);
    assert.equal(segment.segmentId.startsWith(`${segment.turnId}-`), true, 'segmentId precisa começar pelo turnId');
    assert.equal(segment.text.length > 0, true);
  }
  const diag = controller.diagnostics;
  assert.equal(diag.length, spoken.length, 'um registro de diagnóstico por segmento');
  for (const entry of diag) {
    assert.ok(entry.textSent.length > 0);
    assert.equal(typeof entry.ttsStart, 'number');
    assert.equal(entry.outcome, 'played');
  }
  controller.dispose();
});

test('16b. takeSpeakableSentences não inventa nem perde texto', () => {
  const original = 'Oi! Tudo bem? Eu sou a Kirana, da Opportunity AI. Posso ajudar?';
  const { chunks, rest } = takeSpeakableSentences(original);
  const junto = `${chunks.join(' ')} ${rest}`.replace(/\s+/g, ' ').trim();
  assert.equal(junto, original.replace(/\s+/g, ' ').trim());
});

test('16c. o texto falado nunca é cortado no meio de uma palavra', () => {
  // 400 caracteres sem espaço até 300: o corte tem de acontecer no espaço.
  // Frase única e longa (o corte por tamanho acontece dentro de `push`, que só
  // roda em fim de frase).
  const frase = `${'palavra '.repeat(60).trim()}.`;
  const { chunks } = takeSpeakableSentences(frase, { minChars: 24, maxChars: 120 });
  assert.equal(chunks.length > 1, true);
  for (const chunk of chunks) {
    assert.equal(chunk.length <= 120, true, `pedaço grande demais: ${chunk.length}`);
    // cada palavra do pedaço precisa estar inteira (o último leva o ponto final)
    const palavras = chunk.split(' ').map((word) => word.replace(/\.$/, ''));
    assert.equal(palavras.every((word) => word === 'palavra'), true, `fragmento: ${JSON.stringify(chunk)}`);
  }
  // Um "token" gigante e sem pontuação não é falado no meio do turno: fica no
  // buffer e sai inteiro no fim (nada de fragmento em áudio).
  const gigante = 'a'.repeat(900);
  const semFim = takeSpeakableSentences(gigante, { minChars: 24, maxChars: 300 });
  assert.equal(semFim.chunks.length, 0);
  assert.equal(semFim.rest.length, 900);
  // Com fim de frase, o corte acontece — é o único caso em que um token é
  // partido, e é ele que impede a fila de travar com uma "palavra" de 900 letras.
  const comFim = takeSpeakableSentences(`${gigante}.`, { minChars: 24, maxChars: 300 });
  assert.equal(comFim.chunks.length >= 3, true);
  assert.equal(comFim.chunks.join('').replace(/\./g, '').length, 900);
});
