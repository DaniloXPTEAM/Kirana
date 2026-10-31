import { createBrowserAudioAdapters } from './providers.js';
import { createEdgeTtsAdapter, THALITA_VOICE, sanitizeTextForSpeech } from './edge-tts-adapter.js';
import { playWithTtsFallback } from './tts-routing.js';

const audioProviders = createBrowserAudioAdapters(window);
const edgeTts = createEdgeTtsAdapter(window);
const $ = (id) => document.getElementById(id);
const SpeechRecognition = audioProviders.stt.supported();
let recognition = null;
let recognizing = false;
let continuousWanted = false;
let requestController = null;
let activeTtsController = null;
let playbackPending = 0;
let responseFinished = false;
let speechBuffer = '';
let assistantText = '';
let lastTurnStart = 0;
let firstDeltaAt = 0;
let sessionInfo = null;
let edgeAvailable = false;
let edgeCatalog = [];
let edgeError = '';
let userSelectedVoice = false;
let fallbackForTurn = false;
let speechGeneration = 0;
let speechProcessorRunning = false;
const speechQueue = [];
const messages = [];
const reportState = {
  microphoneGranted: false, sttCompleted: false, modelFirstDelta: false,
  modelCompleted: false, speechStarted: false, manualInterruption: false,
  silenceObserved: false, lastConnectionCheck: false, connectionFailures: 0,
  reconnectionSuccess: false, microphoneCaptured: false, thalitaCatalogAvailable: false,
  thalitaFallbackUsed: false, franciscaFallbackAvailable: false,
};

function state(text, kind = '') {
  $('stateText').textContent = text;
  $('stateDot').className = `dot ${kind}`;
}
function setBusy(value) {
  $('interruptBtn').disabled = !value;
  $('listenBtn').disabled = value && !recognizing;
}
function formatMs(n) { return Number.isFinite(n) ? `${Math.round(n)} ms` : '—'; }
function setLatency(id, value) { $(id).textContent = formatMs(value); }

function browserVoices() { return audioProviders.tts.getVoices().filter((v) => /^pt(-|_)/i.test(v.lang)); }
function franciscaVoice() {
  return browserVoices().find((v) => /francisca/i.test(`${v.name} ${v.voiceURI}`) && /^pt[-_]BR$/i.test(v.lang)) || null;
}
function fillVoices(preferThalita = false) {
  const select = $('voiceSelect');
  const old = select.value;
  select.replaceChildren();
  const thalita = document.createElement('option');
  thalita.value = 'edge:thalita';
  thalita.textContent = 'Thalita Neural — Português (Brasil)';
  thalita.disabled = !edgeAvailable;
  select.append(thalita);
  const fallback = franciscaVoice();
  reportState.franciscaFallbackAvailable = Boolean(fallback);
  for (const voice of browserVoices().filter((candidate) => /francisca/i.test(candidate.name) && /^pt[-_]BR$/i.test(candidate.lang))) {
    const option = document.createElement('option');
    option.value = `browser:${voice.voiceURI}`;
    option.textContent = /francisca/i.test(voice.name)
      ? `Francisca Online — ${voice.lang}${voice.default ? ' (padrão)' : ''}`
      : `${voice.name} — ${voice.lang}${voice.default ? ' (padrão)' : ''}`;
    select.append(option);
  }
  const oldExists = [...select.options].some((option) => option.value === old && !option.disabled);
  if (oldExists && (!preferThalita || userSelectedVoice)) select.value = old;
  else if (edgeAvailable && (!userSelectedVoice || preferThalita)) select.value = 'edge:thalita';
  else if (fallback) select.value = `browser:${fallback.voiceURI}`;
  else select.value = 'edge:thalita';
  updateVoiceName();
}
function updateVoiceName() {
  const value = $('voiceSelect').value;
  if (value === 'edge:thalita') {
    $('voiceName').textContent = edgeAvailable ? 'Thalita Neural — Português (Brasil)' : 'Thalita indisponível';
    return;
  }
  const uri = value.startsWith('browser:') ? value.slice(8) : '';
  const voice = browserVoices().find((candidate) => candidate.voiceURI === uri);
  $('voiceName').textContent = voice ? `${voice.name} (${voice.lang})` : 'Francisca indisponível';
}

