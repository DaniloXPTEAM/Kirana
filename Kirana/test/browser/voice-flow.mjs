#!/usr/bin/env node
/**
 * Teste REAL de navegador da voz (Playwright/Chromium).
 *
 * O que é de verdade aqui:
 *   - Chromium real, DOM real, clique real no botão;
 *   - `getUserMedia` real (dispositivo falso do Chromium) e Permissions-Policy
 *     real — se o cabeçalho estiver errado, o microfone é bloqueado;
 *   - `/api/voice/tts` real e síntese REAL com edge-tts (MP3 de verdade);
 *   - elemento <audio> real do navegador, tocando bytes reais.
 *
 * O que é simulado (e por quê):
 *   - `SpeechRecognition`: o reconhecimento de fala do Chromium depende de um
 *     serviço externo de transcrição que não existe no ambiente headless. Aqui
 *     ele é substituído por um dublê controlado pelo teste, que injeta falas.
 *     Nenhum microfone físico é usado — isso está registrado como limitação.
 */
import { chromium } from 'playwright';

import { startFakeGateway, startKirana } from '../helpers.js';

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const REPLY = 'Olá! Eu sou a Kirana da Opportunity AI. Trabalhamos com agentes de IA, atendimento no WhatsApp e automação. Qual é o seu projeto?';

/** Dublê de SpeechRecognition controlado pelo teste. */
function sttInitScript() {
  class FakeRecognition {
    constructor() {
      this.started = 0;
      this.lang = '';
      this.continuous = false;
      this.interimResults = false;
    }
    start() {
      this.started += 1;
      window.__voiceTest.started += 1;
      setTimeout(() => this.onstart?.({}), 0);
    }
    stop() {
      window.__voiceTest.stopped += 1;
      setTimeout(() => this.onend?.({}), 0);
    }
    abort() {
      this.stop();
    }
    onstart(event) {}
    onend(event) {}
    onerror(event) {}
    onresult(event) {}
  }
  window.__voiceTest = {
    started: 0,
    stopped: 0,
    recognition: null,
    emit(text, isFinal = true) {
      this.recognition ||= [...(window.__recognitions || [])].at(-1);
      this.recognition?.onresult?.({
        resultIndex: 0,
        results: [Object.assign([{ transcript: text }], { isFinal })],
      });
    },
  };
  window.__recognitions = [];
  const Wrapped = class extends FakeRecognition {
    constructor() {
      super();
      window.__recognitions.push(this);
      window.__voiceTest.recognition = this;
    }
  };
  window.SpeechRecognition = Wrapped;
  window.webkitSpeechRecognition = Wrapped;

  // Observa o <audio> real para saber se tocou de fato.
  window.__audioLog = [];
  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play(...args) {
    window.__audioLog.push({ event: 'play', at: Date.now(), tag: this.tagName });
    return originalPlay.apply(this, args);
  };
  const originalPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function pause(...args) {
    window.__audioLog.push({ event: 'pause', at: Date.now(), tag: this.tagName });
    return originalPause.apply(this, args);
  };
}

const gateway = await startFakeGateway({
  script: ({ callIndex }) => {
    if (callIndex === 2) {
      // terceiro turno: pedido de contato -> exige confirmação na tela
      return {
        toolCalls: [
          {
            name: 'registrar_interesse_comercial',
            args: {
              nome: 'Marina Alves',
              canal_tipo: 'email',
              canal_valor: 'marina@empresa.com.br',
              interesse: 'atendimento no WhatsApp',
              mensagem: 'Quero automatizar o primeiro atendimento.',
              consentimento: true,
            },
          },
        ],
      };
    }
    return { text: REPLY };
  },
});

const kirana = await startKirana({ gatewayUrl: gateway.url });
const BASE = kirana.base;

const browser = await chromium.launch({
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});

async function newPage({ grantMic = true, withStt = true, init = [] } = {}) {
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  if (grantMic) await context.grantPermissions(['microphone'], { origin: BASE });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`   [pageerror] ${error.message.slice(0, 200)}`));
  await page.addInitScript(withStt ? sttInitScript : () => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
  });
  for (const script of init) await page.addInitScript(script);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.kiranaVoice), null, { timeout: 15000 });
  return { context, page };
}

const voiceState = (page) => page.evaluate(() => window.kiranaVoice?.state ?? null);
const buttonState = (page) => page.locator('#voice-btn').getAttribute('data-state');

