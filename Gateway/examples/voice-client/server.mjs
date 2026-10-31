import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEdgeTtsRunner } from './edge-tts-runner.mjs';
import { sanitizeTextForSpeech } from './edge-tts-adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, 'voice.html');
const providersPath = resolve(here, 'providers.js');
const appPath = resolve(here, 'app.js');
const edgeAdapterPath = resolve(here, 'edge-tts-adapter.js');
const ttsRoutingPath = resolve(here, 'tts-routing.js');
const MAX_BODY = 1024 * 1024;
const MAX_TTS_BODY = 32 * 1024;
const THALITA_VOICE = 'pt-BR-ThalitaMultilingualNeural';

export function createVoiceClientServer({ gatewayApiKey, gatewayUrl = 'http://127.0.0.1:1455', port = 1456, fetchImpl = fetch, edgeTtsRunner = createEdgeTtsRunner() } = {}) {
  if (typeof gatewayApiKey !== 'string' || Buffer.byteLength(gatewayApiKey) < 32) throw new Error('GATEWAY_API_KEY is required in the local environment/.env; it is never sent to the browser.');
  const upstreamBase = new URL(gatewayUrl);
  if (upstreamBase.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(upstreamBase.hostname)) throw new Error('KIRANA_GATEWAY_URL must target a loopback HTTP Gateway.');
  let boundPort = port;
  const activeTtsWorkers = new Set();
  let voiceCatalogCache = null;
  let voiceCatalogExpiresAt = 0;
  let voiceCatalogPromise = null;
  async function currentEdgeVoiceCatalog() {
    if (voiceCatalogCache && Date.now() < voiceCatalogExpiresAt) {
      if (voiceCatalogCache.error) throw voiceCatalogCache.error;
      return voiceCatalogCache.voices;
    }
    if (voiceCatalogPromise) return voiceCatalogPromise;
    voiceCatalogPromise = edgeTtsRunner.listVoices().then((voices) => {
      voiceCatalogCache = { voices };
      voiceCatalogExpiresAt = Date.now() + 5 * 60_000;
      return voices;
    }).catch((error) => {
      voiceCatalogCache = { error };
      voiceCatalogExpiresAt = Date.now() + 30_000;
      throw error;
    }).finally(() => { voiceCatalogPromise = null; });
    return voiceCatalogPromise;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    try {
      if (!validHost(req.headers.host, boundPort)) return json(res, 400, { error: 'Invalid Host header.' });
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${boundPort}`) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      const path = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`).pathname;
      if (req.method === 'GET' && path === '/') {
        const html = await readFile(htmlPath);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
        return res.end(html);
      }
      if (req.method === 'GET' && path === '/app.js') {
        const source = await readFile(appPath);
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(source);
      }
      if (req.method === 'GET' && path === '/edge-tts-adapter.js') {
        const source = await readFile(edgeAdapterPath);
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(source);
      }
      if (req.method === 'GET' && path === '/tts-routing.js') {
        const source = await readFile(ttsRoutingPath);
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(source);
      }
      if (req.method === 'GET' && path === '/providers.js') {
        const source = await readFile(providersPath);
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'" });
        return res.end(source);
      }
      if (req.method === 'GET' && path === '/api/health') {
        const upstream = await fetchImpl(new URL('/health', upstreamBase), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
        return relay(upstream, res);
      }
      if (req.method === 'GET' && path === '/api/session') {
        const upstream = await fetchImpl(new URL('/auth/status', upstreamBase), { headers: { authorization: `Bearer ${gatewayApiKey}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
        return relay(upstream, res);
      }
      if (req.method === 'GET' && path === '/api/models') {
        const upstream = await fetchImpl(new URL('/v1/models', upstreamBase), { headers: { authorization: `Bearer ${gatewayApiKey}`, accept: 'application/json' }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
        return relay(upstream, res);
      }
      if (req.method === 'GET' && path === '/api/tts/voices') {
        try {
          const voices = await currentEdgeVoiceCatalog();
          return json(res, 200, { available: voices.some((voice) => voice.shortName === THALITA_VOICE), requiredVoice: THALITA_VOICE, voices });
        } catch {
          return json(res, 503, { available: false, requiredVoice: THALITA_VOICE, error: 'O catálogo Edge TTS não respondeu. Verifique Python/edge-tts e a conexão online.' });
        }
      }
      if (req.method === 'POST' && path === '/api/tts/stream') {
        const body = await readLimited(req, MAX_TTS_BODY);
        let parsed;
        try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'Invalid JSON.' }); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some((key) => !['text','voice'].includes(key)) || parsed.voice !== THALITA_VOICE || typeof parsed.text !== 'string') return json(res, 400, { error: 'Only the configured Thalita Neural voice and text are accepted.' });
        const speechText = sanitizeTextForSpeech(parsed.text);
        if (!speechText || speechText.length > 5000) return json(res, 400, { error: 'Texto de fala vazio ou acima do limite local.' });
        return streamTts(edgeTtsRunner, speechText, req, res, activeTtsWorkers);
      }
      if (req.method === 'POST' && path === '/api/chat/completions') {
        const body = await readLimited(req, MAX_BODY);
        let parsed;
        try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'Invalid JSON.' }); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.stream !== true || typeof parsed.model !== 'string' || !Array.isArray(parsed.messages) || Object.keys(parsed).some((key) => !['model','messages','stream','stream_options'].includes(key))) return json(res, 400, { error: 'Only validated streaming text chat requests are accepted.' });
        const upstream = await fetchImpl(new URL('/v1/chat/completions', upstreamBase), { method: 'POST', headers: { authorization: `Bearer ${gatewayApiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body, signal: AbortSignal.timeout(180_000), redirect: 'error' });
        return relay(upstream, res);
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      if (error?.code === 'body_too_large') return json(res, 413, { error: 'Request body exceeds the local voice-client limit.' });
      const message = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'Gateway request timed out.' : 'Could not reach the local Gateway. Confirm it is running and reconnect.';
      json(res, 502, { error: message });
    }
  });
  return { server, listen() { return new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); boundPort = server.address().port; resolveListen(server.address()); }); }); }, close() { for (const worker of activeTtsWorkers) worker.kill(); return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); } };
}

