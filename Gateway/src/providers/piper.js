import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { runCommand, withWorkDirectory } from './command.js';

export class PiperProvider {
  constructor({ executable, modelPath, voiceId, workDirectory, timeoutMs = 180_000 } = {}) {
    this.executable = executable ? resolve(executable) : null;
    this.modelPath = modelPath ? resolve(modelPath) : null;
    this.voiceId = voiceId || (this.modelPath ? basename(this.modelPath).replace(/\\.onnx$/i,'') : null);
    this.workDirectory = resolve(workDirectory || '.local-state/media-work');
    this.timeoutMs = timeoutMs;
  }

  async configured() {
    if (!this.executable || !this.modelPath) return false;
    try { await Promise.all([access(this.executable, constants.X_OK), access(this.modelPath, constants.R_OK), access(`${this.modelPath}.json`, constants.R_OK)]); return true; }
    catch { return false; }
  }

  async synthesize({ text, voice = 'pt-BR-cadu-medium', language = 'pt-BR' }, { signal } = {}) {
    if (!await this.configured()) throw Object.assign(new Error('Configure the Piper executable and a licensed voice model to enable local speech synthesis.'), { status: 503, code: 'provider_not_configured' });
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw Object.assign(new Error('TTS input must contain 1–100000 characters.'), { status: 400, code: 'invalid_speech_request' });
    const configuredVoice = this.voiceId;
    if (voice && configuredVoice && voice.replace(/-/g,'_') !== configuredVoice.replace(/-/g,'_')) throw Object.assign(new Error('Requested voice does not match the configured local Piper model.'), { status: 400, code: 'voice_not_configured' });
    await mkdir(this.workDirectory, { recursive: true });
    return withWorkDirectory(this.workDirectory, async (directory) => {
      const output = join(directory, 'speech.wav');
      await runCommand(this.executable, ['--model',this.modelPath,'--output_file',output], { input: text, signal, timeoutMs: this.timeoutMs, maxStdoutBytes: 64 * 1024, maxStderrBytes: 128 * 1024 });
      const buffer = await readFile(output).catch(() => null);
      if (!buffer || buffer.length < 44 || buffer.toString('ascii',0,4) !== 'RIFF' || buffer.toString('ascii',8,12) !== 'WAVE') throw Object.assign(new Error('Piper did not produce a valid WAV file.'), { code: 'provider_invalid_output' });
      const actualVoice = configuredVoice;
      const actualLanguage = actualVoice?.toLowerCase().startsWith('pt_br_') ? 'pt-BR' : 'unknown';
      return { buffer, mimeType: 'audio/wav', extension: '.wav', voice:actualVoice, language:actualLanguage, provider: 'piper', live: true };
    });
  }
}
