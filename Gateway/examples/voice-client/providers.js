// Browser-managed adapters only. Their underlying network/provider behavior is controlled by the browser/OS.
export function createBrowserAudioAdapters(host = globalThis) {
  const Recognition = host.SpeechRecognition || host.webkitSpeechRecognition || null;
  const synthesis = host.speechSynthesis || null;
  const Utterance = host.SpeechSynthesisUtterance || null;

  return {
    stt: {
      id: 'browser-speech-recognition',
      disclosure: 'Browser SpeechRecognition; the underlying service/provider is not exposed to this page.',
      supported: () => Boolean(Recognition),
      async requestMicrophonePermission() {
        if (!host.navigator?.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in this browser context.');
        const stream = await host.navigator.mediaDevices.getUserMedia({ audio: true });
        const hasLiveTrack = stream.getAudioTracks().some((track) => track.readyState === 'live');
        for (const track of stream.getTracks()) track.stop();
        if (!hasLiveTrack) throw new Error('The browser did not provide an active microphone track.');
        return { captured: true };
      },
      createRecognition(locale = 'pt-BR') {
        if (!Recognition) throw new Error('SpeechRecognition is unsupported by this browser.');
        const recognition = new Recognition();
        recognition.lang = locale;
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        return recognition;
      },
    },
    tts: {
      id: 'browser-speech-synthesis',
      disclosure: 'Browser SpeechSynthesis; the selected voice may be local or browser/OS-managed and is not ChatGPT TTS.',
      supported: () => Boolean(synthesis && Utterance),
      getVoices: () => synthesis?.getVoices?.() || [],
      createUtterance(text, voice, callbacks = {}) {
        if (!synthesis || !Utterance) throw new Error('SpeechSynthesis is unsupported by this browser.');
        const utterance = new Utterance(text);
        if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
        utterance.rate = 1;
        utterance.pitch = 1;
        utterance.onstart = callbacks.onstart || null;
        utterance.onend = callbacks.onend || null;
        utterance.onerror = callbacks.onerror || null;
        return utterance;
      },
      speak: (utterance) => synthesis?.speak(utterance),
      cancel: () => synthesis?.cancel(),
      get speaking() { return Boolean(synthesis?.speaking); },
    },
  };
}