async function loadTtsCatalog() {
  $('ttsProviderChip').textContent = 'Verificando Thalita…';
  try {
    const result = await edgeTts.listVoices();
    edgeCatalog = result.voices;
    edgeAvailable = Boolean(result.available);
    edgeError = edgeAvailable ? '' : `A voz ${THALITA_VOICE} não consta no catálogo atual.`;
    reportState.thalitaCatalogAvailable = edgeAvailable;
    if (!edgeAvailable) $('log').textContent = `${edgeError} ${reportState.franciscaFallbackAvailable ? 'Francisca do navegador disponível como fallback.' : 'Francisca do navegador não está exposta neste navegador.'}`;
  } catch (error) {
    edgeAvailable = false;
    edgeError = error.message || 'Catálogo Thalita indisponível.';
    reportState.thalitaCatalogAvailable = false;
  }
  $('ttsProviderChip').textContent = edgeAvailable ? 'Thalita Neural disponível' : 'Thalita indisponível';
  $('ttsProviderChip').title = edgeAvailable ? 'edge-tts / pt-BR-ThalitaMultilingualNeural' : edgeError;
  fillVoices(true);
  if (!edgeAvailable) {
    const fallback = franciscaVoice();
    $('log').textContent = `${edgeError} ${fallback ? 'Fallback Francisca Online disponível.' : 'Fallback Francisca indisponível; a resposta textual permanece funcional.'}`;
  }
}

function updateProvider(label) { $('ttsProviderChip').textContent = label; }
function onFirstAudio() {
  reportState.speechStarted = true;
  if (!$('firstAudioLatency').dataset.measured) {
    setLatency('firstAudioLatency', performance.now() - lastTurnStart);
    $('firstAudioLatency').dataset.measured = '1';
  }
  state('Reproduzindo áudio…', 'good');
}
function speakFrancisca(text, generation) {
  const voice = franciscaVoice();
  if (!voice) throw new Error('Fallback indisponível: o navegador não expôs Microsoft Francisca Online (Natural) em pt-BR.');
  const selectedFrancisca = $('voiceSelect').value === `browser:${voice.voiceURI}`;
  updateProvider(selectedFrancisca ? 'Francisca Online — navegador' : 'Francisca Online — fallback');
  return new Promise((resolve, reject) => {
    const utterance = audioProviders.tts.createUtterance(text, voice, {
      onstart: () => { if (generation === speechGeneration) onFirstAudio(); },
      onend: resolve,
      onerror: () => reject(new Error('A voz Francisca do navegador não conseguiu reproduzir o trecho.')),
    });
    activeTtsController = { abort: () => audioProviders.tts.cancel() };
    audioProviders.tts.speak(utterance);
  });
}
function enqueueSpeech(text) {
  const clean = sanitizeTextForSpeech(text);
  if (!clean) return;
  const generation = speechGeneration;
  speechQueue.push({ text: clean, generation });
  playbackPending++;
  processSpeechQueue();
}
async function processSpeechQueue() {
  if (speechProcessorRunning) return;
  speechProcessorRunning = true;
  while (speechQueue.length) {
    const item = speechQueue.shift();
    if (item.generation !== speechGeneration) continue;
    try {
      const useThalita = $('voiceSelect').value === 'edge:thalita' && edgeAvailable && !fallbackForTurn;
      const controller = new AbortController();
      if (useThalita) activeTtsController = controller;
      await playWithTtsFallback({
        usePrimary: useThalita,
        primary: () => edgeTts.play(item.text, {
          signal: controller.signal,
          onProvider: updateProvider,
          onPlaying: () => { if (item.generation === speechGeneration) onFirstAudio(); },
        }),
        fallback: () => speakFrancisca(item.text, item.generation),
        onPrimaryFailure: (error) => {
          fallbackForTurn = true;
          reportState.thalitaFallbackUsed = true;
          $('log').textContent = `Thalita falhou; alternando para Francisca. ${error.message}`;
        },
      });
    } catch (error) {
      if (item.generation !== speechGeneration || error.name === 'AbortError') continue;
      if (!franciscaVoice() && $('voiceSelect').value === 'edge:thalita') {
        reportState.thalitaFallbackUsed = true;
        $('log').textContent = `Thalita indisponível e Francisca não está exposta pelo navegador: ${error.message}`;
      } else {
        $('log').textContent = error.message;
      }
    } finally {
      activeTtsController = null;
      if (item.generation === speechGeneration) playbackPending = Math.max(0, playbackPending - 1);
    }
  }
  speechProcessorRunning = false;
  finishPlaybackIfReady();
}
function drainSpeech(final = false) {
  let boundary;
  while ((boundary = speechBuffer.search(/[.!?。\n](?:\s|$)/)) >= 0) {
    const chunk = speechBuffer.slice(0, boundary + 1);
    speechBuffer = speechBuffer.slice(boundary + 1);
    enqueueSpeech(chunk);
  }
  if (speechBuffer.length > 220) {
    const split = speechBuffer.lastIndexOf(' ', 220);
    if (split > 90) { enqueueSpeech(speechBuffer.slice(0, split)); speechBuffer = speechBuffer.slice(split); }
  }
  if (final && speechBuffer.trim()) { enqueueSpeech(speechBuffer); speechBuffer = ''; }
}
function finishPlaybackIfReady() {
  if (responseFinished && playbackPending === 0 && !speechProcessorRunning) {
    setBusy(false);
    state('Resposta concluída.', 'good');
    if (continuousWanted) setTimeout(startListening, 250);
  }
}
function interrupt() {
  const active = Boolean(requestController || playbackPending || recognizing);
  if (active) reportState.manualInterruption = true;
  continuousWanted = false;
  $('continuous').checked = false;
  speechGeneration++;
  speechQueue.length = 0;
  playbackPending = 0;
  if (requestController) { requestController.abort(); requestController = null; }
  if (activeTtsController?.abort) activeTtsController.abort();
  activeTtsController = null;
  edgeTts.cancel();
  audioProviders.tts.cancel();
  responseFinished = true;
  recognition?.stop();
  recognizing = false;
  setBusy(false);
  state(active ? 'Interrompido pelo usuário.' : 'Nada estava em reprodução.', 'warn');
}

