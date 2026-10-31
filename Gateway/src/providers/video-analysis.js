import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCommand, withWorkDirectory } from './command.js';

const VIDEO_EXT = new Map([['video/mp4','.mp4'],['video/quicktime','.mov'],['video/webm','.webm']]);

export class VideoAnalysisProvider {
  constructor({ ffmpegPath, whisperProvider, responsesClient, workDirectory, maxDurationSeconds = 180 } = {}) {
    this.ffmpegPath = ffmpegPath ? resolve(ffmpegPath) : null;
    this.whisper = whisperProvider;
    this.responses = responsesClient;
    this.workDirectory = resolve(workDirectory || '.local-state/media-work');
    this.maxDurationSeconds = maxDurationSeconds;
  }

  async configured() { if (!this.ffmpegPath) return false; try { await access(this.ffmpegPath, constants.X_OK); return true; } catch { return false; } }

  async analyze({ buffer, mimeType, model, prompt, frameIntervalSeconds = 3, maxFrames = 8 }, { signal, onProgress = () => {} } = {}) {
    if (!await this.configured()) throw Object.assign(new Error('Configure a local FFmpeg executable to enable video analysis.'), { status: 503, code: 'provider_not_configured' });
    const extension = VIDEO_EXT.get(mimeType);
    if (!extension || !Buffer.isBuffer(buffer)) throw Object.assign(new Error('Video MIME type is not supported by this adapter.'), { status: 415, code: 'unsupported_media_type' });
    if (!Number.isInteger(frameIntervalSeconds) || frameIntervalSeconds < 1 || frameIntervalSeconds > 30 || !Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 12) throw Object.assign(new Error('frame_interval_seconds must be 1–30 and max_frames 1–12.'), { status: 400, code: 'invalid_video_options' });
    await mkdir(this.workDirectory, { recursive: true });
    return withWorkDirectory(this.workDirectory, async (directory) => {
      const source = join(directory, `input${extension}`); const framesDir = join(directory, 'frames');
      await mkdir(framesDir, { recursive: true }); await writeFile(source, buffer, { mode: 0o600 });
      onProgress(10, 'extracting_keyframes');
      await runCommand(this.ffmpegPath, ['-nostdin','-hide_banner','-loglevel','error','-y','-t',String(this.maxDurationSeconds),'-i',source,'-vf',`fps=1/${frameIntervalSeconds},scale=640:-2`,'-frames:v',String(maxFrames),'-q:v','8',join(framesDir,'frame-%03d.jpg')], { signal, timeoutMs: 120_000, maxStderrBytes: 64 * 1024 });
      const names = (await readdir(framesDir)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort().slice(0,maxFrames);
      if (!names.length) throw Object.assign(new Error('FFmpeg extracted no video frames.'), { code: 'video_no_frames' });
      const images = [];
      for (const name of names) {
        const image = await readFile(join(framesDir,name));
        if (image.length < 3 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) throw Object.assign(new Error('FFmpeg frame output is not a JPEG image.'), { code: 'video_invalid_frame' });
        images.push({ mimeType: 'image/jpeg', buffer: image, timestamp_seconds: Math.max(0, Number(name.match(/\d+/)[0]) - 1) * frameIntervalSeconds });
      }
      const totalImageBytes = images.reduce((sum, image) => sum + image.buffer.length, 0);
      if (totalImageBytes > 10 * 1024 * 1024) throw Object.assign(new Error('Extracted frames exceed the 10 MiB vision input budget; reduce max_frames or resolution.'), { code: 'video_frames_too_large' });
      onProgress(35, 'analyzing_keyframes');
      const imageResult = await this.responses.analyzeImages({ model, prompt: `${prompt}\n\nTreat the attached still images as ordered frames sampled from one video. Describe only visible evidence and state that unsampled intervals are unknown.`, images }, signal);
      let transcript = null; let audioStatus = 'not_transcribed';
      if (this.whisper && await this.whisper.configured()) {
        const wav = join(directory,'audio.wav');
        try {
          onProgress(65, 'extracting_audio');
          await runCommand(this.ffmpegPath, ['-nostdin','-hide_banner','-loglevel','error','-y','-t',String(this.maxDurationSeconds),'-i',source,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wav], { signal, timeoutMs: 120_000, maxStderrBytes: 32 * 1024 });
          const audioBuffer = await readFile(wav);
          onProgress(75, 'transcribing_audio');
          const transcription = await this.whisper.transcribe({ buffer: audioBuffer, mimeType: 'audio/wav', language: 'pt' }, { signal });
          transcript = transcription.text; audioStatus = 'transcribed';
        } catch (error) {
          if (signal?.aborted) throw error;
          audioStatus = error.code === 'provider_process_failed' ? 'no_audio_track_or_unreadable' : 'transcription_failed';
        }
      } else audioStatus = 'whisper_not_configured';
      onProgress(95, 'building_video_report');
      return {
        result: {
          summary: imageResult.text,
          transcription: transcript,
          audio_status: audioStatus,
          frame_sampling: { method: 'ffmpeg_fixed_interval', frame_interval_seconds: frameIntervalSeconds, frames_analyzed: images.length, sampled_timestamps_seconds: images.map((image) => image.timestamp_seconds), limits: 'Keyframes only; no native temporal video reasoning. Audio is transcribed separately only when Whisper.cpp is configured.' },
          provider: { video: 'ffmpeg-keyframes', vision: 'siwc-responses', audio: audioStatus === 'transcribed' ? 'whisper.cpp' : null },
        },
        live: imageResult.live === true,
      };
    });
  }
}
