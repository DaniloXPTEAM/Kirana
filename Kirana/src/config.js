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

/**
 * Versão da aplicação — fonte única é o `package.json`.
 *
 * Antes era uma string literal aqui ('0.5.0') e ficou defasada em relação ao
 * pacote: o log dizia "Kirana v0.5.0" rodando o build v0.5.3 (agora 0.5.4), o que atrapalha
 * auditoria e suporte. Lido uma vez, no carregamento do módulo; se o arquivo
 * estiver ilegível a Kirana não sobe com uma versão inventada.
 */
function readPackageVersion() {
  const raw = fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8');
  const version = JSON.parse(raw).version;
  if (typeof version !== 'string' || !version.trim()) throw new Error('package.json sem campo "version" válido');
  return version.trim();
}

export const APP_VERSION = readPackageVersion();

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
    version: APP_VERSION,
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
    /**
     * Perfil de execução.
     *
     * `production` liga as travas que não podem existir só na documentação:
     *   - rotas privadas (listar TODAS as sessões, memória, conteúdo de conversa
     *     alheia) passam a exigir autenticação;
     *   - exige `KIRANA_ACCESS_TOKEN` (senão o servidor não sobe);
     *   - exige pelo menos uma origem permitida e limite do transporte > 0.
     * Em `development` (padrão) nada disso muda, e as suítes seguem iguais.
     */
    env: String(env.KIRANA_ENV || 'development').trim().toLowerCase() === 'production' ? 'production' : 'development',
    /**
     * Confia em `X-Forwarded-For`/`X-Forwarded-Proto` do proxy (Caddy/Nginx).
     * SEM isso, todo visitante aparece com o IP do proxy: o limite por IP passa
     * a ser um limite GLOBAL e o primeiro visitante derruba o site inteiro.
     */
    trustProxy: toBool(env.KIRANA_TRUST_PROXY, false),
    /** Origens extras autorizadas a chamar a Kirana (além do `site.json`). */
    allowedOrigins: String(env.KIRANA_ALLOWED_ORIGINS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    /**
     * Limite próprio do transporte do agente no navegador (`/api/copilot` e
     * `/api/agui`).
     *
     * Por que existe: essas rotas são públicas (o visitante do site não tem
     * token) e, até a v0.5.1, passavam SEM limite nenhum — cada requisição
     * dispara turno de modelo e consome plano do Gateway. O padrão é 0 =
     * desligado, para preservar exatamente o comportamento testado; em produção
     * define-se um valor finito (ex.: 60) e o balde passa a valer.
     */
    agentTransportRateLimit: {
      max: toInt(env.KIRANA_AGENT_RATE_MAX, 0),
      windowMs: toInt(env.KIRANA_RATE_LIMIT_WINDOW_MS, 60_000),
    },
    /**
     * Fase 4 — site em que a Kirana atende.
     *
     * `id` é o nome do diretório em `sites/` (a config valida a existência).
     * `publicUrl` é a URL que o visitante vê (usada na navegação do widget).
     * Nada de segredo aqui: esta configuração chega ao navegador.
     */
    site: {
      id: (env.KIRANA_SITE_ID || 'opportunity-ai').trim(),
      publicUrl: (env.KIRANA_SITE_URL || 'https://opportunity.ia.br').trim(),
    },
    // Apenas para prévias em sandbox/iframe de outra origem. Não usar em produção.
    allowEmbed: toBool(env.KIRANA_ALLOW_EMBED, false),
    /**
     * Origens que podem embutir a interface em iframe (modo de integração com o
     * site). Preferível a `allowEmbed`: em vez de liberar TODO mundo
     * (`frame-ancestors *`), libera só os domínios listados.
     * Ex.: KIRANA_EMBED_ORIGINS=https://opportunity.ia.br
     */
    embedOrigins: String(env.KIRANA_EMBED_ORIGINS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    gateway: {
      url: (env.KIRANA_GATEWAY_URL || 'http://127.0.0.1:1455').replace(/\/+$/, ''),
      apiKey: gatewayApiKey,
      requestTimeoutMs: toInt(env.KIRANA_REQUEST_TIMEOUT_MS, 120_000),
      firstTokenTimeoutMs: toInt(env.KIRANA_FIRST_TOKEN_TIMEOUT_MS, 20_000),
    },
    /**
     * Ponte `/api/gateway/*`: celular → Kirana (3000) → Gateway (1455, loopback).
     *
     * Existe para o celular usar o Gateway sem que o Gateway saia do loopback.
     * Desligada por padrão; ligada exige token próprio (32+ caracteres) e é
     * validada no start — ver `validateBridgeConfig`.
     */
    bridge: {
      enabled: toBool(env.KIRANA_BRIDGE, false),
      token: (env.KIRANA_BRIDGE_TOKEN || '').trim(),
      timeoutMs: toInt(env.KIRANA_BRIDGE_TIMEOUT_MS, 180_000),
      rateMax: toInt(env.KIRANA_BRIDGE_RATE_MAX, 30),
      /**
       * Acesso remoto via Tailscale Serve (HTTPS privado no tailnet).
       *
       * `KIRANA_BRIDGE_REQUIRE_HTTPS=on` exige que o pedido tenha chegado por
       * HTTPS (`X-Forwarded-Proto: https`), que é o que o `tailscale serve`
       * injeta. Sem esse cabeçalho, a ponte recusa — assim uma exposição
       * acidental em HTTP claro não passa despercebida.
       *
       * `KIRANA_BRIDGE_TRUST_PROXY=on` passa a usar `X-Forwarded-For` e
       * `Tailscale-User-Login` como identidade do cliente. Só ligue atrás do
       * Serve: sem proxy na frente, esses cabeçalhos são forjáveis e o limite
       * por origem viraria enfeite.
       */
      requireHttps: toBool(env.KIRANA_BRIDGE_REQUIRE_HTTPS, false),
      trustProxy: toBool(env.KIRANA_BRIDGE_TRUST_PROXY, false),
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
    site: { id: config.site?.id ?? null, publicUrl: config.site?.publicUrl ?? null },
    limits: config.rateLimit,
    timeouts: { firstTokenMs: config.gateway.firstTokenTimeoutMs },
  };
}

/**
 * Travas da ponte do Gateway — valem em QUALQUER ambiente, não só produção.
 *
 * Por que não só em produção: a ponte existe justamente para uso doméstico, com
 * o celular no mesmo Wi-Fi. Um erro de configuração aqui abre a conta do plano
 * para a rede inteira em silêncio, então falhar no start é o comportamento certo.
 *
 * @returns {{fatal:string[], avisos:string[]}}
 */
export function validateBridgeConfig(config) {
  const fatal = [];
  const avisos = [];
  const ponte = config.bridge || {};
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);

  if (!ponte.enabled) return { fatal, avisos };

  if (!ponte.token || ponte.token.length < 32) {
    fatal.push('KIRANA_BRIDGE=on exige KIRANA_BRIDGE_TOKEN com 32+ caracteres. Sem token a ponte recusaria todos os pedidos.');
  }
  if (loopback) {
    avisos.push('Ponte ligada, mas KIRANA_HOST é loopback: o celular não alcança esta máquina. Para uso no Wi-Fi, defina KIRANA_HOST=0.0.0.0 (e mantenha KIRANA_ACCESS_TOKEN preenchido).');
  }
  if (!loopback && !config.accessToken) {
    fatal.push('KIRANA_HOST fora do loopback com a ponte ligada exige KIRANA_ACCESS_TOKEN: sem ele, /api/sessions e /api/memory ficariam abertos na rede.');
  }
  if (ponte.trustProxy) {
    /**
     * `trustProxy` significa que existe um proxy na frente — e proxy existe para
     * alcançar a aplicação de fora. Com `tailscale serve` isso é o tailnet
     * inteiro. Se não houver `KIRANA_ACCESS_TOKEN`, `/api/sessions` e
     * `/api/memory` ficariam legíveis por qualquer aparelho do tailnet. Por isso
     * é fatal, e não aviso: é o mesmo raciocínio do host fora do loopback.
     */
    if (!config.accessToken) {
      fatal.push('KIRANA_BRIDGE_TRUST_PROXY=on exige KIRANA_ACCESS_TOKEN: atrás do `tailscale serve` a Kirana fica alcançável de outros aparelhos do tailnet, e /api/sessions e /api/memory não podem ficar abertas.');
    } else {
      avisos.push('KIRANA_BRIDGE_TRUST_PROXY=on: X-Forwarded-For/Tailscale-User-Login serão aceitos como identidade. Só é seguro atrás do `tailscale serve`.');
    }
  }
  if (ponte.requireHttps && !ponte.trustProxy) {
    // Sem confiar no proxy, ninguém consegue provar HTTPS e a ponte recusaria
    // TODO pedido. Falhar no start é melhor que um 403 misterioso em campo.
    fatal.push('KIRANA_BRIDGE_REQUIRE_HTTPS=on exige KIRANA_BRIDGE_TRUST_PROXY=on: só o proxy (tailscale serve) informa que o pedido veio por HTTPS.');
  }
  if (!ponte.requireHttps) {
    avisos.push('KIRANA_BRIDGE_REQUIRE_HTTPS=off: a ponte aceita pedido sem HTTPS. Para acesso remoto, ligue (o `tailscale serve` fornece o TLS).');
  }
  return { fatal, avisos };
}