async function loadModels() {
  try {
    state('Verificando Gateway, sessão SIWC e modelos…', 'warn');
    const [healthResponse, sessionResponse, modelResponse] = await Promise.all([
      fetch('/api/health', { cache: 'no-store' }),
      fetch('/api/session', { cache: 'no-store' }),
      fetch('/api/models', { cache: 'no-store' }),
    ]);
    if (!healthResponse.ok || !sessionResponse.ok || !modelResponse.ok) throw new Error(`health ${healthResponse.status}, sessão ${sessionResponse.status}, modelos ${modelResponse.status}`);
    const [health, session, data] = await Promise.all([healthResponse.json(), sessionResponse.json(), modelResponse.json()]);
    sessionInfo = session;
    if (reportState.connectionFailures > 0) reportState.reconnectionSuccess = true;
    reportState.connectionFailures = 0;
    reportState.lastConnectionCheck = true;
    $('sessionChip').textContent = session.authenticated && session.sharing ? 'SIWC autenticado' : 'SIWC não autenticado';
    $('sessionChip').title = `Escopos concedidos: ${(session.grantedScopes || []).join(', ') || 'nenhum'}`;
    if (!session.authenticated || !session.sharing || !(session.grantedScopes || []).includes('chatgpt.tokens.use.direct')) throw new Error('Sessão SIWC/plan-use ausente. Faça o consentimento no Gateway local.');
    if (health.status !== 'ok') throw new Error('Gateway não está saudável.');
    const models = Array.isArray(data.data) ? data.data : [];
    const select = $('modelSelect');
    select.replaceChildren();
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name || model.id;
      select.append(option);
    }
    if (!models.length) throw new Error('nenhum modelo visível na conta');
    $('modelChip').textContent = `${models.length} modelos SIWC`;
    state('Gateway ativo e sessão SIWC verificada.', 'good');
    $('log').textContent = `STT: ${audioProviders.stt.disclosure} · TTS Thalita: edge-tts online; fallback Francisca do navegador.`;
  } catch (error) {
    reportState.lastConnectionCheck = false;
    reportState.connectionFailures++;
    $('sessionChip').textContent = 'SIWC não verificado';
    $('modelChip').textContent = 'Gateway indisponível';
    state('Verificação incompleta. Inicie/conecte o Gateway e use Atualizar conexão.', 'bad');
    $('log').textContent = `${error.message} · nenhuma chamada foi repetida automaticamente.`;
  }
}

