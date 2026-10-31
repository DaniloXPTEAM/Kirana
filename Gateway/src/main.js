import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from './gateway.js';

await loadEnv(resolve(process.cwd(), '.env'));
const apiKey = process.env.GATEWAY_API_KEY;
if (!apiKey) {
  console.error('GATEWAY_API_KEY is missing. Run npm run keygen and put its output in .env (chmod 600 .env).');
  process.exit(1);
}
const port = Number(process.env.PORT || 1455);
const appName = process.env.APP_NAME || 'Kirana Personal Gateway';
const appId = process.env.APP_ID || 'kirana-personal-gateway';
if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(appId)) throw new Error('APP_ID must be a stable lowercase slug.');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535.');
const fileMaxBytes = Number(process.env.FILE_MAX_BYTES || 10 * 1024 * 1024);
const fileTtlSeconds = Number(process.env.FILE_TTL_SECONDS || 3600);
const fileMaxTotalBytes = Number(process.env.FILE_MAX_TOTAL_BYTES || 50 * 1024 * 1024);
const fileMaxCount = Number(process.env.FILE_MAX_COUNT || 50);
if (!Number.isInteger(fileMaxBytes) || fileMaxBytes < 1024 || fileMaxBytes > 250 * 1024 * 1024) throw new Error('FILE_MAX_BYTES must be an integer from 1024 to 262144000.');
if (!Number.isInteger(fileTtlSeconds) || fileTtlSeconds < 60 || fileTtlSeconds > 86400) throw new Error('FILE_TTL_SECONDS must be an integer from 60 to 86400.');
if (!Number.isInteger(fileMaxTotalBytes) || fileMaxTotalBytes < fileMaxBytes || fileMaxTotalBytes > 2 * 1024 * 1024 * 1024) throw new Error('FILE_MAX_TOTAL_BYTES must be at least FILE_MAX_BYTES and no more than 2147483648.');
if (!Number.isInteger(fileMaxCount) || fileMaxCount < 1 || fileMaxCount > 500) throw new Error('FILE_MAX_COUNT must be an integer from 1 to 500.');
const providerEnvironment = {
  'images.analyze': 'KIRANA_IMAGE_ANALYSIS_PROVIDER',
  'images.generate': 'KIRANA_IMAGE_GENERATION_PROVIDER',
  'images.edit': 'KIRANA_IMAGE_EDIT_PROVIDER',
  'video.analyze': 'KIRANA_VIDEO_ANALYSIS_PROVIDER',
  'video.generate': 'KIRANA_VIDEO_GENERATION_PROVIDER',
  'audio.transcribe': 'KIRANA_SPEECH_TO_TEXT_PROVIDER',
  'audio.synthesize': 'KIRANA_TEXT_TO_SPEECH_PROVIDER',
};
const providerPreferences = Object.fromEntries(Object.entries(providerEnvironment).flatMap(([capability, variable]) => {
  const value = process.env[variable]?.trim();
  if (!value) return [];
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value)) throw new Error(`${variable} must be a provider identifier (letters, numbers, dot, underscore, hyphen).`);
  return [[capability, value]];
}));
/* ---------------------------- motor (engine) ------------------------------ */
/**
 * Configuração da camada de motor. TUDO é opt-in: sem estas variáveis o Gateway
 * se comporta exatamente como o v0.4.0 (sem roteamento, sem fallback).
 *
 *   KIRANA_ROUTING=on               liga a decisão por capacidade
 *   KIRANA_PRIMARY_MODEL=<slug>     modelo preservado para texto/raciocínio
 *   KIRANA_FALLBACK_MODEL=<slug>    UMA alternativa, usada só em falha de infra
 *   KIRANA_COST_POLICY=plan-only    (padrão) bloqueia qualquer modelo de custo pago
 *   KIRANA_ENGINE_TIMEOUT_MS=180000 timeout por tentativa
 *   KIRANA_ENGINE_ATTEMPTS=1        tentativas por modelo (nunca repete em loop)
 *   KIRANA_BREAKER_FAILURES=3       falhas até abrir o circuito do modelo
 *   KIRANA_BREAKER_RESET_MS=30000   tempo até a sondagem em meio-aberto
 *   KIRANA_MODEL_CATALOG=config/models.json
 */
