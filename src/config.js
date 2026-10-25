/**
 * Configuração centralizada da Kirana.
 *
 * Regras:
 * - Nenhum segredo é exportado para o frontend (ver publicApiConfig()).
 * - O arquivo .env é lido manualmente (sem dependências externas).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Carrega .env sem sobrescrever variáveis já definidas no ambiente. */
export function loadEnvFile(envPath = path.join(PROJECT_ROOT, '.env'), env = process.env) {
  try {
    if (!fs.existsSync(envPath)) return false;
    const parsed = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) env[key] = value;
    }
    return true;
  } catch {
    return false;
  }
}

const toBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(value).trim().toLowerCase());
};

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toFloat = (value, fallback) => {
  const parsed = Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function loadConfig(env = process.env) {
  const resolveDir = (value, fallback) => {
    const raw = value && value.trim() ? value.trim() : fallback;
    return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
  };

  const gatewayApiKey = env.KIRANA_GATEWAY_API_KEY || env.GATEWAY_API_KEY || '';

  const config = {
    appName: 'Kirana',
    version: '0.4.1',
    env: env.KIRANA_ENV || 'local',
    host: env.KIRANA_HOST || '127.0.0.1',
    port: toInt(env.KIRANA_PORT, 3000),
    accessToken: (env.KIRANA_ACCESS_TOKEN || '').trim(),
    publicDir: path.join(PROJECT_ROOT, 'public'),
    dataDir: resolveDir(env.KIRANA_DATA_DIR, 'data'),
    rateLimit: {
      max: toInt(env.KIRANA_RATE_LIMIT_MAX, 20),
      windowMs: toInt(env.KIRANA_RATE_LIMIT_WINDOW_MS, 60_000),
    },
    maxBodyBytes: toInt(env.KIRANA_MAX_BODY_BYTES, 32 * 1024),
    // Apenas para prévias em sandbox/iframe de outra origem. Não usar em produção.
    allowEmbed: toBool(env.KIRANA_ALLOW_EMBED, false),
    gateway: {
      url: (env.KIRANA_GATEWAY_URL || 'http://127.0.0.1:1455').replace(/\/+$/, ''),
      apiKey: gatewayApiKey,
      requestTimeoutMs: toInt(env.KIRANA_REQUEST_TIMEOUT_MS, 120_000),
      firstTokenTimeoutMs: toInt(env.KIRANA_FIRST_TOKEN_TIMEOUT_MS, 20_000),
    },
    /**
     * Campos opcionais do payload. O Gateway v0.2.0 responde HTTP 400
     * `unsupported_parameter` para campos fora do contrato dele (temperature foi
     * o caso real observado em 24/10/2026), por isso o padrão é NÃO enviar.
     */
    payload: {
      sendTemperature: toBool(env.KIRANA_SEND_TEMPERATURE, false),
      sendMaxTokens: toBool(env.KIRANA_SEND_MAX_TOKENS, false),
      sendToolChoice: toBool(env.KIRANA_SEND_TOOL_CHOICE, false),
    },
    models: {
      primary: env.KIRANA_PRIMARY_MODEL || 'gpt-6-luna',
      fallback: env.KIRANA_FALLBACK_MODEL || 'gpt-6.1-sol',
      allowFallback: toBool(env.KIRANA_ALLOW_FALLBACK, true),
      probe: toBool(env.KIRANA_MODEL_PROBE, true),
    },
    agent: {
      /** 'langgraph' (padrão) ou 'legacy' (loop da Fase 1, mantido para rollback). */
      orchestrator: (env.KIRANA_ORCHESTRATOR || 'langgraph').toLowerCase() === 'legacy' ? 'legacy' : 'langgraph',
      maxToolRounds: toInt(env.KIRANA_MAX_TOOL_ROUNDS, 4),
      historyLimit: toInt(env.KIRANA_HISTORY_LIMIT, 24),
      toolResultMaxChars: toInt(env.KIRANA_TOOL_RESULT_MAX_CHARS, 4000),
      temperature: toFloat(env.KIRANA_TEMPERATURE, 0.6),
      maxTokens: toInt(env.KIRANA_MAX_TOKENS, 0),
      confirmationTtlMs: 15 * 60 * 1000,
      memoryMaxItems: 40,
      memoryMaxChars: 2000,
    },
    logLevel: (env.KIRANA_LOG_LEVEL || 'info').toLowerCase(),
  };

  return config;
}

/** Configuração segura para o navegador: sem chaves, sem caminhos, sem tokens. */
export function publicApiConfig(config, extras = {}) {
  return {
    appName: config.appName,
    version: config.version,
    requiresAccessToken: Boolean(config.accessToken),
    models: {
      primary: config.models.primary,
      fallback: config.models.fallback,
      active: extras.activeModel || config.models.primary,
      allowFallback: config.models.allowFallback,
    },
    features: {
      streaming: true,
      tools: true,
      memory: true,
      confirmations: true,
    },
    limits: config.rateLimit,
    timeouts: { firstTokenMs: config.gateway.firstTokenTimeoutMs },
  };
}
