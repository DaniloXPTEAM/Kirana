/**
 * Kirana — voz conversacional (cliente).
 *
 * Isto NÃO é uma segunda Kirana: usa as mesmas sessões, o mesmo /api/chat, as
 * mesmas ferramentas e a mesma memória. O módulo faz apenas três coisas:
 *   1. ouvir (SpeechRecognition do navegador) e transcrever;
 *   2. pedir o texto da resposta a /api/voice/tts e tocar o MP3;
 *   3. entregar o texto transcrito para o MESMO `sendMessage()` do app.
 *
 * Regras que este arquivo respeita:
 *   - microfone só escuta quando não há áudio tocando (evita eco);
 *   - "sim" falado nunca autoriza ação: confirmação é só na tela;
 *   - interrupção (barge-in) para o áudio, cancela a geração e invalida os
 *     pedaços de fala que chegariam atrasados.
 */

/** Estados explícitos da conversa por voz. */
export const VOICE_STATE = {
  IDLE: 'inativo',
  REQUESTING_MIC: 'pedindo-microfone',
  LISTENING: 'ouvindo',
  SPEECH_DETECTED: 'fala-detectada',
  PROCESSING: 'processando',
  SPEAKING: 'falando',
  INTERRUPTED: 'interrompido',
  ERROR: 'erro',
};

/** Ajustes de escuta (ms). */
export const LISTEN_TUNING = {
  silenceMs: 900, // silêncio que encerra o enunciado
  minChars: 2, // abaixo disso, descarta (ruído)
  maxUtteranceMs: 20_000, // trava de segurança
  restartDelayMs: 220, // pausa antes de reabrir o microfone
};

/**
 * Quebra a resposta em pedaços faláveis no fim de frase, para que a primeira
 * frase já toque enquanto o resto do texto ainda está chegando.
 *
 * Devolve `{ chunks, rest }`: `chunks` podem ser falados agora, `rest` é o
 * resto incompleto que fica no buffer para o próximo delta.
 */
export function takeSpeakableSentences(buffer, { minChars = 24, maxChars = 320 } = {}) {
  const chunks = [];
  let rest = String(buffer ?? '');

  const push = (text) => {
    let piece = text.trim();
    while (piece.length > maxChars) {
      const cut = piece.lastIndexOf(' ', maxChars);
      const at = cut > minChars ? cut : maxChars;
      chunks.push(piece.slice(0, at).trim());
      piece = piece.slice(at).trim();
    }
    if (piece) chunks.push(piece);
  };

  for (;;) {
    const boundary = rest.match(/[.!?…](\s|$)/);
    if (!boundary) break;
    const sentence = rest.slice(0, boundary.index + 1).trim();
    const after = rest.slice(boundary.index + boundary[0].length);

    if (sentence.length < minChars) {
      // frase curta ("Oi!"): junta com a seguinte para não falar picado,
      // mas só quando a seguinte já terminou.
      const next = after.match(/[.!?…](\s|$)/);
      if (!next) break; // espera o próximo delta
      const combined = `${sentence} ${after.slice(0, next.index + 1).trim()}`.trim();
      push(combined);
      rest = after.slice(next.index + next[0].length);
      continue;
    }

    push(sentence);
    rest = after;
  }

  return { chunks, rest };
}

/** Remove marcação óbvia apenas para decidir o que falar (o backend limpa de novo). */
function looksSpeakable(text) {
  return /[\p{L}\p{N}]/u.test(text.replace(/```[\s\S]*?```/g, ' '));
}

/** Emite um evento no documento sem quebrar fora do navegador (testes em Node). */
function emit(name, detail) {
  try {
    globalThis.window?.dispatchEvent?.(new CustomEvent(name, { detail }));
  } catch {
    /* ambiente sem DOM */
  }
}