const routing = /^(1|on|true|yes)$/i.test(process.env.KIRANA_ROUTING || '');
const primaryModel = (process.env.KIRANA_PRIMARY_MODEL || '').trim() || null;
const fallbackModel = (process.env.KIRANA_FALLBACK_MODEL || '').trim() || null;
const costPolicy = (process.env.KIRANA_COST_POLICY || 'plan-only').trim();
if (!['plan-only', 'allow-paid'].includes(costPolicy)) throw new Error('KIRANA_COST_POLICY must be plan-only or allow-paid.');
if (routing && !primaryModel) throw new Error('KIRANA_ROUTING=on requires KIRANA_PRIMARY_MODEL (the model to preserve). Get a slug from GET /v1/models.');
if (routing && fallbackModel && fallbackModel === primaryModel) throw new Error('KIRANA_FALLBACK_MODEL must differ from KIRANA_PRIMARY_MODEL.');
const catalogPath = resolve(process.env.KIRANA_MODEL_CATALOG || 'config/models.json');
let declaredModels = [];
try {
  const parsed = JSON.parse(await readFile(catalogPath, 'utf8'));
  declaredModels = Array.isArray(parsed.models) ? parsed.models : [];
  for (const [index, entry] of declaredModels.entries()) {
    if (!entry || typeof entry.model !== 'string' || !entry.model.trim()) throw new Error(`models[${index}].model is required.`);
    if (entry.cost && !['plan', 'free', 'paid'].includes(entry.cost)) throw new Error(`models[${index}].cost must be plan, free or paid.`);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error(`Could not read the model catalog ${catalogPath}: ${error.message}`);
}
/**
 * Mapa de capacidades especializadas: `cap=modelo,cap2=modelo2`.
 * Nada aqui é usado sem estar `tested` no catálogo — a lista apenas indica o
 * candidato; quem autoriza é a evidência de teste.
 */
const specialized = {};
for (const item of (process.env.KIRANA_SPECIALIZED || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const [capability, model] = item.split('=').map((s) => s.trim());
  if (!capability || !model) throw new Error(`KIRANA_SPECIALIZED entry "${item}" must look like capability=model.`);
  (specialized[capability] ||= []).push(model);
}
for (const model of Object.values(specialized).flat()) {
  if (!declaredModels.some((entry) => entry.model === model) && routing) {
    console.warn(`Aviso: ${model} foi indicado em KIRANA_SPECIALIZED mas não está em config/models.json; sem teste registrado ele não será usado.`);
  }
}

const engineOptions = {
  routing,
  specialized,
  primaryModel,
  fallbackModel,
  costPolicy,
  timeoutMs: Number(process.env.KIRANA_ENGINE_TIMEOUT_MS || 0) || undefined,
  attemptsPerModel: Number(process.env.KIRANA_ENGINE_ATTEMPTS || 1),
  breaker: {
    failureThreshold: Number(process.env.KIRANA_BREAKER_FAILURES || 3),
    resetMs: Number(process.env.KIRANA_BREAKER_RESET_MS || 30_000),
  },
  models: declaredModels,
};

const app = createGateway({ apiKey, appName, stateDir: resolve('.local-state', appId), port, host: process.env.HOST || '127.0.0.1', providerPreferences, fileOptions: { maxFileBytes: fileMaxBytes, maxTotalBytes: fileMaxTotalBytes, maxFiles: fileMaxCount, ttlSeconds: fileTtlSeconds }, engineOptions });
const address = await app.listen();
console.log(`Kirana Personal Gateway v0.4.1 listening at http://127.0.0.1:${address.port}`);
console.log('Private localhost only. Start the explicit ChatGPT consent flow at http://127.0.0.1:' + address.port + '/auth/start');
console.log('Gateway API key authenticates only to this local gateway; it is not an OpenAI or ChatGPT credential.');
console.log('OAuth tokens are memory-only and are cleared when this process exits. No credentials are logged.');
console.log(`Motor: roteamento ${routing ? `LIGADO (primário: ${primaryModel}${fallbackModel ? `, fallback: ${fallbackModel}` : ', sem fallback'})` : 'DESLIGADO (comportamento v0.4.0)'} · política de custo: ${costPolicy} · catálogo: ${declaredModels.length} modelo(s) declarado(s)`);
console.log(`Especializadas aprovadas por capacidade: ${Object.keys(specialized).length ? Object.entries(specialized).map(([c, m]) => `${c}=${m.join('|')}`).join(', ') : 'nenhuma'}`);
console.log('Identidade real do motor: GET /v1/engine · histórico de execução: GET /v1/runs');

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  console.log(`Received ${signal}; clearing in-memory credentials and stopping.`);
  try { await app.close(); } finally { process.exit(0); }
});

async function loadEnv(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