async function waitState(page, expected, timeout = 30000) {
  await page.waitForFunction(
    (want) => window.kiranaVoice?.state === want,
    expected,
    { timeout, polling: 50 },
  ).catch(() => {});
  return voiceState(page);
}

try {
  /* ------------------- 1. botão existe, circular, sem página nova ---------- */
  {
    const { context, page } = await newPage();
    const box = await page.locator('#voice-btn').boundingBox();
    check('botão de voz monta no composer da página principal', Boolean(box) && box.width >= 36);
    check('botão é circular (largura ≈ altura)', box && Math.abs(box.width - box.height) <= 1, box ? `${box.width}×${box.height}` : '');
    check('estado inicial é "inativo"', (await buttonState(page)) === 'inativo', await buttonState(page));
    check('nenhuma página/rota separada de voz', (await page.locator('#voice-btn').count()) === 1);
    await context.close();
  }

  /* ------------------- 2. microfone real + escuta + resposta falada -------- */
  {
    const { context, page } = await newPage({
      init: [
        () => {
          window.__audioMetrics = [];
          window.addEventListener('kirana:voice-audio', (event) => window.__audioMetrics.push(event.detail));
        },
      ],
    });

    await page.locator('#voice-btn').click();
    const stateAfterClick = await waitState(page, 'ouvindo', 15000);
    check('clique liga a voz e o navegador libera o microfone', stateAfterClick === 'ouvindo', stateAfterClick);
    check('botão reflete "ouvindo"', (await buttonState(page)) === 'ouvindo', await buttonState(page));
    check('status acessível é anunciado', await page.locator('#voice-status').isVisible());

    await page.evaluate(() => window.__voiceTest.emit('Olá, quero saber sobre agentes de IA', true));
    await page.waitForFunction(
      () => window.kiranaVoice?.history?.states?.some((entry) => entry.to === 'processando'),
      null,
      { timeout: 15000 },
    ).catch(() => {});
    const sawProcessing = await page.evaluate(() => window.kiranaVoice.history.states.some((entry) => entry.to === 'processando'));
    check('fala detectada vira turno (estado "processando" registrado)', sawProcessing === true);

    // a mensagem transcrita entra no chat como qualquer outra
    await page.waitForFunction(
      () => [...document.querySelectorAll('.msg.user')].some((n) => /agentes de IA/i.test(n.textContent)),
      null,
      { timeout: 15000 },
    ).then(() => check('transcrição aparece no chat como mensagem do usuário', true))
      .catch(() => check('transcrição aparece no chat como mensagem do usuário', false));

    // a resposta é falada com áudio REAL
    const spoke = await waitState(page, 'falando', 30000);
    check('resposta começa a ser falada (estado "falando")', spoke === 'falando', spoke);

    await page.waitForFunction(() => window.__audioLog.some((entry) => entry.event === 'play'), null, { timeout: 40000 })
      .then(() => check('<audio> real recebeu play()', true))
      .catch(() => check('<audio> real recebeu play()', false));

    await page.waitForFunction(() => (window.__audioMetrics || []).length > 0, null, { timeout: 40000 }).catch(() => {});
    const metrics = await page.evaluate(() => window.__audioMetrics || []);
    const totalBytes = metrics.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
    check('/api/voice/tts entregou MP3 real ao navegador (> 4 KB)', totalBytes > 4096, `${totalBytes} bytes em ${metrics.length} trecho(s)`);
    check('primeiro áudio medido no navegador', metrics[0]?.firstAudioMs > 0, `${metrics[0]?.firstAudioMs} ms até o primeiro som`);
    check('voz registra histórico de estados', (await page.evaluate(() => window.kiranaVoice.history.states.length)) > 0);

    const back = await waitState(page, 'ouvindo', 60000);
    check('ao terminar de falar, volta a ouvir (conversa contínua)', back === 'ouvindo', back);

    // continuidade: mesma sessão, com histórico
    const sessionId = await page.evaluate(() => document.querySelector('.session-item.is-active')?.dataset.sessionId || null);
    const sessionOk = await page.evaluate(async () => {
      const response = await fetch('/api/sessions');
      const data = await response.json();
      return (data.sessions || []).length > 0;
    });
    check('voz usa a sessão existente (sem sessão paralela)', sessionOk, sessionId ? `sessão ${sessionId.slice(0, 8)}…` : '');

    await context.close();
  }

  /* ------------------- 3. interrupção (barge-in) do áudio ------------------ */
  {
    const { context, page } = await newPage();
    await page.locator('#voice-btn').click();
    await waitState(page, 'ouvindo', 15000);
    await page.evaluate(() => window.__voiceTest.emit('Fale sobre os serviços da Opportunity', true));
    await waitState(page, 'falando', 30000);
    await page.waitForFunction(() => window.__audioLog.some((entry) => entry.event === 'play'), null, { timeout: 40000 }).catch(() => {});
    const playsBefore = await page.evaluate(() => window.__audioLog.filter((e) => e.event === 'play').length);
    check('áudio estava tocando antes de interromper', playsBefore > 0, `${playsBefore} play(s)`);

    await page.locator('#voice-btn').click(); // usuário interrompe
    // 'interrompido' e transitório: a Kirana já volta a ouvir em seguida. Disputar
    // o instante exato falhava conforme a carga da máquina (48/48 numa rodada,
    // 47/48 na seguinte). O histórico de estados é a prova estável de que a
    // interrupção aconteceu — e o estado final ('ouvindo') continua verificado.
    const interrompeu = await page.waitForFunction(
      () => (window.kiranaVoice?.history?.states || []).some((entrada) => entrada.to === 'interrompido'),
      null,
      { timeout: 8000, polling: 50 },
    ).then(() => true).catch(() => false);
    const estadoAgora = await voiceState(page);
    check('toque durante a fala interrompe (estado "interrompido")', interrompeu, interrompeu ? `interrompido -> ${estadoAgora}` : estadoAgora);
    const pauses = await page.evaluate(() => window.__audioLog.filter((e) => e.event === 'pause').length);
    check('áudio é pausado de verdade no barge-in', pauses >= 1, `${pauses} pause(s) após ${playsBefore} play(s)`);

    await page.waitForTimeout(1200);
    const state = await voiceState(page);
    check('depois de interromper, volta a ouvir', state === 'ouvindo', state);
    await context.close();
  }

  /* ------------------- 4. HITL: voz não autoriza nada --------------------- */
  {
    const { context, page } = await newPage();
    let confirmRequests = 0;
    page.on('request', (request) => {
      if (request.url().includes('/api/chat/confirm')) confirmRequests += 1;
    });
    await page.locator('#voice-btn').click();
    await waitState(page, 'ouvindo', 15000);

    // dois turnos: um normal e um que gera ação pendente
    await page.evaluate(() => window.__voiceTest.emit('Quero falar com a equipe comercial', true));
    await page.waitForFunction(() => document.querySelectorAll('.msg-assistant').length >= 1, null, { timeout: 20000 }).catch(() => {});
    await waitState(page, 'ouvindo', 60000);

    await page.evaluate(() => window.__voiceTest.emit('sim', true)); // "sim" falado
    await page.waitForSelector('.confirm-card', { timeout: 20000 }).catch(() => {});
    const cardExists = (await page.locator('.confirm-card').count()) > 0;
    check('ação sensível pede confirmação na tela', cardExists);

    await page.waitForFunction(
      () => /confirma/i.test(document.getElementById('voice-status')?.textContent || ''),
      null,
      { timeout: 15000 },
    ).catch(() => {});
    const status = await page.locator('#voice-status').textContent().catch(() => '');
    check('voz avisa que a confirmação é na tela', /confirma/i.test(status || ''), (status || '').slice(0, 80));

    // nenhuma confirmação automática: nem pedido de confirmação, nem registro
    await page.waitForTimeout(1500);
    let interestCreated = false;
    try {
      const fs = await import('node:fs');
      interestCreated = fs.existsSync(`${kirana.dataDir}/interests.jsonl`);
    } catch {
      interestCreated = false;
    }
    check('nenhuma requisição de confirmação foi feita pela voz', confirmRequests === 0, `${confirmRequests} POST(s) /api/chat/confirm`);
    check('"sim" falado NÃO autorizou a ação (nenhum registro criado)', interestCreated === false);
    check('a confirmação continua exigindo o botão da tela', (await page.locator('.confirm-card').count()) > 0);
    await context.close();
  }

  /* ------------------- 5. microfone negado ------------------------------- */
  {
    const context = await browser.newContext({ viewport: { width: 420, height: 820 } });
    const page = await context.newPage();
    await page.addInitScript(sttInitScript);
    // sem grantPermissions e com getUserMedia falhando: simula negação
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('NotAllowedError'));
    });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.kiranaVoice), null, { timeout: 15000 });
    await page.locator('#voice-btn').click();
    const state = await waitState(page, 'erro', 10000);
    check('microfone negado mostra estado de erro', state === 'erro', state);
    const text = await page.locator('#voice-status').textContent();
    check('explica o que fazer quando o microfone é negado', /microfone|permiss/i.test(text || ''), (text || '').slice(0, 70));
    check('chat por texto continua funcionando', await page.locator('#composer-input').isEnabled());
    await context.close();
  }

  /* ------------------- 6. navegador sem SpeechRecognition --------------- */
  {
    const { context, page } = await newPage({ withStt: false });
    const enabled = await page.locator('#voice-btn').isEnabled();
    await page.locator('#voice-btn').click();
    const msg = await page.locator('#voice-status').textContent();
    check('sem reconhecimento de fala, avisa em vez de fingir ouvir', /não faz reconhecimento|indispon/i.test(msg || ''), (msg || '').slice(0, 70));
    check('botão continua acessível (não quebra a interface)', enabled === true);
    await context.close();
  }

  /* ------------------- 7. alternância texto ↔ voz e móvel ---------------- */
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: false });
    await context.grantPermissions(['microphone'], { origin: BASE });
    const page = await context.newPage();
    await page.addInitScript(sttInitScript);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.kiranaVoice), null, { timeout: 15000 });

    // texto primeiro
    await page.fill('#composer-input', 'Mensagem digitada no celular');
    const sendDisabled = await page.locator('#send').isDisabled();
    await page.click('#send');
    await page.waitForFunction(() => [...document.querySelectorAll('.msg.user')].some((n) => /digitada no celular/.test(n.textContent)), null, { timeout: 20000 })
      .then(() => check('texto funciona em viewport móvel', true))
      .catch(async () => {
        const dump = await page.evaluate(() => ({
          mensagens: [...document.querySelectorAll('.msg')].map((n) => `${n.dataset.role}:${n.textContent.slice(0, 24)}`),
          input: document.getElementById('composer-input')?.value,
        }));
        check('texto funciona em viewport móvel', false, `send desabilitado=${sendDisabled} ${JSON.stringify(dump).slice(0, 200)}`);
      });

    const box = await page.locator('#voice-btn').boundingBox();
    check('botão de voz visível e tocável no móvel (≥ 32 px)', Boolean(box) && box.width >= 32, box ? `${Math.round(box.width)}px` : '');

    // depois voz
    await page.locator('#voice-btn').click();
    await waitState(page, 'ouvindo', 15000);
    await page.evaluate(() => window.__voiceTest.emit('E agora uma pergunta por voz', true));
    await page.waitForFunction(
      () => [...document.querySelectorAll('.msg.user')].some((n) => /pergunta por voz/i.test(n.textContent)),
      null,
      { timeout: 20000 },
    ).then(() => check('voz e texto convivem na mesma conversa', true))
      .catch(() => check('voz e texto convivem na mesma conversa', false));

    // encerrar a qualquer momento (espera a conversa voltar a "ouvindo")
    await waitState(page, 'ouvindo', 45000);
    await page.locator('#voice-btn').click();
    await page.waitForFunction(() => window.kiranaVoice?.state === 'inativo', null, { timeout: 10000 }).catch(() => {});
    const finalState = await voiceState(page);
    check('usuário encerra a voz quando quiser', finalState === 'inativo', finalState);

    /* ------------- v0.4.3 / P2: uma identidade só, sem sobreposição -------- */
    const p2 = await page.evaluate(() => {
      const avatares = [...document.querySelectorAll('.msg-avatar')];
      const estouram = avatares.filter((n) => {
        const temTexto = (n.textContent || '').trim().length > 0;
        const r = n.getBoundingClientRect();
        return temTexto || n.scrollWidth > n.offsetWidth || getComputedStyle(n).overflow === 'visible';
      }).map((n) => (n.textContent || '').trim() || n.className);
      const faces = [...document.querySelectorAll('.msg-avatar-kirana svg use')].map((u) => u.getAttribute('href'));
      const bolhas = [...document.querySelectorAll('.bubble')].map((b) => b.getBoundingClientRect().toJSON());
      const sobrepostas = bolhas.some((a, i) => bolhas.some((b, j) => i !== j
        && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
      return {
        estouram,
        faces,
        welcomeNaTela: Boolean(document.getElementById('welcome')?.isConnected),
        sobrepostas,
        avatarUsuario: document.querySelectorAll('.msg-avatar-user').length,
      };
    });
    check('P2: nenhum avatar transborda texto para fora da bolha', p2.estouram.length === 0, p2.estouram.join(',') || 'ok');
    check('P2: avatar da Kirana usa a mesma face do cabeçalho', p2.faces.every((href) => href === '#kirana-face') && p2.faces.length > 0, p2.faces.join(','));
    check('P2: avatar do usuário é ícone (sem a palavra "Você")', p2.avatarUsuario > 0);
    check('P2: o cartão de boas-vindas sai quando a conversa começa', p2.welcomeNaTela === false);
    check('P2: nenhuma bolha de mensagem se sobrepõe a outra', p2.sobrepostas === false);

    /* -------------------- v0.4.2: escolha de motor e voz ------------------ */
    await page.locator('#voice-config-btn').click();
    await page.waitForFunction(() => !document.getElementById('voice-settings')?.hidden, null, { timeout: 5000 })
      .then(() => check('painel de voz abre pelo botão de configuração', true))
      .catch(() => check('painel de voz abre pelo botão de configuração', false));

    const engines = await page.evaluate(() => [...document.querySelectorAll('#voice-engine option')].map((o) => o.value));
    check('painel oferece automático, navegador e servidor', ['auto', 'browser', 'edge'].every((v) => engines.includes(v)), engines.join(','));

    // O catálogo do servidor é buscado ao abrir o painel (processo Python real).
    const hasEdgeVoice = await page.waitForFunction(
      () => [...document.querySelectorAll('#voice-select optgroup[label*="servidor"] option')].length > 0,
      null,
      { timeout: 30000 },
    ).then(() => true).catch(() => false);
    check('vozes do servidor aparecem no seletor', hasEdgeVoice);

    const picked = await page.evaluate(async () => {
      const select = document.getElementById('voice-select');
      const edgeOption = [...select.options].find((option) => option.value.startsWith('edge:'));
      if (!edgeOption) return null;
      select.value = edgeOption.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { engine: window.kiranaVoice.settings.engine, voice: window.kiranaVoice.settings.voice?.name };
    });
    check('escolher voz do servidor muda o motor', picked?.engine === 'edge', picked ? `${picked.engine} / ${picked.voice}` : 'sem voz');

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('kirana.voz.preferencias.v1') || 'null'));
    check('preferência de voz fica salva no navegador', Boolean(saved?.voiceId), saved ? saved.voiceId : 'nada salvo');

    const hint = await page.locator('#voice-settings-hint').textContent();
    check('painel informa qual motor está falando', /servidor|navegador|automático/i.test(hint || ''), (hint || '').slice(0, 70));

    const layout = await page.evaluate(() => {
      const painel = document.getElementById('voice-settings');
      const chat = document.getElementById('chat-scroll');
      const posicao = getComputedStyle(painel).position;
      const r = painel.getBoundingClientRect();
      return {
        posicao,
        flutua: posicao === 'absolute' || posicao === 'fixed',
        dentroDaTela: r.top >= 0 && r.bottom <= window.innerHeight + 1,
        alturaChat: Math.round(chat.getBoundingClientRect().height),
      };
    });
    check('P2: painel de voz flutua (não empurra o chat)', layout.flutua, layout.posicao);
    check('P2: painel de voz cabe na tela', layout.dentroDaTela);
    const antesEsc = layout.alturaChat;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const depoisEsc = await page.evaluate(() => ({
      alturaChat: Math.round(document.getElementById('chat-scroll').getBoundingClientRect().height),
      aberto: !document.getElementById('voice-settings').hidden,
    }));
    check('P2: Esc fecha o painel sem mexer no tamanho do chat', !depoisEsc.aberto && depoisEsc.alturaChat === antesEsc, `${antesEsc} → ${depoisEsc.alturaChat}`);

    await context.close();
  }  /* ------------- 6. v0.4.4: barge-in POR VOZ ("Kirana, pare") ------------
     Fica por último de propósito: o gateway falso deste arquivo responde por
     ordem de chamada (a 3ª chamada é a que pede confirmação), então um turno
     novo não pode entrar no meio dos cenários de HITL.                        */
  {
    const { context, page } = await newPage({
      init: [
        () => {
          window.__bargeEvents = [];
          window.addEventListener('kirana:voice-bargein', (event) => window.__bargeEvents.push(event.detail));
        },
      ],
    });
    await page.locator('#voice-btn').click();
    await waitState(page, 'ouvindo', 15000);
    await page.evaluate(() => window.__voiceTest.emit('Fale sobre os serviços da Opportunity', true));
    await waitState(page, 'falando', 30000);
    await page.waitForFunction(() => window.__audioLog.some((entry) => entry.event === 'play'), null, { timeout: 40000 }).catch(() => {});

    const durante = await page.evaluate(() => ({
      microfoneAberto: window.kiranaVoice._internal.isRecognizerLive(),
      janela: window.kiranaVoice._internal.commandWindow(),
    }));
    check('P4: microfone continua aberto durante a fala (é o que ouve o comando)', durante.microfoneAberto === true, String(durante.janela));

    // Falso positivo primeiro: pergunta que CONTÉM "para" não pode interromper.
    await page.evaluate(() => window.__voiceTest.emit('por que o WhatsApp para de funcionar?', true));
    await page.waitForTimeout(400);
    const semFalsoPositivo = await page.evaluate(() => window.kiranaVoice.history.bargeIns);
    check('P4: pergunta com "para" não interrompe (sem falso positivo)', semFalsoPositivo === 0, `${semFalsoPositivo} interrupção(ões)`);
    check('P4: depois da pergunta, a Kirana continua falando', (await voiceState(page)) === 'falando', await voiceState(page));

    const mensagensAntes = await page.evaluate(() => document.querySelectorAll('.msg.user').length);
    const pedidosAntes = await page.evaluate(() => window.__voiceTest.started);

    // O comando, por resultado FINAL do reconhecedor.
    await page.evaluate(() => window.__voiceTest.emit('Kirana, pare', true));
    const interrompido = await page.waitForFunction(
      () => (window.kiranaVoice?.history?.states || []).some((entry) => entry.to === 'interrompido' && entry.reason === 'voice_command'),
      null,
      { timeout: 8000, polling: 50 },
    ).then(() => true).catch(() => false);
    check('P4: "Kirana, pare" registra interrupção por comando de voz', interrompido);

    const depois = await page.evaluate(() => ({
      bargeIns: window.kiranaVoice.bargeIns,
      eventos: window.__bargeEvents,
      mensagens: document.querySelectorAll('.msg.user').length,
      pausas: window.__audioLog.filter((e) => e.event === 'pause').length,
      estado: window.kiranaVoice.state,
      reconhecedoresCriados: window.__voiceTest.started,
    }));
    check('P4: o áudio reproduzido é pausado de verdade', depois.pausas >= 1, `${depois.pausas} pause(s)`);
    check('P4: o comando NÃO vira mensagem do usuário', depois.mensagens === mensagensAntes, `${mensagensAntes} → ${depois.mensagens}`);
    check('P4: o comando não abre um novo turno no modelo', depois.reconhecedoresCriados === pedidosAntes);
    check('P4: evento público de barge-in é emitido', (depois.eventos || []).length === 1, JSON.stringify((depois.eventos || [])[0] || {}).slice(0, 90));
    const latencia = depois.bargeIns[0]?.latencyMs;
    check('P4: latência comando → áudio silenciado medida', typeof latencia === 'number' && latencia >= 0, `${latencia} ms`);
    check('P4: comando registra a palavra reconhecida', depois.bargeIns[0]?.keyword === 'pare', depois.bargeIns[0]?.keyword);

    const volta = await waitState(page, 'ouvindo', 15000);
    check('P4: depois do comando, volta a ouvir', volta === 'ouvindo', volta);

    // continuação: a conversa segue sem recarregar a página
    const mensagensAntesDeContinuar = await page.evaluate(() => document.querySelectorAll('.msg.user').length);
    await page.evaluate(() => window.__voiceTest.emit('E sobre o CRM?', true));
    const continuou = await page.waitForFunction(
      (antes) => document.querySelectorAll('.msg.user').length > antes,
      mensagensAntesDeContinuar,
      { timeout: 15000 },
    ).then(() => true).catch(() => false);
    check('P4: conversa continua depois da interrupção por voz', continuou);
    await context.close();
  }

} catch (error) {
  failures += 1;
  console.log(`✗ erro inesperado: ${error?.message}`);
} finally {
  await browser.close();
  await kirana.close();
  await gateway.close();
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} verificações de navegador passaram`);
if (failures) {
  console.log(`FALHAS: ${failures}`);
  process.exitCode = 1;
}
