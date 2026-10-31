import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCommand, withWorkDirectory } from './command.js';

const AUDIO_EXT = new Map([
  ['audio/mpeg','.mp3'], ['audio/wav','.wav'], ['audio/ogg','.ogg'], ['audio/mp4','.m4a'], ['audio/webm','.webm'],
  ['video/mp4','.mp4'], ['video/quicktime','.mov'], ['video/webm','.webm'],
]);

export class WhisperCppProvider {
  constructor({ executable, modelPath, ffmpegPath, workDirectory, timeoutMs = 600_000 } = {}) {
    this.executable = executable ? resolve(executable) : null;
    this.modelPath = modelPath ? resolve(modelPath) : null;
    this.ffmpegPath = ffmpegPath ? resolve(ffmpegPath) : null;
    this.workDirectory = resolve(workDirectory || '.local-state/media-work');
    this.timeoutMs = timeoutMs;
  }

  async configured() {
    if (!this.executable || !this.modelPath || !this.ffmpegPath) return false;
    try { await Promise.all([access(this.executable, constants.X_OK), access(this.modelPath, constants.R_OK), access(this.ffmpegPath, constants.X_OK)]); return true; }
    catch { return false; }
  }

  async transcribe({ buffer, mimeType, language = 'pt' }, { signal, onProgress = () => {} } = {}) {
    if (!await this.configured()) throw Object.assign(new Error('Configure Whisper.cpp, a multilingual model, and FFmpeg to enable local transcription.'), { status: 503, code: 'provider_not_configured' });
    const extension = AUDIO_EXT.get(mimeType);
    if (!extension || !Buffer.isBuffer(buffer)) throw Object.assign(new Error('Audio input MIME type is not supported by the local transcription adapter.'), { status: 415, code: 'unsupported_media_type' });
    if (!/^(pt|pt-BR|auto|[a-z]{2,3})$/i.test(language)) throw Object.assign(new Error('language must be auto or a supported language code such as pt.'), { status: 400, code: 'invalid_language' });
    await mkdir(this.workDirectory, { recursive: true });
    return withWorkDirectory(this.workDirectory, async (directory) => {
      const source = join(directory, `input${extension}`); const wav = join(directory, 'normalized.wav'); const outputPrefix = join(directory, 'transcript');
      await writeFile(source, buffer, { mode: 0o600 });
      onProgress(10, 'normalizing_audio');
      await runCommand(this.ffmpegPath, ['-nostdin','-hide_banner','-loglevel','error','-y','-i',source,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wav], { signal, timeoutMs: 120_000, maxStderrBytes: 64 * 1024 });
      onProgress(35, 'transcribing');
      const languageArg = language.toLowerCase() === 'auto' ? 'auto' : language.toLowerCase().startsWith('pt') ? 'pt' : language.toLowerCase();
      await runCommand(this.executable, ['-m',this.modelPath,'-f',wav,'-l',languageArg,'-oj','-of',outputPrefix,'-nt'], { signal, timeoutMs: this.timeoutMs, maxStdoutBytes: 256 * 1024, maxStderrBytes: 128 * 1024 });
      const raw = await readFile(`${outputPrefix}.json`, 'utf8').catch(() => null);
      if (!raw) throw Object.assign(new Error('Whisper.cpp completed without producing its JSON transcript.'), { code: 'provider_invalid_output' });
      let result;
      try { result = JSON.parse(raw); } catch { throw Object.assign(new Error('Whisper.cpp returned invalid JSON.'), { code: 'provider_invalid_output' }); }
      const segments = Array.isArray(result.transcription) ? result.transcription.map((segment) => ({ text: String(segment.text || '').trim(), start_ms: Number(segment.offsets?.from) || 0, end_ms: Number(segment.offsets?.to) || 0 })).filter((segment) => segment.text) : [];
      const text = segments.map((segment) => segment.text).join(' ').trim();
      if (!text) throw Object.assign(new Error('Whisper.cpp returned no transcript text.'), { code: 'empty_transcript' });
      onProgress(100, 'completed');
      return { text, language: result.result?.language || languageArg, segments, provider: 'whisper.cpp', live: true };
    });
  }
}
