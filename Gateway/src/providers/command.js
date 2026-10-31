import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

export function runCommand(executable, args, { input, cwd, timeoutMs = 300_000, signal, maxStdoutBytes = 1024 * 1024, maxStderrBytes = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' }));
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = []; const stderr = []; let stdoutBytes = 0; let stderrBytes = 0; let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); error ? reject(error) : resolve(result); };
    const onAbort = () => { child.kill(); finish(Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' })); };
    const timer = setTimeout(() => { child.kill(); finish(Object.assign(new Error('Local provider exceeded its time limit.'), { code: 'provider_timeout' })); }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => finish(Object.assign(new Error('Configured local executable could not be started.'), { code: 'provider_executable_error' })));
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) { child.kill(); finish(Object.assign(new Error('Local provider output exceeded its limit.'), { code: 'provider_output_too_large' })); return; }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => { if (stderrBytes < maxStderrBytes) { const limited = chunk.subarray(0, maxStderrBytes - stderrBytes); stderr.push(limited); stderrBytes += limited.length; } });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(Object.assign(new Error('Local provider returned a non-zero exit status.'), { code: 'provider_process_failed', exitCode: code }));
      finish(null, { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function withWorkDirectory(parent, callback) {
  const directory = await mkdtemp(join(parent, 'kirana-work-'));
  try { return await callback(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
