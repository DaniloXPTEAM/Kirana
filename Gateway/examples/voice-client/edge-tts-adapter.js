export const THALITA_VOICE = 'pt-BR-ThalitaMultilingualNeural';

export function sanitizeTextForSpeech(value) {
  let text = String(value ?? '');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/```[^\n]*\n?|```/g, ' ');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/https?:\/\/\S+|www\.\S+/g, ' ');
  text = text.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '');
  text = text.replace(/[*_~]{1,3}/g, '');
  text = text.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0E\uFE0F\u200D\u20E3]/gu, '');
  text = text.replace(/[ \t]+/g, ' ').replace(/\s*\n+\s*/g, ' ').replace(/\s+([,.;:!?])/g, '$1');
  return text.trim();
}

export function createEdgeTtsAdapter(host = globalThis) {
  let activeAudio = null;
  let audioElement = null;
  let activeReader = null;
  let activeObjectUrl = null;
  let audioUnlocked = false;

  async function unlock() {
    if (audioUnlocked) return true;
    audioElement ||= new host.Audio();
    const blob = createSilentWav(host);
    const url = host.URL.createObjectURL(blob);
    audioElement.muted = true;
    audioElement.src = url;
    try {
      await audioElement.play();
      audioUnlocked = true;
      return true;
    } catch {
      return false;
    } finally {
      audioElement.pause();
      audioElement.removeAttribute('src');
      audioElement.load();
      host.URL.revokeObjectURL(url);
      audioElement.muted = false;
    }
  }

  async function play(text, { signal, onPlaying = () => {}, onProvider = () => {} } = {}) {
    const clean = sanitizeTextForSpeech(text);
    if (!clean) return;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const response = await host.fetch('/api/tts/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice: THALITA_VOICE, text: clean }), signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Edge TTS indisponível (HTTP ${response.status}).`);
    }
    if (!response.body) throw new Error('Edge TTS respondeu sem stream de áudio.');

    audioElement ||= new host.Audio();
    const audio = audioElement;
    activeAudio = audio;
    audio.preload = 'auto';
    try {
      if (host.MediaSource && host.MediaSource.isTypeSupported('audio/mpeg')) {
        audio.addEventListener('playing', () => { onProvider('Thalita Neural — Edge TTS'); onPlaying(); }, { once: true });
        const mediaSource = new host.MediaSource();
        activeObjectUrl = host.URL.createObjectURL(mediaSource);
        audio.src = activeObjectUrl;
        await waitForSourceOpen(mediaSource, signal);
        let sourceBuffer;
        try {
          sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
          sourceBuffer.mode = 'sequence';
        } catch {
          audio.removeAttribute('src');
          audio.load();
          releaseObjectUrl();
          await playBuffered(response, audio, signal, onPlaying, onProvider);
          return;
        }
        const ended = waitForAudioEnd(audio, signal);
        const reader = response.body.getReader();
        activeReader = reader;
        let playbackStarted = false;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (signal?.aborted) throw abortError();
            await appendBuffer(sourceBuffer, value);
            if (!playbackStarted) {
              playbackStarted = true;
              await audio.play();
            }
          }
          if (mediaSource.readyState === 'open') mediaSource.endOfStream();
          if (!playbackStarted) throw new Error('Thalita não retornou áudio utilizável.');
          await ended;
        } finally {
          activeReader = null;
          if (signal?.aborted) reader.cancel().catch(() => {});
        }
      } else {
        await playBuffered(response, audio, signal, onPlaying, onProvider);
      }
    } catch (error) {
      if (activeReader) await activeReader.cancel().catch(() => {});
      else await response.body.cancel().catch(() => {});
      throw error;
    } finally {
      if (activeAudio === audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        releaseObjectUrl();
        activeAudio = null;
        activeReader = null;
      }
    }
  }

  async function playBuffered(response, audio, signal, onPlaying, onProvider) {
    const reader = response.body.getReader();
    activeReader = reader;
    const chunks = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (signal?.aborted) throw abortError();
        chunks.push(value);
      }
      const blob = new host.Blob(chunks, { type: 'audio/mpeg' });
      if (!blob.size) throw new Error('Thalita não retornou áudio utilizável.');
      activeObjectUrl = host.URL.createObjectURL(blob);
      audio.src = activeObjectUrl;
      audio.addEventListener('playing', () => { onProvider('Thalita Neural — Edge TTS (buffer completo)'); onPlaying(); }, { once: true });
      const ended = waitForAudioEnd(audio, signal);
      await audio.play();
      await ended;
    } finally {
      activeReader = null;
    }
  }

  function waitForSourceOpen(mediaSource, signal) {
    return new Promise((resolve, reject) => {
      if (mediaSource.readyState === 'open') return resolve();
      mediaSource.addEventListener('sourceopen', resolve, { once: true });
      mediaSource.addEventListener('error', () => reject(new Error('O navegador não abriu o stream MP3.')), { once: true });
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  }
  function waitForAudioEnd(audio, signal) {
    return new Promise((resolve, reject) => {
      audio.addEventListener('ended', resolve, { once: true });
      audio.addEventListener('error', () => reject(new Error('Falha ao decodificar/reproduzir o áudio MP3.')), { once: true });
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  }
  function appendBuffer(sourceBuffer, bytes) {
    return new Promise((resolve, reject) => {
      const finish = () => { sourceBuffer.removeEventListener('updateend', finish); sourceBuffer.removeEventListener('error', fail); resolve(); };
      const fail = () => { sourceBuffer.removeEventListener('updateend', finish); sourceBuffer.removeEventListener('error', fail); reject(new Error('Falha ao receber o stream MP3.')); };
      sourceBuffer.addEventListener('updateend', finish, { once: true });
      sourceBuffer.addEventListener('error', fail, { once: true });
      try { sourceBuffer.appendBuffer(bytes); } catch (error) { fail(); reject(error); }
    });
  }
  function releaseObjectUrl() {
    if (activeObjectUrl) host.URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  }
  function abortError() { return new DOMException('Aborted', 'AbortError'); }
  function cancel() {
    activeReader?.cancel().catch(() => {});
    activeAudio?.pause();
    if (activeAudio) { activeAudio.removeAttribute('src'); activeAudio.load(); }
    releaseObjectUrl();
    activeReader = null;
    activeAudio = null;
  }
  function createSilentWav(hostObject) {
    const sampleRate = 8000;
    const samples = Math.floor(sampleRate / 10);
    const bytes = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(bytes);
    const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples * 2, true);
    return new hostObject.Blob([bytes], { type: 'audio/wav' });
  }
  async function listVoices({ signal } = {}) {
    const response = await host.fetch('/api/tts/voices', { cache: 'no-store', signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Catálogo de vozes indisponível (HTTP ${response.status}).`);
    const voices = Array.isArray(data.voices) ? data.voices : [];
    return { available: voices.some((voice) => voice.shortName === THALITA_VOICE), voices };
  }
  return { id: 'edge-tts-thalita', voice: THALITA_VOICE, sanitizeTextForSpeech, listVoices, play, unlock, cancel };
}
