/**
 * P1 — o texto falado não pode conter formatação (v0.4.3).
 *
 * Regressão relatada no teste real de Windows: a Kirana lia os asteriscos de
 * `**negrito**` em voz alta. Causa: na v0.4.2 só o servidor limpava o texto;
 * com o motor do navegador (padrão), o texto cru ia direto para
 * `speechSynthesis.speak()`.
 *
 * Aqui a verificação é no TEXTO QUE CHEGA AO MOTOR, não no que a tela mostra:
 *   - o módulo compartilhado (`public/speech-text.js`);
 *   - o controlador com motor do navegador (o que `speak()` recebeu);
 *   - o controlador com motor do servidor (o que foi no corpo do POST).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { findLeftoverMarkers, findUnspeakableChars, toSpeechText } from '../public/speech-text.js';
import { createVoiceController } from '../public/voice.js';
import { createBrowserSpeechEngine } from '../public/voice-engine.js';
import { sanitizeTextForSpeech } from '../src/voice/tts-text.js';

/* ------------------------------ casos-base ------------------------------- */

const CASOS = [
  { entrada: '**Modelo utilizado:** GPT-6.', esperado: 'Modelo utilizado: GPT-6.' },
  { entrada: 'Isso é **muito** importante.', esperado: 'Isso é muito importante.' },
  { entrada: 'Texto com *ênfase* e __negrito__ e ~~riscado~~.', esperado: 'Texto com ênfase e negrito e riscado.' },
  { entrada: '## Serviços\n\n- WhatsApp\n- CRM\n- Automação', esperado: 'Serviços WhatsApp CRM Automação' },
  { entrada: '1. Primeiro\n2. Segundo\n3. Terceiro', esperado: 'Primeiro Segundo Terceiro' },
  { entrada: 'Veja [o site da Opportunity](https://opportunity.ia.br) para detalhes.', esperado: 'Veja o site da Opportunity para detalhes.' },
  { entrada: '![logo da empresa](logo.png) no topo', esperado: 'logo da empresa no topo' },
  { entrada: 'Use `npm test` antes de publicar.', esperado: 'Use npm test antes de publicar.' },
  { entrada: 'Ação, coração, 2ª feira — R$ 1.500,00 (30% do valor)… Você aprova?', esperado: 'Ação, coração, 2ª feira — R$ 1.500,00 (30% do valor)… Você aprova?' },
  { entrada: 'As eleições brasileiras aconteceram. A inteligência artificial está aprendendo português.', esperado: 'As eleições brasileiras aconteceram. A inteligência artificial está aprendendo português.' },
];

for (const { entrada, esperado } of CASOS) {
  test(`P1: ${JSON.stringify(entrada.slice(0, 38))} → fala sem marcação`, () => {
    const falado = toSpeechText(entrada);
    assert.equal(falado, esperado);
    assert.equal(findLeftoverMarkers(falado), null, 'nenhum marcador pode sobrar');
    assert.equal(findUnspeakableChars(falado), null, 'nenhum caractere fora da política');
  });
}

test('P1: bloco de código não é lido (nem o conteúdo, nem as cercas)', () => {
  const falado = toSpeechText('Resultado:\n```js\nconsole.log(1)\n```\nPronto.');
  assert.equal(falado, 'Resultado: Pronto.');
});

test('P1: tabela vira fala corrida, sem barras nem a linha de traços', () => {
  const falado = toSpeechText('| Serviço | Valor |\n|---|---|\n| Plano | 500 |');
  assert.equal(/\|/.test(falado), false);
  assert.equal(/---/.test(falado), false);
  assert.match(falado, /Serviço, Valor/);
  assert.match(falado, /Plano, 500/);
});

test('P1: emoji não é falado; acento e pontuação sobrevivem', () => {
  const falado = toSpeechText('👉 *Importante:* ~~não~~ **sim** ✅ 📊 £ ♎');
  assert.equal(falado, 'Importante: não sim');
});

test('P1: o servidor usa exatamente a mesma limpeza (uma implementação só)', () => {
  for (const { entrada } of CASOS) {
    assert.equal(sanitizeTextForSpeech(entrada), toSpeechText(entrada), `divergiu em ${entrada}`);
  }
});

test('P1: nada factual é perdido — só a marcação sai', () => {
  const falado = toSpeechText('**Prazo:** 2 dias úteis. **Valor:** R$ 1.500,00.');
  assert.match(falado, /Prazo: 2 dias úteis/);
  assert.match(falado, /Valor: R\$ 1\.500,00/);
  assert.equal(falado.includes('*'), false);
});

