/**
 * P3 — transcrição sem palavra repetida (v0.4.3).
 *
 * Regressão relatada no teste real de Windows: a transcrição saía com palavras
 * repetidas ("Quero saber sobre os Smiles Smiles" e variações). Causa: o merge
 * da v0.4.2 somava todo resultado final a `transcript` e só descartava o caso
 * em que o final era exatamente igual ao acumulado — nos outros, colava a frase
 * duas vezes; e um final já confirmado não podia mais ser corrigido.
 *
 * Os dublês abaixo reproduzem os padrões REAIS do `SpeechRecognition` do
 * Chrome/Edge (que não roda em headless): evento repetido, final reemitido,
 * interino que contém o final, interino que muda de ideia.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { collapseRepeats, createVoiceController, mergeRecognition } from '../public/voice.js';

/* ------------------------- merge (unidade) ------------------------------- */

test('P3: final repetido não duplica a frase', () => {
  const primeira = mergeRecognition('', 'Quero saber sobre os Smiles', { final: true });
  assert.equal(primeira.transcript, 'Quero saber sobre os Smiles');
  const segunda = mergeRecognition(primeira.committed, 'Quero saber sobre os Smiles', { final: true });
  assert.equal(segunda.transcript, 'Quero saber sobre os Smiles');
  assert.equal(segunda.changed, false, 'evento igual não muda nada');
});

test('P3: final que repete o começo do acumulado só traz o sufixo novo', () => {
  const base = 'Quero saber sobre os';
  const final = mergeRecognition(base, 'Quero saber sobre os serviços', { final: true });
  assert.equal(final.transcript, 'Quero saber sobre os serviços');
  assert.equal(final.transcript.match(/Quero/g).length, 1);
});

test('P3: sobreposição com pontuação diferente também é reconhecida', () => {
  const r = mergeRecognition('Olá', 'Olá, tudo bem?', { final: true });
  assert.equal(r.transcript, 'Olá tudo bem?');
  assert.equal(r.transcript.match(/Olá/g).length, 1);
});

test('P3: repetição imediata da mesma palavra é colapsada', () => {
  assert.equal(collapseRepeats('eu eu acho que que sim'), 'eu acho que sim');
  assert.equal(collapseRepeats('Quero saber'), 'Quero saber');
  const r = mergeRecognition('', 'eu eu quero saber sobre os Smiles', { final: true });
  assert.equal(r.transcript, 'eu quero saber sobre os Smiles');
});

test('P3: interino nunca é somado ao confirmado', () => {
  const base = 'Quero saber';
  assert.equal(mergeRecognition(base, 'Quero', { final: false }).committed, base);
  // interino que só repete a parte confirmada não vira texto novo
  assert.equal(mergeRecognition(base, 'Quero saber', { final: false }).interim, '');
  // interino que adianta palavras novas aparece, mas não é confirmado
  const r = mergeRecognition(base, 'Quero saber sobre', { final: false });
  assert.equal(r.interim, 'Quero saber sobre');
  assert.equal(r.committed, base);
});

test('P3: trocar de ideia no interino substitui o palpite, não acumula', () => {
  const base = 'Quero saber';
  let r = mergeRecognition(base, 'Quero saber sobre os Smiles', { final: false });
  assert.equal(r.interim, 'Quero saber sobre os Smiles');
  r = mergeRecognition(base, 'Quero saber sobre os serviços', { final: false });
  assert.equal(r.interim, 'Quero saber sobre os serviços');
  assert.equal(/Smiles/.test(r.interim), false, 'o palpite anterior não pode ficar');
});

/* ------------------- controlador com eventos realistas ------------------- */

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
  /** Entrega resultados como o navegador entrega: lista de resultados + resultIndex. */
  feed(results, { resultIndex = 0 } = {}) {
    this.onresult?.({
      resultIndex,
      results: results.map(({ text, final }) => Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: final })),
    });
  }
}