export function createVoiceController({
  send,
  stop,
  getSessionId,
  onStateChange,
  fetchImpl = (...args) => fetch(...args),
  RecognitionImpl = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition,
  MediaSourceImpl = globalThis.MediaSource,
  AudioImpl = globalThis.Audio,
  lang = 'pt-BR',
  endpoint = '/api/voice/tts',
  headers = () => ({}),
  speak = true,
  logger = console,
  tuning = {},
} = {}) {
  const TIMING = { ...LISTEN_TUNING, ...tuning };
  const listeners = new Set();
  let recognition = null;
  let state = VOICE_STATE.IDLE;
  let active = false;
  let epoch = 0; // invalida áudio/pedidos antigos
  let transcript = '';
  let sawInterim = false;
  let silenceTimer = null;
  let utteranceTimer = null;
  let currentAudio = null;
  let releaseAudio = null; // libera o await do áudio em andamento
  const activeRequests = new Set();
  let pendingTurn = false;
  let speechQueue = [];
  let speaking = false;
  let micDenied = false;
  let lastNotice = '';
  let turnEpoch = 0;
  let buffer = '';
  let lastUtterance = { text: '', at: 0 };
  // Depois de interromper, o turno está cancelado: texto que ainda chegar do
  // servidor NÃO deve ser falado (é a "resposta fantasma" do barge-in).
  let muted = false;

  const stateHistory = [];
  const trace = []; // diagnóstico interno (usado nos testes de navegador)
  const mark = (event, detail = {}) => {
    trace.push({ at: Date.now(), event, state, ...detail });
    if (trace.length > 300) trace.shift();
  };
  const supported = Boolean(RecognitionImpl);
  const history = { turns: 0, cancellations: 0, errors: 0 };

  function setState(next, detail = {}) {
    if (state === next && !detail.force) {
      return;
    }
    const previous = state;
    state = next;
    stateHistory.push({ from: previous, to: next, at: Date.now() });
    if (stateHistory.length > 200) stateHistory.shift();
    for (const fn of listeners) {
      try {
        fn(state, { previous, ...detail });
      } catch (error) {
        logger.debug?.('[voz] ouvinte falhou', error?.message);
      }
    }
    onStateChange?.(state, { previous, ...detail });
    emit('kirana:voice-state', { state, previous, ...detail });
  }

  function notice(message, { sticky = false } = {}) {
    lastNotice = message;
    emit('kirana:voice-notice', { message, sticky });
  }

  /* ------------------------------- escuta -------------------------------- */

  function clearTimers() {
    clearTimeout(silenceTimer);
    clearTimeout(utteranceTimer);
    silenceTimer = null;
    utteranceTimer = null;
  }

  function startRecognition() {
    if (!supported || !active || speaking || state === VOICE_STATE.PROCESSING) return;
    try {
      recognition = new RecognitionImpl();
    } catch (error) {
      setState(VOICE_STATE.ERROR, { reason: 'recognition_init_failed', message: 'Não foi possível iniciar o microfone.' });
      return;
    }
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      transcript = '';
      sawInterim = false;
      if (active && !speaking) setState(VOICE_STATE.LISTENING);
    };

    recognition.onresult = (event) => {
      // Nunca transcreve a própria voz, nem aceita resultados de um turno que
      // já foi enviado (o motor às vezes entrega o mesmo final duas vezes).
      if (!active || speaking || pendingTurn || state === VOICE_STATE.PROCESSING) return;
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += text;
        else interim += text;
      }
      if (finalText) {
        const clean = finalText.trim();
        // O motor às vezes repete o mesmo trecho final: não duplica a fala.
        const already = transcript.trim().endsWith(clean);
        if (clean && !already) {
          transcript = transcript.trim() ? `${transcript.trim()} ${clean}` : clean;
        }
        sawInterim = false;
      }
      if (interim) sawInterim = true;
      if ((finalText || interim) && state !== VOICE_STATE.SPEECH_DETECTED) {
        setState(VOICE_STATE.SPEECH_DETECTED);
        utteranceTimer = setTimeout(() => finishUtterance('max_duration'), TIMING.maxUtteranceMs);
      }
      if (finalText || interim) armSilence();
    };

    recognition.onerror = (event) => {
      const code = event?.error || 'unknown';
      if (code === 'no-speech' || code === 'aborted') return; // ruído/ reinício: não é erro do usuário
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        micDenied = true;
        active = false;
        history.errors += 1;
        setState(VOICE_STATE.ERROR, { reason: 'mic_denied', message: 'Permissão do microfone negada. Você pode continuar digitando.' });
        return;
      }
      history.errors += 1;
      setState(VOICE_STATE.ERROR, { reason: code, message: 'Falha no microfone. Tente novamente.' });
    };

    recognition.onend = () => {
      clearTimers();
      if (!active) {
        setState(VOICE_STATE.IDLE);
        return;
      }
      if (speaking || state === VOICE_STATE.PROCESSING) return;
      setTimeout(() => {
        if (active && !speaking && state !== VOICE_STATE.PROCESSING) {
          try {
            recognition?.start();
          } catch {
            /* já iniciado */
          }
        }
      }, TIMING.restartDelayMs);
    };

    try {
      recognition.start();
    } catch (error) {
      if (String(error?.message || '').includes('already started')) return;
      history.errors += 1;
      setState(VOICE_STATE.ERROR, { reason: 'recognition_start_failed', message: 'Não foi possível abrir o microfone.' });
    }
  }

  function stopRecognition() {
    clearTimers();
    try {
      recognition?.stop();
    } catch {
      /* ignora */
    }
  }

  function armSilence() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => finishUtterance('silence'), TIMING.silenceMs);
  }

  /** Fim do enunciado: entrega o texto ao app (mesmo sendMessage do chat). */
  function finishUtterance(reason) {
    clearTimers();
    if (!active || pendingTurn) return;
    const text = transcript.trim();
    transcript = '';
    if (!text || text.length < TIMING.minChars || !looksSpeakable(text)) {
      // nada útil: volta a ouvir sem criar turno fantasma
      if (state === VOICE_STATE.SPEECH_DETECTED) setState(VOICE_STATE.LISTENING, { reason });
      return;
    }
    if (reason === 'silence' && sawInterim) {
      // ainda há fala em andamento (interino sem final): espera mais
      armSilence();
      return;
    }
    // Anti-repetição: mesma frase capturada em sequência não vira novo turno.
    const now = Date.now();
    if (text === lastUtterance.text && now - lastUtterance.at < 2000) {
      setState(VOICE_STATE.LISTENING, { reason: 'duplicate_ignored' });
      return;
    }
    lastUtterance = { text, at: now };
    stopRecognition();
    pendingTurn = true;
    muted = false; // novo turno: volta a poder falar
    turnEpoch += 1;
    const myTurn = turnEpoch;
    speechQueue = [];
    setState(VOICE_STATE.PROCESSING, { reason });
    Promise.resolve(send(text, { source: 'voice', turn: myTurn })).catch((error) => {
      if (myTurn !== turnEpoch) return;
      history.errors += 1;
      setState(VOICE_STATE.ERROR, { reason: 'send_failed', message: error?.message || 'Não consegui enviar sua fala.' });
      resumeListening();
    });
  }

  /* -------------------------------- fala --------------------------------- */

  /** Solta a reprodução presa (áudio pausado nunca emite 'ended'). */
  function releasePlayback() {
    try {
      releaseAudio?.();
    } catch {
      /* ignora */
    }
    releaseAudio = null;
  }

  /** Aborta todas as sínteses em andamento (barge-in / encerrar). */
  function abortRequests() {
    for (const controller of activeRequests) {
      try {
        controller.abort();
      } catch {
        /* ignora */
      }
    }
    activeRequests.clear();
  }

  function canStreamMp3() {
    try {
      return Boolean(MediaSourceImpl?.isTypeSupported?.('audio/mpeg'));
    } catch {
      return false;
    }
  }

  /** Abre a síntese de um pedaço. O corpo é consumido só na hora de tocar. */
  function requestChunk(text, myEpoch) {
    const controller = new AbortController();
    activeRequests.add(controller);
    const promise = fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers() },
      body: JSON.stringify({ sessionId: getSessionId?.() || '', text }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw Object.assign(new Error(payload?.error?.message || 'Motor de voz indisponível.'), {
            code: payload?.error?.code || 'voice_http_error',
          });
        }
        if (myEpoch !== epoch) throw Object.assign(new Error('cancelado'), { code: 'voice_aborted' });
        return response;
      })
      .finally(() => activeRequests.delete(controller));
    return { promise, controller };
  }

  /** Toca a resposta já pedida ao servidor (streaming quando possível). */
  async function playResponse(response, { myEpoch }) {
    const audio = new AudioImpl();
    if (!audio?.play) throw new Error('Áudio não suportado neste navegador.');
    audio.preload = 'auto';
    currentAudio = audio;

    const startedAt = Date.now();
    const metrics = { firstAudioMs: null, totalMs: null, bytes: 0 };

    const noteFirst = () => {
      if (metrics.firstAudioMs === null) metrics.firstAudioMs = Date.now() - startedAt;
    };
    audio.addEventListener?.('playing', noteFirst);
    audio.addEventListener?.('timeupdate', noteFirst);

    const done = new Promise((resolve, reject) => {
      releaseAudio = resolve;
      audio.addEventListener?.('ended', resolve);
      audio.addEventListener?.('error', () => reject(new Error('Falha ao reproduzir o áudio.')));
    });
    done.catch(() => {});

    if (response.body && canStreamMp3()) {
      // Reprodução progressiva: toca enquanto o MP3 ainda está chegando.
      const mediaSource = new MediaSourceImpl();
      const url = URL.createObjectURL(mediaSource);
      audio.src = url;
      const buffered = new Promise((resolve) => {
        mediaSource.addEventListener('sourceopen', () => {
          let buffer;
          try {
            buffer = mediaSource.addSourceBuffer('audio/mpeg');
          } catch {
            resolve();
            return;
          }
          const reader = response.body.getReader();
          const pump = async () => {
            try {
              for (;;) {
                if (myEpoch !== epoch) {
                  await reader.cancel().catch(() => {});
                  return;
                }
                const { done: finished, value } = await reader.read();
                if (finished) {
                  const close = () => {
                    if (mediaSource.readyState === 'open') {
                      try {
                        mediaSource.endOfStream();
                      } catch {
                        /* já encerrado */
                      }
                    }
                    resolve();
                  };
                  if (buffer.updating) buffer.addEventListener('updateend', close, { once: true });
                  else close();
                  return;
                }
                metrics.bytes += value.length;
                if (buffer.updating) await new Promise((r) => buffer.addEventListener('updateend', r, { once: true }));
                try {
                  buffer.appendBuffer(value);
                } catch {
                  /* cota do MediaSource: segue com o que já foi anexado */
                }
                if (audio.paused) audio.play().catch(() => {});
              }
            } catch {
              resolve();
            }
          };
          pump();
        }, { once: true });
      });
      audio.play().catch(() => notice('Toque na tela uma vez para permitir o áudio do navegador.'));
      await buffered;
      await done.catch(() => {});
      URL.revokeObjectURL(url);
    } else {
      // Navegador sem MP3 em MediaSource (ex.: Firefox): acumula e toca.
      const bytes = [];
      const reader = response.body?.getReader?.();
      if (reader) {
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const { done: finished, value } = await reader.read();
          if (finished) break;
          bytes.push(value);
          metrics.bytes += value.length;
        }
      }
      if (myEpoch !== epoch) return;
      const blob = new Blob(bytes, { type: 'audio/mpeg' });
      metrics.bytes = blob.size;
      const url = URL.createObjectURL(blob);
      audio.src = url;
      await audio.play().catch(() => notice('Toque na tela uma vez para permitir o áudio do navegador.'));
      await done.catch(() => {});
      URL.revokeObjectURL(url);
    }

    metrics.totalMs = Date.now() - startedAt;
    mark('chunk_played', metrics);
    emit('kirana:voice-audio', metrics);
  }

  /**
   * Fala os pedaços enfileirados, em ordem, até acabar ou ser interrompido.
   * A próxima frase é pedida ao servidor ENQUANTO a atual toca — sem isso
   * haveria ~1 s de silêncio entre frases.
   */
  async function drainQueue(myEpoch) {
    if (speaking) {
      mark('drain_skipped', { myEpoch });
      return;
    }
    speaking = true;
    mark('drain_start', { myEpoch, epoch, queued: speechQueue.length });
    let upcoming = null;
    try {
      if (speechQueue.length) upcoming = requestChunk(speechQueue.shift(), myEpoch);
      while (upcoming && myEpoch === epoch) {
        const current = upcoming;
        upcoming = null;
        setState(VOICE_STATE.SPEAKING, { force: state !== VOICE_STATE.SPEAKING });
        try {
          mark('chunk_play_begin');
          await playResponse(await current.promise, { myEpoch });
          mark('chunk_play_end');
        } catch (error) {
          if (myEpoch !== epoch) return;
          history.errors += 1;
          notice('A voz falhou agora, mas a resposta continua no texto. Você pode digitar ou tentar de novo.');
          setState(VOICE_STATE.ERROR, { reason: error?.code || 'tts_failed', message: 'A voz falhou; a resposta continua no texto.' });
          break;
        }
        if (myEpoch === epoch && speechQueue.length) upcoming = requestChunk(speechQueue.shift(), myEpoch);
      }
    } finally {
      upcoming?.controller.abort();
      speaking = false;
      currentAudio = null;
      mark('drain_end', { queued: speechQueue.length });
    }
    if (!active) {
      setState(VOICE_STATE.IDLE);
      return;
    }
    if (state === VOICE_STATE.SPEAKING || state === VOICE_STATE.INTERRUPTED) setState(VOICE_STATE.LISTENING);
    resumeListening();
  }

  function enqueueSpeech(text) {
    if (!speak || !looksSpeakable(text)) return;
    speechQueue.push(text);
  }

  /* ---------------------------- integração ------------------------------- */

  /** Chamado pelo app a cada delta de texto da resposta. */
  function appendDelta(delta) {
    if (!active || !delta || muted) return;
    if (state === VOICE_STATE.PROCESSING) setState(VOICE_STATE.SPEAKING, { force: true });
    buffer += delta;
    const { chunks, rest } = takeSpeakableSentences(buffer);
    buffer = rest;
    for (const chunk of chunks) enqueueSpeech(chunk);
    if (speechQueue.length && !speaking) drainQueue(epoch);
  }

  /** Chamado pelo app no fim do turno (sucesso, erro ou interrupção). */
  function endTurn({ text, aborted, error, pendingAction } = {}) {
    pendingTurn = false;
    const rest = buffer.trim();
    buffer = '';
    if (active && !aborted && !error) {
      // resto da resposta que não terminou em pontuação
      const tail = rest || String(text || '').trim();
      if (tail) enqueueSpeech(tail);
    }
    if (pendingAction && active) {
      // Voz NUNCA confirma ação: a autorização é na tela.
      notice('Há uma ação esperando sua confirmação na tela. Por segurança, a confirmação é só pelo botão da tela.', { sticky: true });
      enqueueSpeech('Preciso que você confirme esta ação na tela. Por segurança, eu não confirmo nada pela voz.');
    }
    if (!speechQueue.length && state === VOICE_STATE.PROCESSING) setState(VOICE_STATE.LISTENING);
    if (speechQueue.length && !speaking) drainQueue(epoch);
  }

  function resumeListening() {
    if (!active) return;
    if (speaking || state === VOICE_STATE.PROCESSING) return;
    startRecognition();
  }

  /** Liga a voz (pede o microfone). */
  async function start() {
    if (!supported) {
      notice('Este navegador não reconhece fala. Use o texto ou o Chrome/Edge no computador ou Android.');
      setState(VOICE_STATE.ERROR, { reason: 'stt_unsupported', message: 'Reconhecimento de fala indisponível neste navegador.' });
      return false;
    }
    if (active) return true;
    active = true;
    epoch += 1;
    muted = false;
    buffer = '';
    setState(VOICE_STATE.REQUESTING_MIC, { force: true });
    // getUserMedia só para disparar a permissão de forma explícita; o
    // reconhecimento usa o próprio canal do navegador.
    try {
      const stream = await navigator.mediaDevices?.getUserMedia?.({ audio: true });
      stream?.getTracks?.().forEach((track) => track.stop());
    } catch (error) {
      active = false;
      micDenied = true;
      history.errors += 1;
      setState(VOICE_STATE.ERROR, { reason: 'mic_denied', message: 'Não consegui acessar o microfone. Verifique a permissão do navegador.' });
      return false;
    }
    startRecognition();
    return true;
  }

  /** Desliga a voz: para áudio, microfone e invalida o que estava a caminho. */
  function stopAll({ silent = false } = {}) {
    active = false;
    pendingTurn = false;
    epoch += 1;
    clearTimers();
    speechQueue = [];
    buffer = '';
    stopRecognition();
    abortRequests();
    releasePlayback();
    speaking = false;
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.removeAttribute?.('src');
        currentAudio.load?.();
      } catch {
        /* ignora */
      }
    }
    currentAudio = null;
    if (!silent) setState(VOICE_STATE.IDLE, { force: true });
  }

  /** Interrupção (barge-in): para o áudio e cancela a resposta em geração. */
  function interrupt({ stopGeneration = true } = {}) {
    history.cancellations += 1;
    muted = true;
    epoch += 1;
    turnEpoch += 1;
    speechQueue = [];
    buffer = '';
    abortRequests();
    releasePlayback();
    speaking = false;
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.currentTime = 0;
      } catch {
        /* ignora */
      }
    }
    if (stopGeneration) stop?.();
    setState(VOICE_STATE.INTERRUPTED, { force: true });
    if (active) setTimeout(() => active && resumeListening(), 80);
  }

  /** Toque no botão: liga, interrompe (se falando/gerando) ou desliga. */
  async function toggle() {
    if (!active) return start();
    if (state === VOICE_STATE.SPEAKING || state === VOICE_STATE.PROCESSING || state === VOICE_STATE.SPEECH_DETECTED) {
      interrupt({ stopGeneration: state === VOICE_STATE.PROCESSING || state === VOICE_STATE.SPEAKING });
      return true;
    }
    stopAll();
    return false;
  }

  function dispose() {
    stopAll({ silent: true });
    listeners.clear();
  }

  return {
    VOICE_STATE,
    get state() {
      return state;
    },
    get active() {
      return active;
    },
    get supported() {
      return supported;
    },
    get micDenied() {
      return micDenied;
    },
    get notice() {
      return lastNotice;
    },
    get history() {
      return { ...history, states: stateHistory.slice() };
    },
    get queueSize() {
      return speechQueue.length;
    },
    get trace() {
      return trace.slice();
    },
    start,
    stop: stopAll,
    toggle,
    interrupt,
    appendDelta,
    endTurn,
    dispose,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // superfícies usadas por testes de navegador
    _internal: {
      finishUtterance,
      takeSpeakableSentences,
      get transcript() {
        return transcript;
      },
      set transcript(value) {
        transcript = value;
      },
    },
  };
}

/** Liga a voz ao app principal (botão + ponte com sendMessage). */
export function mountVoice(options) {
  const controller = createVoiceController(options);
  if (typeof window !== 'undefined') window.kiranaVoice = controller;
  return controller;
}
