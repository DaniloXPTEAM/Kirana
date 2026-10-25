/**
 * Kirana — voz conversacional (cliente). v0.4.1
 *
 * Isto NÃO é uma segunda Kirana: usa as mesmas sessões, o mesmo /api/chat, as
 * mesmas ferramentas e a mesma memória. O módulo faz apenas três coisas:
 *   1. ouvir (SpeechRecognition do navegador) e transcrever;
 *   2. pedir o texto da resposta a /api/voice/tts e tocar o MP3;
 *   3. entregar o texto transcrito para o MESMO `sendMessage()` do app.
 *
 * ── O que mudou na v0.4.1 e por quê ──────────────────────────────────────────
 * Três defeitos reais foram reproduzidos em teste antes desta reescrita:
 *
 * (a) AUTOESCUTA — o microfone era reaberto quando a FILA DE ÁUDIO esvaziava,
 *     o que acontece ENTRE as frases de uma resposta ainda em andamento. Nesse
 *     intervalo a Kirana já estava falando de novo, então a transcrição da
 *     própria voz virava mensagem do usuário (reproduzido: 4 reconhecedores
 *     criados numa única resposta e a fala da Kirana enviada como turno).
 *     Correção: a escuta só volta quando o TURNO termina (resposta completa +
 *     fila vazia + janela de silêncio), nunca quando a fila está vazia por um
 *     instante. Além disso existe UM único reconhecedor por vez, com token de
 *     sessão: eventos de sessões antigas são descartados na origem.
 *
 * (b) ÁUDIO DIFERENTE DO TEXTO — ao terminar o turno, o resto do buffer era
 *     `rest || textoCompleto`; quando a resposta terminava em pontuação (o caso
 *     normal), `rest` era vazio e a RESPOSTA INTEIRA era falada de novo
 *     (reproduzido no teste). Correção: nunca se usa o texto completo como
 *     reserva; só o resto realmente não falado.
 *
 * (c) PAUSAS ENTRE FRASES — a síntese do próximo trecho só era pedida depois
 *     que o áudio anterior terminava de tocar: o intervalo entre frases era
 *     igual à latência inteira do provedor (1–2 s aqui, 5–6 s nos logs do
 *     Windows). Correção: pipeline de um segmento — o próximo é pedido assim
 *     que o atual começa a tocar.
 *
 * Meia-duplex é intencional nesta versão. Interromper por voz (barge-in com o
 * microfone aberto durante a fala) fica para depois: exige cancelamento de eco
 * (AEC) confiável, que o SpeechRecognition do navegador não expõe.
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

/** Ajustes de escuta e de turno (ms). */
export const LISTEN_TUNING = {
  silenceMs: 900, // silêncio que encerra o enunciado
  minChars: 2, // abaixo disso, descarta (ruído)
  maxUtteranceMs: 20_000, // trava de segurança por enunciado
  restartDelayMs: 220, // pausa antes de reabrir o microfone
  muteAfterSpeechMs: 600, // janela surda depois do áudio (eco/cauda do alto-falante)
  thinkingTimeoutMs: 60_000, // sem nenhum delta: destrava a interface
  speakingStallMs: 20_000, // áudio parado sem progresso: destrava
  duplicateWindowMs: 2_000,
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

/** Emite um evento no documento sem quebrar fora do navegador (testes em Node). */
function emit(name, detail) {
  try {
    globalThis.window?.dispatchEvent?.(new CustomEvent(name, { detail }));
  } catch {
    /* ambiente sem DOM */
  }
}

/** Remove marcação óbvia apenas para decidir o que falar (o servidor limpa de novo). */
function looksSpeakable(text) {
  return /[\p{L}\p{N}]/u.test(text.replace(/```[\s\S]*?```/g, ' '));
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
  now = () => Date.now(),
} = {}) {
  const TIMING = { ...LISTEN_TUNING, ...tuning };

  const listeners = new Set();
  const stateHistory = [];
  const trace = []; // diagnóstico interno (usado nos testes de navegador)
  const diagnostics = []; // um registro por segmento falado (instrumentação)

  let state = VOICE_STATE.IDLE;
  let active = false;
  let epoch = 0; // invalida áudio/pedidos antigos
  let turnId = 0; // identifica o turno de conversa
  let segmentSeq = 0; // ordem global dos segmentos
  let turnOpen = false; // turno enviado e ainda não concluído
  let micToken = 0; // token da sessão de reconhecimento vigente
  let recognition = null;
  let recognizerLive = false; // já existe um recognizer criado e não encerrado
  let muteUntil = 0;
  let buffer = ''; // texto ainda não falado deste turno
  let transcript = '';
  let sawInterim = false;
  let silenceTimer = null;
  let utteranceTimer = null;
  let turnWatchdog = null;
  let stallWatchdog = null;
  let resumeTimer = null;
  let currentAudio = null;
  let releaseAudio = null; // libera o await do áudio em andamento
  let pendingTurn = false;
  let speechQueue = []; // [{ turnId, segmentId, text }]
  let speaking = false;
  let micDenied = false;
  let lastNotice = '';
  let lastUtterance = { text: '', at: 0 };
  let muted = false; // turno cancelado: não falar texto atrasado
  const activeRequests = new Set();
  const history = { turns: 0, cancellations: 0, errors: 0, phantomBlocked: 0 };

  const supported = Boolean(RecognitionImpl);

  const mark = (event, detail = {}) => {
    trace.push({ at: now(), event, state, turnId, ...detail });
    if (trace.length > 400) trace.shift();
  };

  function setState(next, detail = {}) {
    if (state === next && !detail.force) return;
    const previous = state;
    state = next;
    stateHistory.push({ from: previous, to: next, at: now(), turnId });
    if (stateHistory.length > 300) stateHistory.shift();
    for (const fn of listeners) {
      try {
        fn(state, { previous, ...detail });
      } catch (error) {
        logger.debug?.('[voz] ouvinte falhou', error?.message);
      }
    }
    onStateChange?.(state, { previous, ...detail });
    emit('kirana:voice-state', { state, previous, turnId, ...detail });
  }

  function notice(message, { sticky = false } = {}) {
    lastNotice = message;
    emit('kirana:voice-notice', { message, sticky });
  }

  /* -------------------- regra central: quando o microfone pode -------------- */

  /**
   * O microfone FICA FECHADO enquanto houver turno aberto, áudio tocando, fila
   * pendente ou dentro da janela surda pós-fala. Esta é a correção da
   * autoescuta: antes a condição era só "a fila está vazia agora?", que fica
   * verdadeira no meio de uma resposta, entre duas frases.
   */
  function micSuspended() {
    if (turnOpen || speaking || speechQueue.length > 0) return 'turn_busy';
    if (now() < muteUntil) return 'mute_window';
    return false;
  }

  function suspendMic(reason) {
    if (!recognizerLive && !recognition) return;
    micToken += 1; // qualquer evento da sessão antiga passa a ser ignorado
    mark('mic_suspend', { reason });
    try {
      // abort() descarta o áudio já capturado; stop() ainda entregaria o final.
      if (typeof recognition?.abort === 'function') recognition.abort();
      else recognition?.stop();
    } catch {
      /* já encerrado */
    }
  }

  function maybeResumeMic() {
    if (!active) return;
    const blocked = micSuspended();
    if (blocked) {
      mark('mic_stay_closed', { reason: blocked });
      return;
    }
    startRecognition();
  }

  /**
   * Programa a reabertura do microfone para depois da janela surda. Sem isso,
   * `maybeResumeMic()` recusaria a abertura (mute_window) e nada tentaria de
   * novo — a Kirana ficaria muda para sempre depois da primeira resposta.
   */
  function scheduleResume(delay = TIMING.muteAfterSpeechMs + 40) {
    clearTimeout(resumeTimer);
    if (!active) return;
    resumeTimer = setTimeout(() => {
      if (!active) return;
      const blocked = micSuspended();
      if (blocked === 'mute_window') {
        scheduleResume(80); // ainda dentro da janela: tenta de novo em breve
        return;
      }
      maybeResumeMic();
    }, delay);
  }

  /* ------------------------------- escuta -------------------------------- */

  function clearTimers() {
    clearTimeout(silenceTimer);
    clearTimeout(utteranceTimer);
    silenceTimer = null;
    utteranceTimer = null;
  }

  function startRecognition() {
    if (!supported || !active) return;
    if (micSuspended()) return;
    // Um único recognizer vivo por vez: se já existe, não cria outro.
    if (recognizerLive) {
      mark('recognizer_already_live');
      return;
    }

    const token = ++micToken;
    let instance;
    try {
      instance = new RecognitionImpl();
    } catch (error) {
      setState(VOICE_STATE.ERROR, { reason: 'recognition_init_failed', message: 'Não foi possível iniciar o microfone.' });
      return;
    }
    recognition = instance;
    recognizerLive = true;
    const isCurrent = () => token === micToken && recognition === instance;

    instance.lang = lang;
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;

    instance.onstart = () => {
      if (!isCurrent() || !active) return;
      transcript = '';
      sawInterim = false;
      setState(VOICE_STATE.LISTENING);
    };

    instance.onresult = (event) => {
      // Descarta, na origem, tudo que vier de uma sessão que já foi suspensa.
      if (!isCurrent() || !active) {
        history.phantomBlocked += 1;
        mark('result_from_stale_session');
        return;
      }
      if (micSuspended()) {
        history.phantomBlocked += 1;
        mark('result_while_suspended', { reason: micSuspended(), state });
        return;
      }
      if (pendingTurn || state === VOICE_STATE.PROCESSING) return;

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

    instance.onerror = (event) => {
      if (!isCurrent()) return;
      const code = event?.error || 'unknown';
      if (code === 'no-speech' || code === 'aborted') return; // ruído/restart: não é erro do usuário
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

    instance.onend = () => {
      const wasCurrent = token === micToken;
      if (recognition === instance) {
        recognizerLive = false;
        recognition = null;
      }
      if (!wasCurrent) return; // sessão antiga: não mexe no estado atual
      clearTimers();
      if (!active) {
        setState(VOICE_STATE.IDLE);
        return;
      }
      if (micSuspended()) return; // não reabre durante a resposta
      setTimeout(() => {
        if (active && !recognizerLive && !micSuspended()) startRecognition();
      }, TIMING.restartDelayMs);
    };

    try {
      instance.start();
      mark('recognizer_start', { token });
    } catch (error) {
      recognizerLive = false;
      recognition = null;
      if (String(error?.message || '').includes('already started')) return;
      history.errors += 1;
      setState(VOICE_STATE.ERROR, { reason: 'recognition_start_failed', message: 'Não foi possível abrir o microfone.' });
    }
  }

  function stopRecognition() {
    clearTimers();
    suspendMic('stop');
    recognizerLive = false;
    recognition = null;
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
      if (state === VOICE_STATE.SPEECH_DETECTED) setState(VOICE_STATE.LISTENING, { reason });
      return;
    }
    if (reason === 'silence' && sawInterim) {
      armSilence(); // ainda há fala em andamento (interino sem final): espera mais
      return;
    }
    // Anti-repetição: mesma frase capturada em sequência não vira novo turno.
    const at = now();
    if (text === lastUtterance.text && at - lastUtterance.at < TIMING.duplicateWindowMs) {
      setState(VOICE_STATE.LISTENING, { reason: 'duplicate_ignored' });
      return;
    }
    lastUtterance = { text, at };

    // Fecha o microfone ANTES de enviar: daqui até o fim da resposta, a Kirana
    // não pode ouvir nada (muito menos a própria voz).
    suspendMic('turn_started');
    recognizerLive = false;
    recognition = null;

    pendingTurn = true;
    turnOpen = true;
    muted = false;
    turnId += 1;
    segmentSeq = 0;
    speechQueue = [];
    buffer = '';
    history.turns += 1;
    const myTurn = turnId;
    setState(VOICE_STATE.PROCESSING, { reason });

    // Rede de segurança: se o app nunca sinalizar o fim (erro de rede, aba
    // suspensa), a interface não pode ficar presa em "processando".
    clearTimeout(turnWatchdog);
    turnWatchdog = setTimeout(() => {
      if (turnId !== myTurn || !turnOpen) return;
      mark('turn_watchdog');
      finishTurn({ reason: 'timeout' });
    }, TIMING.thinkingTimeoutMs);

    Promise.resolve(send(text, { source: 'voice', turn: myTurn })).catch((error) => {
      if (myTurn !== turnId) return;
      history.errors += 1;
      setState(VOICE_STATE.ERROR, { reason: 'send_failed', message: error?.message || 'Não consegui enviar sua fala.' });
      finishTurn({ reason: 'send_failed', error: true });
    });
  }

  /* -------------------------------- fala --------------------------------- */

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

  /** Solta a reprodução presa (áudio pausado nunca emite 'ended'). */
  function releasePlayback() {
    try {
      releaseAudio?.();
    } catch {
      /* ignora */
    }
    releaseAudio = null;
  }

  function canStreamMp3() {
    try {
      return Boolean(MediaSourceImpl?.isTypeSupported?.('audio/mpeg'));
    } catch {
      return false;
    }
  }

  function newSegment(text) {
    segmentSeq += 1;
    return { turnId, segmentId: `${turnId}-${segmentSeq}`, text };
  }

  /** Abre a síntese de um segmento. O corpo só é consumido na hora de tocar. */
  function requestChunk(segment, myEpoch) {
    const controller = new AbortController();
    activeRequests.add(controller);
    const startedAt = now();
    const promise = fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers() },
      body: JSON.stringify({
        sessionId: getSessionId?.() || '',
        text: segment.text,
        turnId: segment.turnId,
        segmentId: segment.segmentId,
      }),
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
    // Uma requisição cancelada (interrupção/barge-in) rejeita com AbortError.
    // Se ela estava só pré-encomendada pelo pipeline e ninguém chega a esperá-la,
    // o navegador acusaria "unhandled rejection" no console. O catch vazio marca
    // a rejeição como tratada; quem espera a resposta continua vendo o erro.
    promise.catch(() => {});
    return { promise, controller, segment, startedAt };
  }

  /** Toca a resposta já pedida ao servidor (streaming quando possível). */
  async function playResponse(response, request, { myEpoch, onPlayStart }) {
    const { segment } = request;
    const audio = new AudioImpl();
    if (!audio?.play) throw new Error('Áudio não suportado neste navegador.');
    audio.preload = 'auto';
    currentAudio = audio;

    const record = {
      turnId: segment.turnId,
      segmentId: segment.segmentId,
      textSent: segment.text,
      chars: segment.text.length,
      ttsStart: request.startedAt,
      ttsFirstByte: null,
      ttsEnd: null,
      playbackStart: null,
      playbackEnd: null,
      bytes: 0,
      outcome: 'started',
    };
    diagnostics.push(record);
    if (diagnostics.length > 60) diagnostics.shift();

    const noteFirstByte = () => {
      if (record.ttsFirstByte === null) record.ttsFirstByte = now();
    };
    let startedNotified = false;
    const notePlayStart = () => {
      if (record.playbackStart === null) record.playbackStart = now();
      if (!startedNotified) {
        startedNotified = true;
        onPlayStart?.(segment); // dispara a síntese do próximo segmento
      }
    };
    audio.addEventListener?.('playing', notePlayStart);
    audio.addEventListener?.('timeupdate', notePlayStart);

    const done = new Promise((resolve, reject) => {
      releaseAudio = resolve;
      audio.addEventListener?.('ended', resolve);
      audio.addEventListener?.('error', () => reject(new Error('Falha ao reproduzir o áudio.')));
    });
    done.catch(() => {});

    if (response.body && canStreamMp3()) {
      const mediaSource = new MediaSourceImpl();
      const url = URL.createObjectURL(mediaSource);
      audio.src = url;
      const buffered = new Promise((resolve) => {
        mediaSource.addEventListener('sourceopen', () => {
          let sourceBuffer;
          try {
            sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
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
                  if (sourceBuffer.updating) sourceBuffer.addEventListener('updateend', close, { once: true });
                  else close();
                  return;
                }
                record.bytes += value.length;
                noteFirstByte();
                if (sourceBuffer.updating) await new Promise((r) => sourceBuffer.addEventListener('updateend', r, { once: true }));
                try {
                  sourceBuffer.appendBuffer(value);
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
          const { done: finished, value } = await reader.read();
          if (finished) break;
          bytes.push(value);
          record.bytes += value.length;
          noteFirstByte();
        }
      }
      if (myEpoch !== epoch) return;
      const blob = new Blob(bytes, { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      audio.src = url;
      await audio.play().catch(() => notice('Toque na tela uma vez para permitir o áudio do navegador.'));
      await done.catch(() => {});
      URL.revokeObjectURL(url);
    }

    record.ttsEnd = record.ttsEnd ?? now();
    record.playbackEnd = now();
    record.outcome = 'played';
    mark('chunk_played', { segmentId: segment.segmentId, bytes: record.bytes });
    emit('kirana:voice-audio', {
      turnId: segment.turnId,
      segmentId: segment.segmentId,
      bytes: record.bytes,
      firstAudioMs: record.playbackStart ? record.playbackStart - record.ttsStart : null,
      totalMs: record.playbackEnd - record.ttsStart,
    });
  }

  /**
   * Fala a fila em ordem, até acabar ou ser interrompida.
   *
   * Ponto central de desempenho: o próximo segmento é PEDIDO ao servidor assim
   * que o atual começa a tocar (callback `onPlayStart`), não quando ele acaba.
   * Sem isso, o silêncio entre frases equivale à latência inteira do provedor.
   */
  async function drainQueue(myEpoch) {
    if (speaking) return;
    speaking = true;
    mark('drain_start', { myEpoch, epoch, queued: speechQueue.length });
    let upcoming = null;
    clearTimeout(stallWatchdog);
    try {
      const next = () => (myEpoch === epoch && speechQueue.length ? requestChunk(speechQueue.shift(), myEpoch) : null);
      upcoming = next();
      while (upcoming && myEpoch === epoch) {
        const current = upcoming;
        upcoming = null;
        setState(VOICE_STATE.SPEAKING, { force: state !== VOICE_STATE.SPEAKING });
        armStallWatchdog(myEpoch);
        try {
          mark('chunk_play_begin', { segmentId: current.segment.segmentId });
          await playResponse(await current.promise, current, {
            myEpoch,
            onPlayStart: () => {
              // Pipeline: já encomenda a próxima frase enquanto esta toca.
              if (!upcoming && myEpoch === epoch) upcoming = next();
            },
          });
          mark('chunk_play_end');
        } catch (error) {
          if (myEpoch !== epoch) return;
          const record = diagnostics.at(-1);
          if (record && record.outcome === 'started') record.outcome = error?.code || 'tts_failed';
          history.errors += 1;
          notice('A voz falhou agora, mas a resposta continua no texto. Você pode digitar ou tentar de novo.');
          setState(VOICE_STATE.ERROR, { reason: error?.code || 'tts_failed', message: 'A voz falhou; a resposta continua no texto.' });
          break;
        }
        if (!upcoming) upcoming = next();
      }
    } finally {
      upcoming?.controller.abort();
      clearTimeout(stallWatchdog);
      speaking = false;
      currentAudio = null;
      releaseAudio = null;
      mark('drain_end', { queued: speechQueue.length });
    }

    if (!active) {
      setState(VOICE_STATE.IDLE);
      return;
    }
    if (state === VOICE_STATE.SPEAKING || state === VOICE_STATE.INTERRUPTED) {
      // Janela surda: absorve a cauda do alto-falante antes de reabrir o mic.
      muteUntil = now() + TIMING.muteAfterSpeechMs;
      setState(VOICE_STATE.LISTENING, { reason: 'answer_audio_finished' });
    }
    scheduleResume();
  }

  function armStallWatchdog(myEpoch) {
    clearTimeout(stallWatchdog);
    stallWatchdog = setTimeout(() => {
      if (myEpoch !== epoch) return;
      mark('speaking_stall');
      history.errors += 1;
      notice('A reprodução parou. A resposta continua no texto.');
      setState(VOICE_STATE.ERROR, { reason: 'speaking_stall', message: 'A reprodução parou; a resposta está no texto.' });
      interrupt({ stopGeneration: false });
    }, TIMING.speakingStallMs);
  }

  function enqueueSpeech(text) {
    if (!speak || !looksSpeakable(text) || muted) return;
    speechQueue.push(newSegment(text));
  }

  /* ---------------------------- integração ------------------------------- */

  /** Chamado pelo app a cada delta de texto da resposta. */
  function appendDelta(delta) {
    if (!active || !delta || muted) return;
    clearTimeout(turnWatchdog);
    if (state === VOICE_STATE.PROCESSING) setState(VOICE_STATE.SPEAKING, { force: true });
    buffer += delta;
    // O primeiro segmento pode ser mais curto: falar cedo importa mais que
    // esperar a frase inteira.
    const firstChunk = segmentSeq === 0 && speechQueue.length === 0;
    const { chunks, rest } = takeSpeakableSentences(buffer, { minChars: firstChunk ? 12 : 24 });
    buffer = rest;
    for (const chunk of chunks) enqueueSpeech(chunk);
    if (speechQueue.length && !speaking) drainQueue(epoch);
  }

  /**
   * Chamado pelo app no fim do turno (sucesso, erro ou interrupção).
   *
   * `info.text` é o texto completo da resposta e serve APENAS de registro: o
   * que falta falar é sempre o resto do buffer, nunca a resposta inteira —
   * era esse fallback (`rest || texto`) que fazia a Kirana repetir tudo.
   */
  function endTurn({ aborted, error, pendingAction } = {}) {
    pendingTurn = false;
    clearTimeout(turnWatchdog);
    const rest = buffer.trim();
    buffer = '';
    if (active && !aborted && !error) {
      if (rest) enqueueSpeech(rest);
      mark('turn_end', { rest: rest.length, queued: speechQueue.length });
    }
    if (pendingAction && active) {
      // Voz NUNCA confirma ação: a autorização é na tela.
      notice('Há uma ação esperando sua confirmação na tela. Por segurança, a confirmação é só pelo botão da tela.', { sticky: true });
      enqueueSpeech('Preciso que você confirme esta ação na tela. Por segurança, eu não confirmo nada pela voz.');
    }
    finishTurn({ reason: aborted ? 'aborted' : error ? 'error' : 'completed' });
  }

  /** Fecha o turno e decide se o microfone volta. */
  function finishTurn({ reason } = {}) {
    turnOpen = false;
    clearTimeout(turnWatchdog);
    if (!active) {
      setState(VOICE_STATE.IDLE);
      return;
    }
    if (speechQueue.length || speaking) {
      if (!speaking) drainQueue(epoch);
      return; // volta a ouvir quando o áudio terminar
    }
    muteUntil = now() + TIMING.muteAfterSpeechMs;
    if (state === VOICE_STATE.PROCESSING || state === VOICE_STATE.SPEAKING || state === VOICE_STATE.INTERRUPTED) {
      setState(VOICE_STATE.LISTENING, { reason });
    }
    scheduleResume();
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
    speechQueue = [];
    turnOpen = false;
    pendingTurn = false;
    muteUntil = 0;
    setState(VOICE_STATE.REQUESTING_MIC, { force: true });
    // getUserMedia só para disparar a permissão de forma explícita; o
    // reconhecimento usa o próprio canal do navegador. As trilhas são
    // fechadas na hora — dois canais de microfone abertos não ajudam.
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
    turnOpen = false;
    epoch += 1;
    clearTimers();
    clearTimeout(turnWatchdog);
    clearTimeout(stallWatchdog);
    clearTimeout(resumeTimer);
    speechQueue = [];
    buffer = '';
    muteUntil = 0;
    abortRequests();
    releasePlayback();
    speaking = false;
    stopRecognition();
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

  /** Interrupção (barge-in manual): para o áudio e cancela a resposta. */
  function interrupt({ stopGeneration = true } = {}) {
    history.cancellations += 1;
    muted = true;
    epoch += 1;
    speechQueue = [];
    buffer = '';
    turnOpen = false;
    pendingTurn = false;
    clearTimeout(turnWatchdog);
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
    if (active) {
      muteUntil = now() + TIMING.muteAfterSpeechMs;
      scheduleResume();
    }
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
    get turnId() {
      return turnId;
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
    /** Instrumentação: um registro por segmento (texto, tempos, bytes). */
    get diagnostics() {
      return diagnostics.slice();
    },
    /** Diagnóstico do servidor (texto realmente enviado ao motor). */
    async report() {
      const sessionId = getSessionId?.() || '';
      let server = [];
      try {
        const response = await fetchImpl(`/api/voice/diagnostics?sessionId=${encodeURIComponent(sessionId)}`, { headers: headers() });
        if (response.ok) server = (await response.json()).entries ?? [];
      } catch {
        /* sem servidor: devolve só o lado do navegador */
      }
      return { browser: diagnostics.slice(), server, states: stateHistory.slice(), trace: trace.slice() };
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
    // superfícies usadas por testes de navegador e unitários
    _internal: {
      finishUtterance,
      takeSpeakableSentences,
      micSuspended,
      isRecognizerLive: () => recognizerLive,
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