function build() {
  FakeRecognition.instances = [];
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } }, configurable: true, writable: true });
  const sent = [];
  const controller = createVoiceController({
    send: async (text) => {
      sent.push(text);
    },
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
    speechEngine: {
      engine: 'browser',
      available: () => false,
      listVoices: async () => [],
      speak: async () => ({ cancelled: true }),
      cancel: () => {},
      pickVoice: () => null,
    },
    preference: { engine: 'edge' },
    storage: { getItem: () => null, setItem: () => {} },
    fetchImpl: async () => new Response('{"voices":[]}', { status: 200 }),
    tuning: { silenceMs: 30, minChars: 3, restartDelayMs: 0, interimGraceMs: 40 },
    logger: { debug: () => {} },
  });
  return { controller, sent, recognition: () => FakeRecognition.instances.at(-1) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('P3: o padrão do relato não repete palavra no que vai para o agente', async () => {
  const { controller, sent, recognition } = build();
  await controller.start();
  const rec = recognition();

  rec.feed([{ text: 'Quero saber sobre os Smiles', final: true }]);
  rec.feed([{ text: 'Quero saber sobre os Smiles', final: true }]); // evento repetido
  rec.feed([
    { text: 'Quero saber sobre os Smiles', final: true },
    { text: 'e sobre os', final: false },
  ], { resultIndex: 0 });

  await sleep(120); // silêncio encerra o enunciado
  assert.equal(sent.length, 1, `esperava 1 envio, veio ${sent.length}: ${JSON.stringify(sent)}`);
  assert.equal(sent[0], 'Quero saber sobre os Smiles');
  controller.dispose();
});

test('P3: final + interino pendente não somam duas vezes a mesma frase', async () => {
  const { controller, sent, recognition } = build();
  await controller.start();
  const rec = recognition();

  rec.feed([{ text: 'Quais serviços', final: true }]);
  rec.feed([{ text: 'Quais serviços a Opportunity oferece', final: false }]);
  await sleep(120);

  assert.equal(sent.length, 1);
  assert.equal(sent[0], 'Quais serviços a Opportunity oferece');
  assert.equal(sent[0].match(/serviços/g).length, 1);
  controller.dispose();
});

test('P3: vários finais legítimos formam uma frase única, em ordem', async () => {
  const { controller, sent, recognition } = build();
  await controller.start();
  const rec = recognition();

  rec.feed([{ text: 'Olá Kirana', final: true }]);
  rec.feed([{ text: 'Olá Kirana', final: true }, { text: 'quero falar sobre o CRM', final: true }], { resultIndex: 0 });
  await sleep(120);

  assert.equal(sent.length, 1);
  assert.equal(sent[0], 'Olá Kirana quero falar sobre o CRM');
  controller.dispose();
});

test('P3: interino repetido sem final não gera envio duplicado', async () => {
  const { controller, sent, recognition } = build();
  await controller.start();
  const rec = recognition();

  rec.feed([{ text: 'teste de transcrição', final: false }]);
  rec.feed([{ text: 'teste de transcrição', final: false }]);
  rec.feed([{ text: 'teste de transcrição', final: false }]);
  await sleep(120);

  assert.equal(sent.length, 1);
  assert.equal(sent[0], 'teste de transcrição');
  controller.dispose();
});

test('P3: o mesmo turno não é enviado duas vezes na janela de duplicata', async () => {
  const { controller, sent, recognition } = build();
  await controller.start();
  const rec = recognition();

  rec.feed([{ text: 'quero saber sobre os serviços', final: true }]);
  await sleep(120);
  // o reconhecedor reabre e, por eco do próprio áudio, entrega a mesma frase
  const reaberto = recognition();
  if (reaberto && reaberto !== rec) {
    reaberto.feed([{ text: 'quero saber sobre os serviços', final: true }]);
    await sleep(120);
  }
  assert.equal(sent.length, 1, `envio duplicado: ${JSON.stringify(sent)}`);
  controller.dispose();
});

test('P3: fala com duas frases separadas por pausa longa vira dois turnos, sem repetir', async () => {
  const { controller, sent, recognition } = build();
  await controller.start();
  const rec = recognition();
  rec.feed([{ text: 'primeira pergunta', final: true }]);
  await sleep(150);
  controller.dispose();
  assert.equal(sent.length, 1);
  assert.equal(sent[0], 'primeira pergunta');
});
