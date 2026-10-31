import { join, resolve } from 'node:path';
import { ComfyUIProvider } from './comfyui.js';
import { PiperProvider } from './piper.js';
import { VideoAnalysisProvider } from './video-analysis.js';
import { WhisperCppProvider } from './whisper-cpp.js';

function envInteger(env,name,defaultValue,min,max) {
  const raw=env[name]; if(raw===undefined||raw==='') return defaultValue;
  const value=Number(raw); if(!Number.isInteger(value)||value<min||value>max) throw new TypeError(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

export function createMediaProviders({ files, responses, auth, stateDir, env = process.env, fetchImpl = fetch } = {}) {
  const workDirectory = join(resolve(stateDir || '.local-state'), 'media-work');
  const ffmpegPath = env.FFMPEG_PATH || null;
  const whisper = new WhisperCppProvider({ executable:env.WHISPER_CPP_PATH, modelPath:env.WHISPER_MODEL_PATH, ffmpegPath, workDirectory, timeoutMs:envInteger(env,'WHISPER_TIMEOUT_MS',600_000,10_000,3_600_000) });
  const piper = new PiperProvider({ executable:env.PIPER_PATH, modelPath:env.PIPER_MODEL_PATH, voiceId:env.PIPER_VOICE_ID, workDirectory, timeoutMs:envInteger(env,'PIPER_TIMEOUT_MS',180_000,10_000,600_000) });
  const comfy = new ComfyUIProvider({
    baseUrl:env.COMFYUI_BASE_URL,
    workflows:{ image_generate:env.COMFYUI_IMAGE_GENERATE_WORKFLOW, image_edit:env.COMFYUI_IMAGE_EDIT_WORKFLOW, video_generate:env.COMFYUI_VIDEO_GENERATE_WORKFLOW },
    files, fetchImpl,
    pollIntervalMs:envInteger(env,'COMFYUI_POLL_INTERVAL_MS',1500,250,10_000),
    maxJobMs:envInteger(env,'COMFYUI_MAX_JOB_MS',20 * 60_000,30_000,2 * 60 * 60_000),
  });
  const videoAnalysis = new VideoAnalysisProvider({ ffmpegPath, whisperProvider:whisper, responsesClient:responses, workDirectory, maxDurationSeconds:envInteger(env,'VIDEO_ANALYSIS_MAX_SECONDS',180,1,3600) });

  return {
    comfy, whisper, piper, videoAnalysis,
    async refreshCapabilities(registry) {
      const authenticated = Boolean(auth.status().authenticated);
      const imageVisionReady = authenticated;
      registry.setRuntimeState('images.analyze', { configured:true, ready:imageVisionReady, provider:'siwc-responses', reason:imageVisionReady ? undefined : 'Sign in to ChatGPT first; the selected account/model must still pass a real image input test.' });
      for (const [capability, operation] of [['images.generate','image_generate'],['images.edit','image_edit'],['video.generate','video_generate']]) {
        const configured = await comfy.configured(operation);
        const health = configured ? await comfy.health() : { ready:false, reason:'Configure COMFYUI_BASE_URL and the corresponding API-format workflow.' };
        registry.setRuntimeState(capability, { configured, ready:configured && health.ready, provider:'comfyui-local', reason:health.reason });
      }
      const ffmpegConfigured = await videoAnalysis.configured();
      registry.setRuntimeState('video.analyze', { configured:ffmpegConfigured, ready:ffmpegConfigured && authenticated, provider:'ffmpeg-keyframes+siwc+whisper.cpp', reason:!ffmpegConfigured ? 'Configure FFMPEG_PATH.' : !authenticated ? 'Sign in to ChatGPT; a vision-capable SIWC model must also be selected and successfully tested.' : undefined });
      const whisperConfigured = await whisper.configured();
      registry.setRuntimeState('audio.transcribe', { configured:whisperConfigured, ready:whisperConfigured, provider:'whisper.cpp-local', reason:whisperConfigured ? undefined : 'Configure WHISPER_CPP_PATH, WHISPER_MODEL_PATH, and FFMPEG_PATH.' });
      const piperConfigured = await piper.configured();
      registry.setRuntimeState('audio.synthesize', { configured:piperConfigured, ready:piperConfigured, provider:'piper-local', reason:piperConfigured ? undefined : 'Configure PIPER_PATH and a licensed PIPER_MODEL_PATH.' });
    },
  };
}
