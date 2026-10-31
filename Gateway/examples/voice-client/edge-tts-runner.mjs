import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, 'edge_tts_worker.py');
const THALITA_VOICE = 'pt-BR-ThalitaMultilingualNeural';

export function createEdgeTtsRunner({ spawnImpl = spawn, pythonCommand = process.env.KIRANA_EDGE_TTS_PYTHON || (process.platform === 'win32' ? 'py' : 'python3'), platform = process.platform } = {}) {
  const pyLauncherArgs = platform === 'win32' && pythonCommand === 'py' ? ['-3'] : [];
  function runWorker(args, options = {}) {
    return spawnImpl(pythonCommand, [...pyLauncherArgs, workerPath, ...args], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    });
  }
  return {
    async listVoices({ timeoutMs = 25_000 } = {}) {
      const child = runWorker(['--list-voices']);
      return new Promise((resolveVoices, rejectVoices) => {
        const stdout = [];
        let size = 0;
        let settled = false;
        const timeout = setTimeout(() => { child.kill(); finish(new Error('edge_tts_timeout')); }, timeoutMs);
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          error ? rejectVoices(error) : resolveVoices(value);
        };
        child.stdout.on('data', chunk => {
          size += chunk.length;
          if (size > 1024 * 1024) { child.kill(); finish(new Error('edge_tts_catalog_too_large')); return; }
          stdout.push(chunk);
        });
        child.on('error', () => finish(new Error('edge_tts_python_unavailable')));
        child.on('close', code => {
          if (code !== 0) return finish(new Error('edge_tts_voice_catalog_failed'));
          try {
            const voices = JSON.parse(Buffer.concat(stdout).toString('utf8'));
            if (!Array.isArray(voices)) throw new Error('invalid_catalog');
            finish(null, voices);
          } catch { finish(new Error('edge_tts_invalid_voice_catalog')); }
        });
        child.stderr?.resume?.();
      });
    },
    startStream(text, voice = THALITA_VOICE) {
      if (voice !== THALITA_VOICE) throw new Error('unsupported_edge_voice');
      const child = runWorker([]);
      child.stdin.end(JSON.stringify({ text }));
      return child;
    },
  };
}