test('P1: limpar duas vezes não altera o texto (idempotente)', () => {
  for (const { entrada } of CASOS) {
    const uma = toSpeechText(entrada);
    assert.equal(toSpeechText(uma), uma);
  }
});

/* ------------------ o que cada motor efetivamente recebe ------------------ */

class FakeRecognition {
  constructor() {}
  start() {
    this.onstart?.();
  }
  stop() {}
  abort() {}
}

const VOICES = [{ name: 'Microsoft Francisca Online (Natural)', lang: 'pt-BR', voiceURI: 'f', localService: false }];

function fakeSpeechHost() {
  const spoken = [];
  return {
    spoken,
    host: {
      SpeechSynthesisUtterance: class {
        constructor(text) {
          this.text = text;
        }
      },
      speechSynthesis: {
        getVoices: () => VOICES,
        speak(u) {
          spoken.push(u.text);
          setTimeout(() => {
            u.onstart?.();
            u.onend?.();
          }, 1);
        },
        cancel() {},
        addEventListener() {},
        removeEventListener() {},
      },
      setTimeout,
      clearTimeout,
    },
  };
}

function buildController({ withBrowser = true } = {}) {
  const { host, spoken } = fakeSpeechHost();
  const httpBodies = [];
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } }, configurable: true, writable: true });
  const controller = createVoiceController({
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
      removeAttribute() {}
      load() {}
    },
    speechEngine: withBrowser ? createBrowserSpeechEngine({ host }) : undefined,
    storage: { getItem: () => null, setItem: () => {} },
    preference: withBrowser ? { engine: 'browser' } : { engine: 'edge' },
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes('/api/voice/tts')) httpBodies.push(JSON.parse(options.body).text);
      if (String(url).includes('/api/voice/voices')) {
        return new Response(JSON.stringify({ voices: [{ shortName: 'pt-BR-ThalitaMultilingualNeural', locale: 'pt-BR' }] }), { status: 200 });
      }
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([0xff, 0xf3, 1]));
            c.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'audio/mpeg' } },
      );
    },
    tuning: { silenceMs: 5 },
    logger: { debug: () => {} },
  });
  return { controller, spoken, httpBodies };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('P1: no motor do navegador, o speechSynthesis recebe texto sem marcação', async () => {
  const { controller, spoken } = buildController({ withBrowser: true });
  await controller.start();
  await sleep(20);
  controller.appendDelta('**Modelo utilizado:** GPT-6. ');
  controller.appendDelta('Use `npm test` e veja [o site](https://x.com) para **mais**. ');
  await sleep(120);
  controller.endTurn({ aborted: false, error: false });
  assert.equal(spoken.length >= 1, true, 'deveria ter falado');
  const junto = spoken.join(' ');
  assert.equal(junto.includes('*'), false, `asterisco chegou ao navegador: ${JSON.stringify(junto)}`);
  assert.equal(junto.includes('`'), false);
  assert.equal(junto.includes('#'), false);
  assert.equal(junto.includes('http'), false);
  assert.match(junto, /Modelo utilizado: GPT-6/);
  assert.match(junto, /npm test/);
  controller.dispose();
});

test('P1: no motor do servidor, o POST leva texto sem marcação', async () => {
  const { controller, httpBodies } = buildController({ withBrowser: false });
  await controller.start();
  await sleep(20);
  controller.appendDelta('## Resumo\n\n**Serviços:** agentes de IA, WhatsApp e CRM. ');
  await sleep(150);
  controller.endTurn({ aborted: false, error: false });
  await sleep(50);
  assert.equal(httpBodies.length >= 1, true);
  for (const body of httpBodies) {
    assert.equal(/[*#`]/.test(body), false, `marcação chegou ao servidor: ${JSON.stringify(body)}`);
  }
  assert.match(httpBodies.join(' '), /Resumo/);
  controller.dispose();
});

test('P1: o diagnóstico mostra o texto exibido e o texto falado separados', async () => {
  const { controller } = buildController({ withBrowser: true });
  await controller.start();
  await sleep(20);
  controller.appendDelta('**Negrito** no meio da frase. ');
  await sleep(120);
  controller.endTurn({ aborted: false, error: false });
  const registro = controller.diagnostics.at(-1);
  assert.equal(registro.textSent.includes('*'), false);
  assert.equal((registro.textDisplayed ?? '').includes('**'), true, 'o texto da tela continua intacto');
  controller.dispose();
});