async function sendToModel(text) {
  const model = $('modelSelect').value;
  if (!model) { state('Nenhum modelo SIWC disponível.', 'bad'); return; }
  messages.push({ role: 'user', content: text });
  renderHistory();
  $('answer').textContent = '';
  $('log').textContent = '';
  $('firstAudioLatency').dataset.measured = '';
  setLatency('firstAudioLatency', NaN);
  setLatency('firstTokenLatency', NaN);
  setLatency('totalLatency', NaN);
  assistantText = '';
  speechBuffer = '';
  playbackPending = 0;
  responseFinished = false;
  fallbackForTurn = false;
  reportState.thalitaFallbackUsed = false;
  firstDeltaAt = 0;
  lastTurnStart = performance.now();
  requestController = new AbortController();
  setBusy(true);
  state('A Kirana está respondendo…', 'warn');
  try {
    const response = await fetch('/api/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }), signal: requestController.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error?.message || data.error || `Gateway HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('O Gateway não entregou stream de texto.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let frame;
      while ((frame = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, frame.index);
        buffer = buffer.slice(frame.index + frame[0].length);
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (event.error) throw new Error(event.error.message || 'Falha no stream.');
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') {
            firstDeltaAt ||= performance.now();
            reportState.modelFirstDelta = true;
            assistantText += delta;
            $('answer').textContent = assistantText;
            setLatency('firstTokenLatency', firstDeltaAt - lastTurnStart);
            speechBuffer += delta;
            drainSpeech(false);
          }
        }
      }
    }
    if (!assistantText.trim()) throw new Error('O modelo concluiu sem resposta textual para reproduzir.');
    messages.push({ role: 'assistant', content: assistantText });
    reportState.modelCompleted = true;
    renderHistory();
    drainSpeech(true);
    setLatency('totalLatency', performance.now() - lastTurnStart);
    responseFinished = true;
    requestController = null;
    if (playbackPending === 0) finishPlaybackIfReady();
    else state('Resposta textual concluída; reproduzindo fila de áudio. Use Interromper para cancelar.', 'good');
  } catch (error) {
    requestController = null;
    if (error.name === 'AbortError') { state('Geração cancelada pelo usuário.', 'warn'); return; }
    edgeTts.cancel();
    audioProviders.tts.cancel();
    playbackPending = 0;
    responseFinished = true;
    setBusy(false);
    state('Falha de conexão ou resposta.', 'bad');
    $('log').textContent = `${error.message} · nenhuma repetição automática foi feita.`;
  }
}
function renderHistory() {
  if (!messages.length) { $('history').textContent = 'Nenhuma mensagem nesta sessão.'; return; }
  $('history').textContent = messages.map((message) => `${message.role === 'user' ? 'Você' : 'Kirana'}: ${message.content}`).join('\n\n');
}
function createRecognition() {
  if (!SpeechRecognition) { state('Este navegador não oferece SpeechRecognition. Use Chrome/Edge atualizado.', 'bad'); return null; }
  const rec = audioProviders.stt.createRecognition('pt-BR');
  let turnStarted = 0;
  rec.onstart = () => {
    recognizing = true;
    turnStarted = performance.now();
    $('transcript').textContent = 'Escutando…';
    state('Escutando em português brasileiro.', 'good');
    $('listenBtn').disabled = true;
    $('interruptBtn').disabled = false;
  };
  rec.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const value = event.results[i][0]?.transcript || '';
      if (event.results[i].isFinal) final += value;
      else interim += value;
    }
    $('transcript').textContent = final || interim || 'Escutando…';
    if (final.trim()) {
      recognizing = false;
      continuousWanted = $('continuous').checked;
      setLatency('sttLatency', performance.now() - turnStarted);
      reportState.sttCompleted = true;
      state('Transcrição recebida; enviando texto ao modelo SIWC…', 'good');
      sendToModel(final.trim());
    }
  };
  rec.onerror = (event) => {
    recognizing = false;
    if (event.error === 'no-speech') reportState.silenceObserved = true;
    const known = {
      'no-speech': 'Nenhuma fala detectada (silêncio). Tente novamente.',
      'not-allowed': 'Permissão de microfone negada. Revise as permissões do navegador.',
      network: 'Falha de rede no serviço SpeechRecognition do navegador.',
      'audio-capture': 'Nenhuma entrada de microfone disponível.',
    };
    $('log').textContent = known[event.error] || `Falha no reconhecimento (${event.error || 'desconhecida'}).`;
    state(known[event.error] || 'Falha de reconhecimento.', 'bad');
    $('listenBtn').disabled = false;
    if (continuousWanted && event.error === 'no-speech') setTimeout(startListening, 500);
  };
  rec.onend = () => {
    recognizing = false;
    $('listenBtn').disabled = false;
    if (!responseFinished && continuousWanted && !requestController && playbackPending === 0) setTimeout(startListening, 350);
  };
  return rec;
}
async function startListening() {
  if (recognizing || requestController) return;
  // Prime the persistent audio element during the user's click to reduce autoplay-policy failures later.
  edgeTts.unlock().catch(() => false);
  if (!SpeechRecognition) { createRecognition(); return; }
  edgeTts.cancel();
  audioProviders.tts.cancel();
  playbackPending = 0;
  responseFinished = true;
  recognition = createRecognition();
  if (!recognition) return;
  try {
    const capture = await audioProviders.stt.requestMicrophonePermission();
    reportState.microphoneGranted = true;
    reportState.microphoneCaptured = Boolean(capture?.captured);
    recognition.start();
  } catch (error) {
    recognizing = false;
    $('listenBtn').disabled = false;
    state('Não foi possível capturar o microfone. Revise a permissão e tente novamente.', 'bad');
    $('log').textContent = error.message;
  }
}
function exportReport() {
  const audible = confirm('Você ouviu a resposta falada em voz alta?');
  const report = {
    schema: 'kirana-voice-e2e-report/v2', createdAt: new Date().toISOString(),
    environment: { userAgent: navigator.userAgent, language: navigator.language },
    providers: {
      stt: { id: audioProviders.stt.id, implementation: 'Browser SpeechRecognition; underlying vendor is browser/OS-managed and not exposed' },
      tts: { selected: $('voiceSelect').value, thalitaVoice: THALITA_VOICE, edgeTtsRequirement: 'edge-tts==7.3.1 (expected install pin; runtime version not queried)', fallback: 'Browser SpeechSynthesis Francisca if exposed' },
    },
    selectedVoice: $('voiceSelect').selectedOptions[0]?.textContent || null,
    session: { authenticated: !!sessionInfo?.authenticated, siwc: !!sessionInfo?.sharing, grantedScopes: sessionInfo?.grantedScopes || [] },
    checks: { ...reportState, userConfirmedAudibleResponse: audible },
    metricsMs: {
      recognitionToText: Number.isFinite(parseFloat($('sttLatency').textContent)) ? parseFloat($('sttLatency').textContent) : null,
      firstModelToken: Number.isFinite(parseFloat($('firstTokenLatency').textContent)) ? parseFloat($('firstTokenLatency').textContent) : null,
      firstAudioPlayback: Number.isFinite(parseFloat($('firstAudioLatency').textContent)) ? parseFloat($('firstAudioLatency').textContent) : null,
      totalModelTurn: Number.isFinite(parseFloat($('totalLatency').textContent)) ? parseFloat($('totalLatency').textContent) : null,
    },
    privacy: { audioSaved: false, transcriptSaved: false, responseSaved: false, tokensOrSecretsIncluded: false },
    limitations: ['Thalita usa serviço Edge Read Aloud não documentado publicamente.','O browser/OS pode não expor Francisca como fallback.','Se o stream falhar após começar, a frase pode ser repetida pelo fallback para não omitir conteúdo.'],
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `kirana-voice-e2e-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  state('Relatório sanitizado exportado; confira o arquivo antes de compartilhar.', 'good');
}
function clearTurn() {
  if (requestController || recognizing || playbackPending) interrupt();
  messages.length = 0;
  assistantText = '';
  speechBuffer = '';
  playbackPending = 0;
  responseFinished = true;
  $('answer').textContent = '';
  $('transcript').textContent = 'A transcrição aparecerá aqui.';
  $('log').textContent = '';
  $('history').replaceChildren();
  for (const key of Object.keys(reportState)) if (typeof reportState[key] === 'boolean') reportState[key] = false;
  reportState.connectionFailures = 0;
  reportState.reconnectionSuccess = false;
  setLatency('sttLatency', NaN);
  setLatency('firstTokenLatency', NaN);
  setLatency('firstAudioLatency', NaN);
  setLatency('totalLatency', NaN);
  state('Turno limpo. Sessão SIWC permanece ativa.', 'good');
}

$('listenBtn').addEventListener('click', () => { continuousWanted = $('continuous').checked; startListening(); });
$('interruptBtn').addEventListener('click', interrupt);
$('reconnectBtn').addEventListener('click', () => { loadModels(); loadTtsCatalog(); });
$('voiceSelect').addEventListener('change', () => { userSelectedVoice = true; updateVoiceName(); });
$('continuous').addEventListener('change', (event) => { continuousWanted = event.target.checked; if (!continuousWanted && recognizing) recognition?.stop(); });
$('modelSelect').addEventListener('change', () => { $('modelChip').textContent = 'Modelo selecionado'; });
$('reportBtn').addEventListener('click', exportReport);
$('clearBtn').addEventListener('click', clearTurn);
window.speechSynthesis?.addEventListener?.('voiceschanged', () => fillVoices());
fillVoices();
loadModels();
loadTtsCatalog();