function streamTts(runner, text, req, res, activeWorkers) {
  let child;
  try { child = runner.startStream(text, THALITA_VOICE); }
  catch { return json(res, 503, { error: 'Não foi possível iniciar o worker Edge TTS.' }); }
  activeWorkers.add(child);
  let headersSent = false;
  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    activeWorkers.delete(child);
    child.kill();
    if (!headersSent) json(res, 504, { error: 'Thalita TTS não entregou áudio dentro do prazo.' });
    else if (!res.destroyed && !res.writableEnded) res.destroy();
    settled = true;
  }, 45_000);
  const onClose = () => { if (!res.writableEnded && !settled) child.kill(); };
  const onAbort = () => { if (!settled) child.kill(); };
  const onSocketClose = () => { if (!res.writableEnded && !settled) child.kill(); };
  res.once('close', onClose);
  req.once('aborted', onAbort);
  req.socket.once('close', onSocketClose);
  if (req.aborted) onAbort();
  child.stdout.on('data', (chunk) => {
    if (settled || res.destroyed) return;
    if (!headersSent) {
      headersSent = true;
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-disposition': 'inline', 'cache-control': 'no-store', 'x-tts-voice': THALITA_VOICE, 'x-accel-buffering': 'no' });
    }
    if (!res.write(chunk)) {
      child.stdout.pause();
      res.once('drain', () => child.stdout.resume());
    }
  });
  child.once('error', () => {
    if (settled) return;
    settled = true;
    activeWorkers.delete(child);
    clearTimeout(timeout);
    req.off('aborted', onAbort);
    req.socket.off('close', onSocketClose);
    if (!headersSent && !res.destroyed) json(res, 503, { error: 'Python/edge-tts não iniciou. Confira a instalação local do adaptador.' });
    else if (!res.destroyed && !res.writableEnded) res.destroy();
  });
  child.once('close', (code) => {
    if (settled) return;
    settled = true;
    activeWorkers.delete(child);
    clearTimeout(timeout);
    res.off('close', onClose);
    req.off('aborted', onAbort);
    req.socket.off('close', onSocketClose);
    if (!headersSent) { if (!res.destroyed) json(res, 503, { error: code === 0 ? 'Thalita não retornou áudio.' : 'O serviço Thalita está indisponível; usando fallback do navegador.' }); return; }
    if (code === 0 && !res.destroyed && !res.writableEnded) res.end();
    else if (!res.destroyed && !res.writableEnded) res.destroy();
  });
  child.stderr?.resume?.();
  return undefined;
}

async function relay(upstream, res) {
  const headers = { 'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8' };
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return res.end();
  try {
    for await (const chunk of upstream.body) {
      if (res.destroyed) break;
      if (!res.write(chunk)) await new Promise((resolveWrite) => res.once('drain', resolveWrite));
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  } catch { if (!res.writableEnded && !res.destroyed) res.destroy(); }
}
async function readLimited(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Request too large.'), { code: 'body_too_large' }); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
function validHost(value, port) { return value === `127.0.0.1:${port}`; }
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envPath = resolve(process.cwd(), '.env');
  const envText = await readFile(envPath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const fileEnv = Object.fromEntries(envText.split(/\r?\n/).flatMap((line) => { const match=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/); if (!match) return []; let value=match[2]; if ((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'"))) value=value.slice(1,-1); return [[match[1],value]]; }));
  const gatewayApiKey = process.env.GATEWAY_API_KEY || fileEnv.GATEWAY_API_KEY;
  const client = createVoiceClientServer({ gatewayApiKey, gatewayUrl:process.env.KIRANA_GATEWAY_URL || 'http://127.0.0.1:1455', port:Number(process.env.VOICE_CLIENT_PORT || 1456) });
  const address = await client.listen();
  console.log(`Voice client listening at http://127.0.0.1:${address.port}; gateway credentials remain server-side.`);
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { await client.close(); process.exit(0); });
}
