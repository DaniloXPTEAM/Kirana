/**
 * Servidor local da Kirana.
 *
 * - Serve a interface (public/) e a API do agente.
 * - Fala com o gateway via HTTP no backend. A chave nunca chega ao navegador.
 * - Streaming por SSE para o navegador.
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadEnvFile, publicApiConfig, PROJECT_ROOT } from './config.js';
import { createLogger } from './logger.js';
import { createGatewayClient } from './gateway.js';
import { createSessionStore } from './sessions.js';
import { createMemoryStore, MemoryError } from './memory.js';
import { createInterestStore } from './interests.js';
import { loadCatalog } from './catalog/index.js';
import { createToolRegistry } from './tools/registry.js';
import { createToolDefinitions } from './tools/definitions.js';
import { createAgent, mapError } from './agent.js';
import { createRateLimiter } from './ratelimit.js';
import {
  HttpError,
  securityHeaders,
  readJsonBody,
  sendError,
  sendJson,
  serveStatic,
  startSse,
} from './http-utils.js';

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

export function createKiranaServer(overrides = {}) {
  const envFileLoaded = loadEnvFile(path.join(PROJECT_ROOT, '.env'));
  const config = overrides.config ?? loadConfig(process.env);
  const logger = overrides.logger ?? createLogger({ level: config.logLevel, secrets: [config.gateway.apiKey, config.accessToken] });
  const catalog = overrides.catalog ?? loadCatalog({ logger });
  const sessions = overrides.sessions ?? createSessionStore({ dataDir: config.dataDir, logger });
  const memory = overrides.memory ?? createMemoryStore({ dataDir: config.dataDir, limits: config.agent, logger });
  const interests = overrides.interests ?? createInterestStore({ dataDir: config.dataDir, logger });
  const gateway = overrides.gateway ?? createGatewayClient({ config, logger });
  const tools = overrides.tools ?? createToolDefinitions({ catalog, memory, interests, logger });
  const registry = overrides.registry ?? createToolRegistry({ tools, logger });
  const agent = overrides.agent ?? createAgent({ config, gateway, registry, sessions, memory, logger, catalog });
  const limiter = createRateLimiter(config.rateLimit);

  let gatewayStatusCache = { at: 0, value: null };

  /* ------------------------------ utilidades ----------------------------- */

  const clientIp = (req) => req.socket?.remoteAddress || 'local';

  function assertAuth(req) {
    if (!config.accessToken) return;
    const header = req.headers.authorization || '';
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const custom = String(req.headers['x-kirana-token'] || '').trim();
    if (bearer !== config.accessToken && custom !== config.accessToken) {
      throw new HttpError(401, 'unauthorized', 'Token de acesso ausente ou inválido.');
    }
  }

  /** Bloqueia chamadas vindas de outra origem (proteção básica contra CSRF). */
  function assertSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    const host = req.headers.host;
    try {
      const parsed = new URL(origin);
      if (host && parsed.host !== host) {
        throw new HttpError(403, 'forbidden_origin', 'Origem não permitida.');
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(403, 'forbidden_origin', 'Origem inválida.');
    }
  }

  function checkRate(req) {
    const result = limiter.check(clientIp(req));
    if (!result.allowed) {
      throw new HttpError(429, 'rate_limited', 'Muitas requisições em pouco tempo. Aguarde e tente novamente.', {
        retryAfterMs: Math.round(result.retryAfterMs),
      });
    }
  }

  function publicSession(session) {
    const messages = session.messages
      .filter((m) => {
        if (m.role === 'user') return true;
        if (m.role === 'assistant') return Boolean(m.content && m.content.trim());
        return false;
      })
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        at: m.at,
        model: m.model || undefined,
        aborted: Boolean(m.aborted),
        tools: m.toolCalls?.length ? m.toolCalls.map((c) => c.name) : undefined,
      }));

    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages,
      pendingAction: session.pendingAction
        ? {
            id: session.pendingAction.id,
            tool: session.pendingAction.tool,
            title: session.pendingAction.title,
            summary: session.pendingAction.summary,
            expiresAt: session.pendingAction.expiresAt,
          }
        : null,
      stats: {
        turns: session.stats?.turns ?? 0,
        toolCalls: session.stats?.toolCalls ?? 0,
        aborted: session.stats?.aborted ?? 0,
        errors: session.stats?.errors ?? 0,
        avgTtftMs: average(session.stats?.ttftMs),
        avgTotalMs: average(session.stats?.totalMs),
      },
    };
  }

  async function gatewayStatus(force = false) {
    if (!force && gatewayStatusCache.value && Date.now() - gatewayStatusCache.at < 10_000) return gatewayStatusCache.value;
    let value;
    if (!config.gateway.apiKey) {
      value = { configured: false, reachable: false, detail: 'KIRANA_GATEWAY_API_KEY não configurada' };
    } else {
      try {
        const health = await gateway.health();
        let models = null;
        try {
          models = await gateway.models();
        } catch {
          models = null;
        }
        value = { configured: true, reachable: true, health, models };
      } catch (error) {
        value = { configured: true, reachable: false, detail: mapError(error, config).message };
      }
    }
    gatewayStatusCache = { at: Date.now(), value };
    return value;
  }

  /* ------------------------------- rotas --------------------------------- */

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = req.method || 'GET';

    for (const [key, value] of Object.entries(securityHeaders({ allowEmbed: config.allowEmbed }))) res.setHeader(key, value);

    try {
      if (method === 'OPTIONS') {
        res.writeHead(204, { Allow: 'GET,POST,DELETE,OPTIONS' });
        res.end();
        return;
      }

      if (url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok', app: config.appName, version: config.version, uptime: Math.round(process.uptime()) });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        await handleApi({ req, res, url, method });
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        const served = serveStatic(config.publicDir, url.pathname, res);
        if (served) return;
        if (url.pathname !== '/' && !path.extname(url.pathname)) {
          const index = path.join(config.publicDir, 'index.html');
          if (fs.existsSync(index) && serveStatic(config.publicDir, '/index.html', res)) return;
        }
        sendError(res, 404, 'not_found', 'Arquivo não encontrado.');
        return;
      }

      sendError(res, 405, 'method_not_allowed', 'Método não permitido.');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error?.code || 'internal_error';
      if (status >= 500) logger.error('Erro não tratado na requisição', { path: url.pathname, code, message: error?.message });
      if (!res.headersSent) {
        sendError(res, status, code, error?.message || 'Erro interno.', error instanceof HttpError ? error.extra : {});
      } else {
        res.end();
      }
    }
  });

  async function handleApi({ req, res, url, method }) {
    const route = url.pathname;

    /* ---------------------------- leitura ---------------------------- */
    if (route === '/api/config' && method === 'GET') {
      const models = await agent.resolveActiveModel();
      sendJson(res, 200, publicApiConfig(config, { activeModel: models.active }));
      return;
    }

    if (route === '/api/status' && method === 'GET') {
      const [status, models] = await Promise.all([gatewayStatus(), agent.resolveActiveModel()]);
      sendJson(res, 200, {
        gateway: status,
        model: { active: models.active, fallback: config.models.fallback, degraded: Boolean(models.degraded), note: models.note || null },
        interests: interests.count(),
        envFileLoaded: envFileLoadedFor(config),
      });
      return;
    }

    if (route === '/api/tools' && method === 'GET') {
      sendJson(res, 200, {
        tools: registry.list().map((t) => ({
          name: t.name,
          title: t.title || t.name,
          kind: t.kind,
          description: t.description,
        })),
      });
      return;
    }

    if (route === '/api/sessions' && method === 'GET') {
      sendJson(res, 200, { sessions: sessions.list() });
      return;
    }

    if (route === '/api/session' && method === 'POST') {
      const body = await readJsonBody(req, { maxBytes: config.maxBodyBytes });
      const session = sessions.create({});
      logger.info('Sessão criada', { sessionId: session.id, hint: typeof body.title === 'string' ? body.title.slice(0, 40) : undefined });
      sendJson(res, 201, publicSession(session));
      return;
    }

    const sessionMatch = route.match(/^\/api\/session\/(s_[A-Za-z0-9-]{6,64})$/);
    if (sessionMatch) {
      const session = sessions.get(sessionMatch[1]);
      if (!session) {
        sendError(res, 404, 'session_not_found', 'Sessão não encontrada.');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, publicSession(session));
        return;
      }
      if (method === 'DELETE') {
        assertAuth(req);
        assertSameOrigin(req);
        sessions.delete(session.id);
        sendJson(res, 200, { deleted: true, id: session.id });
        return;
      }
    }

    /* ----------------------------- memória -------------------------- */
    if (route === '/api/memory' && method === 'GET') {
      sendJson(res, 200, { items: memory.list() });
      return;
    }

    if (route === '/api/memory' && method === 'POST') {
      checkRate(req);
      assertAuth(req);
      assertSameOrigin(req);
      const body = await readJsonBody(req, { maxBytes: config.maxBodyBytes });
      try {
        const item = memory.upsert({
          key: body.key,
          value: body.value,
          category: typeof body.category === 'string' ? body.category : 'contexto',
          source: 'cadastro manual na interface',
          consent: body.consent === true,
        });
        sendJson(res, 201, { item });
      } catch (error) {
        if (error instanceof MemoryError) throw new HttpError(400, error.code, error.message);
        throw error;
      }
      return;
    }

    const memoryMatch = route.match(/^\/api\/memory\/(mem_[A-Za-z0-9]{1,32})$/);
    if (memoryMatch && method === 'DELETE') {
      assertAuth(req);
      assertSameOrigin(req);
      const removed = memory.remove(memoryMatch[1]);
      if (!removed) {
        sendError(res, 404, 'memory_not_found', 'Item não encontrado.');
        return;
      }
      sendJson(res, 200, { deleted: true });
      return;
    }

    if (route === '/api/memory' && method === 'DELETE') {
      assertAuth(req);
      assertSameOrigin(req);
      memory.clear();
      sendJson(res, 200, { cleared: true });
      return;
    }

    /* ------------------------------- chat --------------------------- */
    if (route === '/api/chat' && method === 'POST') {
      assertAuth(req);
      assertSameOrigin(req);
      checkRate(req);
      const body = await readJsonBody(req, { maxBytes: config.maxBodyBytes });
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const message = typeof body.message === 'string' ? body.message : '';
      if (!sessionId) throw new HttpError(400, 'missing_session', 'Informe sessionId.');
      if (!message.trim()) throw new HttpError(400, 'empty_message', 'Escreva uma mensagem.');
      if (message.length > 8000) throw new HttpError(400, 'message_too_long', 'Mensagem acima de 8000 caracteres.');

      const session = sessions.get(sessionId);
      if (!session) throw new HttpError(404, 'session_not_found', 'Sessão não encontrada. Crie uma nova conversa.');

      await streamAgentTurn({ req, res, session, run: (emit, signal) => agent.runTurn({ session, text: message, emit, signal }) });
      return;
    }

    if (route === '/api/chat/confirm' && method === 'POST') {
      assertAuth(req);
      assertSameOrigin(req);
      checkRate(req);
      const body = await readJsonBody(req, { maxBytes: config.maxBodyBytes });
      const session = sessions.get(typeof body.sessionId === 'string' ? body.sessionId : '');
      if (!session) throw new HttpError(404, 'session_not_found', 'Sessão não encontrada.');
      if (typeof body.actionId !== 'string') throw new HttpError(400, 'missing_action', 'Informe actionId.');
      const approve = body.approve === true;

      await streamAgentTurn({
        req,
        res,
        session,
        run: (emit, signal) => agent.resolveConfirmation({ session, actionId: body.actionId, approve, emit, signal }),
        onHttpError: (error) => {
          throw error;
        },
      });
      return;
    }

    sendError(res, 404, 'not_found', 'Rota não encontrada.');
  }

  async function streamAgentTurn({ req, res, session, run }) {
    const sse = startSse(res, { 'X-Kirana-Session': session.id });
    const controller = new AbortController();
    let finished = false;

    res.on('close', () => {
      if (!finished) controller.abort(new DOMException('client closed', 'AbortError'));
    });

    const emit = (event) => {
      if (!finished) sse.send(event);
    };

    try {
      emit({ type: 'session', sessionId: session.id, title: session.title });
      await run(emit, controller.signal);
    } catch (error) {
      const mapped = mapError(error, config);
      emit({ type: 'error', ...mapped });
    } finally {
      finished = true;
      sse.close();
    }
  }

  function envFileLoadedFor(cfg) {
    return fs.existsSync(path.join(PROJECT_ROOT, '.env')) && Boolean(cfg.gateway.apiKey);
  }

  return {
    server,
    config,
    logger,
    sessions,
    memory,
    interests,
    registry,
    agent,
    gateway,
    listen() {
      return new Promise((resolve) => {
        server.listen(config.port, config.host, () => {
          const address = server.address();
          logger.info(`${config.appName} v${config.version} ouvindo em http://${config.host}:${address.port}`);
          if (!config.gateway.apiKey) logger.warn('KIRANA_GATEWAY_API_KEY vazia — conversas vão falhar até configurar o .env');
          if (!config.accessToken) logger.warn('KIRANA_ACCESS_TOKEN vazio — uso local apenas, não publique este servidor');
          resolve(address);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function average(list) {
  const values = (Array.isArray(list) ? list : []).filter((n) => Number.isFinite(n));
  if (!values.length) return null;
  return Math.round(values.reduce((sum, n) => sum + n, 0) / values.length);
}

if (isMain) {
  const app = createKiranaServer();
  app.listen().catch((error) => {
    app.logger.error('Falha ao iniciar', { message: error?.message });
    process.exitCode = 1;
  });

  const shutdown = (signal) => {
    app.logger.info(`Recebido ${signal}, encerrando…`);
    app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