/**
 * Travas de produção — avaliadas no start e no `doctor`.
 *
 * A ideia é simples: o que impede um backend público de vazar dado ou de abrir
 * a conta do Gateway não pode morar só na documentação. Estas verificações
 * rodam quando `KIRANA_ENV=production`; em desenvolvimento não mudam nada.
 *
 * @returns {{fatal:string[], avisos:string[]}}
 */
export function validateProductionConfig(config) {
  const fatal = [];
  const avisos = [];
  if (config.env !== 'production') return { fatal, avisos };

  if (!config.accessToken) {
    fatal.push('KIRANA_ACCESS_TOKEN vazio: as rotas privadas (sessões, memória, conteúdo de conversa) ficariam abertas.');
  }
  if (!config.trustProxy) {
    avisos.push('KIRANA_TRUST_PROXY=false: atrás de proxy, todos os visitantes compartilham o mesmo IP e o limite por IP vira limite global.');
  }
  if (!(config.agentTransportRateLimit?.max > 0)) {
    avisos.push('KIRANA_AGENT_RATE_MAX=0: /api/copilot e /api/agui ficam sem limite. Cada chamada consome o plano do Gateway.');
  }
  if (config.allowedOrigins.length === 0) {
    avisos.push('KIRANA_ALLOWED_ORIGINS vazio: só as origens do site.json poderão chamar a Kirana. Confirme que o domínio publicado está lá.');
  }
  if (/^http:\/\//.test(config.gateway.url)) {
    avisos.push('KIRANA_GATEWAY_URL em HTTP sem TLS: aceitável só se for loopback/ túnel privado no mesmo host.');
  }
  if (config.allowEmbed) {
    avisos.push('KIRANA_ALLOW_EMBED=true: qualquer site poderá embutir a interface.');
  }
  return { fatal, avisos };
}
