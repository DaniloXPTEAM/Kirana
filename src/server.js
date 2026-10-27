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

import { loadConfig, loadEnvFile, publicApiConfig, validateProductionConfig, PROJECT_ROOT } from './config.js';
import { createLogger } from './logger.js';
import { createGatewayClient } from './gateway.js';
import { createSessionStore } from './sessions.js';
import { createMemoryStore, MemoryError } from './memory.js';
import { createInterestStore } from './interests.js';
import { loadCatalog } from './catalog/index.js';
import { createToolRegistry } from './tools/registry.js';
import { createSiteContext } from './site/context.js';
import { createSiteTools } from './site/tools.js';
import { createRequestTools } from './site/request-tools.js';
import { createRequestStore, isSessionId } from './requests/store.js';
import { createFileStore } from './requests/files.js';
import { loadRequirements } from './requests/requirements.js';
import { createToolDefinitions } from './tools/definitions.js';
import { createAgent, mapError } from './agent.js';
import { createSiteKit } from './copilot/site-kit.js';
import { createCopilotHandler } from './copilot/runtime.js';
import { createCopilotIntegration } from './copilot/http.js';
import { corsFor, enforceCors } from './cors.js';
import { createDemoContact } from './demo-contact.js';
import { createRateLimiter } from './ratelimit.js';
import { createVoiceService } from './voice/tts.js';
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

  /**
   * Travas de produção: falham no START, não em produção. Um backend público
   * com `KIRANA_ENV=production` e sem `KIRANA_ACCESS_TOKEN` exporia as conversas
   * de todos os visitantes — melhor não subir.
   */
  const producao = validateProductionConfig(config);
  for (const aviso of producao.avisos) logger.warn(`Produção: ${aviso}`);
  if (producao.fatal.length) {
    const detalhe = producao.fatal.join(' | ');
    logger.error(`Configuração de produção inválida: ${detalhe}`);
    if (!overrides.allowUnsafeProduction) throw new Error(`Configuração de produção inválida: ${detalhe}`);
  }
  const catalog = overrides.catalog ?? loadCatalog({ logger });
  const sessions = overrides.sessions ?? createSessionStore({ dataDir: config.dataDir, logger });
  const memory = overrides.memory ?? createMemoryStore({ dataDir: config.dataDir, limits: config.agent, logger });
  const interests = overrides.interests ?? createInterestStore({ dataDir: config.dataDir, logger });
  const gateway = overrides.gateway ?? createGatewayClient({ config, logger });
  const siteKit = overrides.siteKit ?? createSiteKit({ sitesDir: path.join(PROJECT_ROOT, 'sites'), logger });
  const baseTools = overrides.tools ?? createToolDefinitions({ catalog, memory, interests, logger });

  /**
   * Fase 4 — camada do site.
   *
   * `siteContext` resolve o site da conversa e carrega o conhecimento;
   * `siteTools` são as ferramentas de contexto, navegação e confirmação. As duas
   * convivem com as ferramentas da Fase 1: nada foi removido.
   */
  const siteContext =
    overrides.siteContext ??
    (overrides.disableSite ? null : createSiteContext({ siteKit, sitesDir: path.join(PROJECT_ROOT, 'sites'), logger }));
  /**
   * Fase 5 — solicitações operacionais.
   *
   * `requestStore` guarda a tarefa (rascunho → envio), `fileStore` guarda os
   * anexos com política própria, e `requirements` é o cadastro por serviço do
   * site. Os três são opcionais para não quebrar instâncias sem a Fase 5.
   */
  const requestStore = overrides.requestStore ?? createRequestStore({ dataDir: config.dataDir, logger });
  const fileStore =
    overrides.fileStore ??
    createFileStore({
      dataDir: config.dataDir,
      logger,
      maxBytes: (config.site?.uploads?.maxMb ?? 5) * 1024 * 1024,
      maxFiles: config.site?.uploads?.maxFiles ?? 5,
      retentionDays: config.site?.uploads?.retentionDays ?? 30,
    });
  /**
   * Requisitos por serviço: `sites/<siteId>/requirements.json`.
   * Ausente = nenhum requisito publicado; as ferramentas respondem a lacuna em
   * vez de inventar exigência (regra da Fase 5).
   */
  const requirements =
    overrides.requirements ??
    (() => {
      const siteId = config.site?.id ?? '';
      const dir = siteId ? path.join(PROJECT_ROOT, 'sites', siteId) : null;
      return dir ? loadRequirements({ dir, logger }) : null;
    })();
  const requests = { store: requestStore, requirements, files: fileStore };
  const siteTools =
    overrides.siteTools ?? (siteContext ? createSiteTools({ siteContext, logger, defaultSiteId: config.site?.id ?? null, requests }).tools : []);
  const requestTools =
    overrides.requestTools ??
    (siteContext
      ? createRequestTools({ siteContext, requests, files: fileStore, logger, defaultSiteId: config.site?.id ?? null, config }).tools
      : []);
  const tools = overrides.tools ?? [...baseTools, ...siteTools, ...requestTools];
  const registry = overrides.registry ?? createToolRegistry({ tools, logger });
  const agent = overrides.agent ?? createAgent({ config, gateway, registry, sessions, memory, logger, catalog, siteContext, requests });
  const limiter = createRateLimiter(config.rateLimit);
  /**
   * Voz: balde próprio de limite.
   *
   * Uma única resposta falada gera VÁRIOS pedidos de síntese (um por frase) e,
   * se o mesmo balde do chat fosse usado, o limite padrão (20/min) silenciaria
   * a Kirana no meio da resposta — e o seletor de vozes apareceria vazio. O
   * limite da voz é proporcional (6x) ao do chat, no mesmo intervalo, e a
   * síntese continua com as mesmas travas: sessão válida, mesmo token, mesmo
   * limite de 3000 caracteres e abort que mata o worker.
   */
  const voiceLimiter = createRateLimiter({
    max: Math.max(config.rateLimit.max * 6, 60),
    windowMs: config.rateLimit.windowMs,
  });

  /**
   * Balde do transporte do agente no navegador (`/api/copilot`, `/api/agui`).
   * Fica desligado enquanto `KIRANA_AGENT_RATE_MAX` for 0 (padrão), o que
   * preserva o comportamento das versões anteriores e das suítes de teste. Em
   * produção define-se um valor finito — ver docs/PRODUCAO.md.
   */
  const agentLimiter = config.agentTransportRateLimit?.max > 0
    ? createRateLimiter({
        max: config.agentTransportRateLimit.max,
        windowMs: config.agentTransportRateLimit.windowMs,
      })
    : null;

  function checkAgentRate(req) {
    if (!agentLimiter) return;
    const result = agentLimiter.check(clientIp(req));
    if (!result.allowed) {
      throw new HttpError(429, 'rate_limited', 'Muitas requisições ao agente em pouco tempo. Aguarde um instante.', {
        retryAfterMs: Math.round(result.retryAfterMs),
      });
    }
  }

  const requestLimiter = createRateLimiter({
    max: Math.max(Math.round(config.rateLimit.max / 2), 6),
    windowMs: config.rateLimit.windowMs,
  });

  const demoContact = overrides.demoContact ?? createDemoContact({ interests, logger });
  // Voz: modalidade da MESMA agente. Só sintetiza texto; não orquestra nada.
  const voice = overrides.voice ?? createVoiceService({ logger });
  // Adaptador AG-UI (`/api/agui`). Só é usado quando alguém chama esse caminho;
  // não inicializa o CopilotKit e não interfere em `/api/copilot`.
  const agui = overrides.agui ?? createCopilotIntegration({
    config,
    agent,
    sessions,
    siteKit,
    logger,
    getPort: () => server.address()?.port ?? config.port,
  });
  // CopilotKit é opcional: se a inicialização falhar, a Kirana v0.2.1 segue no ar.
  let copilot = null;
  try {
    copilot = overrides.copilot ?? createCopilotHandler({ agent, sessions, siteKit, logger, basePath: '/api/copilot' });
  } catch (error) {
    logger.warn('CopilotKit indisponível; interface antiga segue funcionando', { message: error?.message });
  }

  let gatewayStatusCache = { at: 0, value: null };

  /* ------------------------------ utilidades ----------------------------- */

  /**
   * IP do cliente.
   *
   * Atrás de proxy (Caddy/Nginx) o socket é SEMPRE o proxy. Com
   * `KIRANA_TRUST_PROXY=true` usamos o primeiro IP de `X-Forwarded-For`, que é o
   * do visitante. Sem isso, todos os visitantes compartilham um único balde e o
   * limite de uso vira um limite global (o primeiro visitante derruba o site).
   *
   * A confiança é explícita: nunca lemos o cabeçalho por padrão, porque ele é
   * forjável quando o servidor está exposto direto.
   */
  const clientIp = (req) => {
    if (config.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim();
      if (forwarded) return forwarded;
    }
    return req.socket?.remoteAddress || 'local';
  };

  function assertAuth(req) {
    if (!config.accessToken) return;
    const header = req.headers.authorization || '';
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const custom = String(req.headers['x-kirana-token'] || '').trim();
    if (bearer !== config.accessToken && custom !== config.accessToken) {
      throw new HttpError(401, 'unauthorized', 'Token de acesso ausente ou inválido.');
    }
  }

  /**
   * Bloqueia chamadas de origem não autorizada (proteção básica contra CSRF).
   *
   * Usa a MESMA política do CORS (`src/cors.js`): mesma origem **ou** origem
   * listada em `site.json` / `KIRANA_ALLOWED_ORIGINS`. Antes exigia Host
   * idêntico, o que impedia o site público (outra origem) de chamar a Kirana —
   * exatamente o cenário de produção.
   */
  function assertSameOrigin(req) {
    if (!req.headers.origin) return; // cliente que não é navegador
    if (req.kiranaCors?.allowed) return;
    throw new HttpError(403, 'forbidden_origin', 'Origem não permitida.');
  }

  /**
   * Rotas privadas: em produção exigem autenticação.
   *
   * Por que existe: `GET /api/sessions` devolve TODAS as conversas (os títulos
   * são mensagens do visitante) e `GET /api/memory` devolve a memória do
   * assistente. Em localhost isso é conveniência de desenvolvimento; num backend
   * público é vazamento de dado de terceiros. Em `development` (padrão) nada
   * muda em relação às versões anteriores.
   */
  function assertPrivate(req) {
    if (config.env !== 'production') return;
    assertAuth(req);
  }

  function checkVoiceRate(req) {
    const result = voiceLimiter.check(clientIp(req));
    if (!result.allowed) {
      throw new HttpError(429, 'rate_limited', 'Muitas requisições de voz em pouco tempo. Aguarde um instante.', {
        retryAfterMs: Math.round(result.retryAfterMs),
      });
    }
  }

  /**
   * Balde próprio para upload/remoção de arquivo.
   *
   * Upload é a rota mais cara do servidor (corpo grande + disco): se usasse o
   * mesmo balde do chat, um anexo consumiria a cota da conversa; se não tivesse
   * balde próprio, seria o caminho mais fácil de abuso. Limite menor e janela
   * própria, proporcional ao tamanho do arquivo permitido.
   */
  function checkRequestRate(req) {
    const result = requestLimiter.check(clientIp(req));
    if (!result.allowed) {
      throw new HttpError(429, 'rate_limited', 'Muitos envios de arquivo em pouco tempo. Aguarde um instante.', {
        retryAfterMs: Math.round(result.retryAfterMs),
      });
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

    for (const [key, value] of Object.entries(securityHeaders({ allowEmbed: config.allowEmbed, embedOrigins: config.embedOrigins }))) res.setHeader(key, value);

    // CORS: o site público (outra origem) precisa poder chamar a Kirana.
    // Lista fechada — nunca `*` — vinda do site.json + KIRANA_ALLOWED_ORIGINS.
    const cors = corsFor(req, { siteKit, extraOrigins: config.allowedOrigins });
    req.kiranaCors = cors;
    for (const [key, value] of Object.entries(cors.headers)) res.setHeader(key, value);
    if (req.headers.origin && !cors.allowed) {
      logger.warn('Origem não autorizada', { origin: cors.origin });
    }

    try {
      if (method === 'OPTIONS') {
        // Preflight do navegador: responde só com os cabeçalhos já definidos.
        // Origem fora da lista recebe 204 SEM CORS e o navegador bloqueia.
        res.writeHead(204, { Allow: 'GET,POST,DELETE,OPTIONS' });
        res.end();
        return;
      }

      if (url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok', app: config.appName, version: config.version, uptime: Math.round(process.uptime()) });
        return;
      }

      // Metadados do site integrado (ações permitidas, recursos, chaves de
      // estado). Somente leitura e sem segredos: serve ao widget e à integração.
      if (url.pathname === '/api/site/info' && (method === 'GET' || method === 'HEAD')) {
        const site = siteKit.resolve(url.searchParams.get('site') || '');
        sendJson(res, site ? 200 : 404, site
          ? {
              site: {
                id: site.id,
                name: site.name,
                persona: site.persona,
                greeting: site.greeting,
                features: site.features,
                tools: site.tools.map((t) => ({ name: t.name, description: t.description, requiresConfirmation: t.requiresConfirmation })),
                stateKeys: site.stateKeys,
                generativeComponents: site.generativeComponents,
                url: site.siteUrl ?? null,
                agentName: site.agentName ?? site.persona,
                knowledge: (() => {
                  const knowledge = siteContext?.knowledgeFor(site.id);
                  return knowledge
                    ? { documentos: knowledge.docs.length, atualizadoEm: knowledge.docs[0]?.capturedAt ?? null }
                    : null;
                })(),
                pages: (site.pages ?? []).map((p) => ({ id: p.id, path: p.path, title: p.title })),
                routes: site.routes?.allowlist ?? [],
                permissions: site.permissions ?? null,
                uploads: { available: false, reason: site.permissions?.deniedReasons?.request_file_upload ?? null },
              },
              copilotkit: '/api/copilot',
              sites: siteKit.list().map((x) => x.id),
            }
          : { error: 'site_not_found' });
        return;
      }

      /*
       * NOTA DELIBERADA — `GET /api/copilot/info` responde 405 e isso está certo.
       *
       * O runtime do CopilotKit aqui é **single-route**: o cliente descobre o
       * runtime por `POST /api/copilot {"method":"info"}`, que devolve
       * `{version, agents:{kirana:…}, singleRoute:{…}}`.
       *
       * O cliente v2, em modo `transport: "auto"`, primeiro tenta
       * `GET <runtimeUrl>/info`: se essa chamada responder 2xx ele assume o
       * transporte **REST** (`/agent/run`, `/info`…) e passa a mandar requisições
       * que este runtime não serve — o resultado medido foi HTTP 400
       * "Missing method field" e painel preso em "conectando…". Com 405 (ou
       * qualquer não-2xx) ele cai corretamente no single-route e funciona.
       *
       * Portanto: NÃO montar GET aqui. A informação do runtime é servida pelo
       * envelope POST, e é isso que os testes verificam
       * (`test/copilot-routes.test.js`).
       */

      // CopilotKit / AG-UI (V2). Fica fora do handleApi para preservar o
      // fluxo antigo: nenhuma rota existente muda de comportamento.
      if (url.pathname.startsWith('/api/copilot')) {
        if (!copilot) return sendError(res, 503, 'copilot_unavailable', 'CopilotKit não disponível neste ambiente.');
        checkAgentRate(req);
        // O runtime responde `Access-Control-Allow-Origin: *` por padrão: aqui a
        // lista fechada da Kirana prevalece (ver src/cors.js → enforceCors).
        enforceCors(res, cors);
        await copilot.handler(req, res);
        return;
      }

      /**
       * POST /api/agui — protocolo AG-UI puro (SSE).
       *
       * Existe como transporte alternativo desde a Fase 4 (`npm run
       * build:widget -- --agui` gera um widget que fala este caminho), mas
       * nunca esteve montado no servidor: quem chamava recebia 404. A montagem
       * é ISOLADA — o handler é o mesmo módulo testado (`createCopilotIntegration`)
       * e só é chamado para o caminho exato; `/api/copilot` não passa por aqui.
       */
      if (url.pathname === '/api/agui' || url.pathname === '/api/agui/') {
        if (!agui) return sendError(res, 503, 'agui_unavailable', 'AG-UI não disponível neste ambiente.');
        checkAgentRate(req);
        enforceCors(res, cors);
        await agui.handle(req, res, url);
        return;
      }

      if (url.pathname === '/demo' || url.pathname === '/demo/') {
        serveStatic(config.publicDir, '/demo/index.html', res);
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

  /** Sinal de aborto ligado ao fechamento da conexão (barge-in / navegador). */
  function abortSignalFor(req, res) {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(new DOMException('client closed', 'AbortError'));
    });
    return controller.signal;
  }

  async function handleApi({ req, res, url, method }) {
    const route = url.pathname;

    /* ---------------------------- leitura ---------------------------- */
    if (route === '/api/config' && method === 'GET') {
      const models = await agent.resolveActiveModel();
      sendJson(res, 200, publicApiConfig(config, { activeModel: models.active }));
      return;
    }

    /* --------------------- contexto do site (Fase 4) ------------------ */
    /**
     * O navegador informa em que página o visitante está.
     *
     * Por que um endpoint e não só o corpo do /api/chat: a Kirana precisa saber
     * a página ATUAL mesmo antes da primeira mensagem (para explicar a página,
     * sugerir navegação e não inventar contexto). A resposta é o contexto já
     * validado — o cliente nunca decide sozinho o que é página conhecida.
     */
    if (route === '/api/site/context' && method === 'POST') {
      assertAuth(req);
      assertSameOrigin(req);
      checkRate(req);
      const body = await readJsonBody(req, { maxBytes: config.maxBodyBytes });
      const site = siteContext?.site(typeof body.siteId === 'string' ? body.siteId : config.site?.id);
      if (!site) throw new HttpError(404, 'site_not_found', 'Site não integrado.');
      const state = {
        path: typeof body.path === 'string' ? body.path.slice(0, 200) : '',
        pageId: typeof body.pageId === 'string' ? body.pageId.slice(0, 60) : '',
      };
      const current = siteContext.currentContext(site.id, state);
      if (typeof body.sessionId === 'string' && body.sessionId) {
        const session = sessions.get(body.sessionId);
        if (session) {
          session.siteId = site.id;
          session.siteState = { path: current.path, pageId: current.page?.id ?? null };
          sessions.save(session);
        }
      }
      sendJson(res, 200, {
        site: current.site,
        page: current.page,
        service: current.service,
        matched: current.matched,
        informedPath: current.informedPath,
      });
      return;
    }

    if (route === '/api/site/knowledge' && method === 'GET') {
      assertAuth(req);
      checkRate(req);
      const site = siteContext?.site(url.searchParams.get('site') || config.site?.id);
      if (!site) throw new HttpError(404, 'site_not_found', 'Site não integrado.');
      const reloaded = siteContext.refreshIfStale(site.id);
      const knowledge = siteContext.knowledgeFor(site.id);
      sendJson(res, 200, {
        site: site.id,
        reloaded,
        documentos: knowledge?.docs.map((doc) => ({ id: doc.id, titulo: doc.title, fonte: doc.source, capturadoEm: doc.capturedAt })) ?? [],
        servicos: knowledge?.services() ?? [],
      });
      return;
    }

    /* ------------------- solicitações da Fase 5 (tarefas) ---------------- */
    /**
     * Leitura do estado da tarefa pela interface.
     *
     * O `sessionId` é obrigatório e a leitura passa pelo store, que confere o
     * dono. Sem isso a rota seria um vazamento entre visitantes.
     */
    if (route === '/api/requests' && method === 'GET') {
      assertAuth(req);
      checkRate(req);
      const sessionId = url.searchParams.get('sessionId') || '';
      if (!isSessionId(sessionId)) throw new HttpError(400, 'invalid_session', 'Informe um sessionId válido.');
      sendJson(res, 200, {
        solicitacoes: requestStore.list(sessionId).map((request) => ({
          id: request.id,
          serviceId: request.serviceId,
          estado: request.state,
          criadaEm: request.createdAt,
          atualizadaEm: request.updatedAt,
          arquivos: (request.files ?? []).length,
        })),
      });
      return;
    }

    const requestMatch = route.match(/^\/api\/requests\/(REQ-\d{4}-[A-Z0-9]{6})$/);
    if (requestMatch && method === 'GET') {
      assertAuth(req);
      checkRate(req);
      const sessionId = url.searchParams.get('sessionId') || '';
      if (!isSessionId(sessionId)) throw new HttpError(400, 'invalid_session', 'Informe um sessionId válido.');
      const request = requestStore.get(requestMatch[1], sessionId);
      if (!request) throw new HttpError(404, 'request_not_found', 'Solicitação não encontrada nesta conversa.');
      sendJson(res, 200, {
        id: request.id,
        serviceId: request.serviceId,
        serviceTitle: request.serviceTitle,
        estado: request.state,
        dados: request.data,
        arquivos: (request.files ?? []).map((file) => ({ id: file.id, nome: file.name, tamanho: file.size, expiraEm: file.expiresAt })),
        enviadaEm: request.submittedAt,
        externalId: request.externalId,
        historico: (request.history ?? []).slice(-20),
      });
      return;
    }

    const fileMatch = route.match(/^\/api\/requests\/(REQ-\d{4}-[A-Z0-9]{6})\/files$/);
    if (fileMatch && method === 'POST') {
      assertAuth(req);
      assertSameOrigin(req);
      checkRequestRate(req);
      // 1 MB de folga para o base64 (que infla ~33%) sobre o limite do arquivo.
      const body = await readJsonBody(req, { maxBytes: Math.min(config.maxBodyBytes, fileStore.maxBytes * 2 + 64 * 1024) });
      const request = requestStore.get(fileMatch[1], typeof body.sessionId === 'string' ? body.sessionId : '');
      if (!request) throw new HttpError(404, 'request_not_found', 'Solicitação não encontrada nesta conversa.');
      if (!requestStore.canEdit(request)) throw new HttpError(409, 'request_closed', `A solicitação está em ${request.state} e não aceita arquivos.`);
      if (typeof body.filename !== 'string' || typeof body.dataBase64 !== 'string') {
        throw new HttpError(400, 'invalid_upload', 'Informe filename e dataBase64.');
      }
      let buffer;
      try {
        buffer = Buffer.from(body.dataBase64, 'base64');
      } catch {
        throw new HttpError(400, 'invalid_upload', 'Conteúdo do arquivo inválido.');
      }
      const saved = fileStore.save(request, { filename: body.filename, contentType: body.contentType, buffer });
      if (!saved.ok) throw new HttpError(400, saved.code, saved.message);
      // O store é quem registra o metadado e o histórico (e quem barra estado fechado).
      const attached = requestStore.addFile(request.id, request.sessionId, saved.file);
      if (!attached.ok) {
        fileStore.remove(request.id, saved.file); // não deixa arquivo órfão no disco
        throw new HttpError(409, attached.error.code, attached.error.message);
      }
      sendJson(res, 201, { arquivo: { id: saved.file.id, nome: saved.file.name, tamanho: saved.file.size, expiraEm: saved.file.expiresAt } });
      return;
    }

    const fileDeleteMatch = route.match(/^\/api\/requests\/(REQ-\d{4}-[A-Z0-9]{6})\/files\/(f_[a-z0-9]{6,20})$/);
    if (fileDeleteMatch && method === 'DELETE') {
      assertAuth(req);
      assertSameOrigin(req);
      checkRequestRate(req);
      const sessionId = url.searchParams.get('sessionId') || '';
      const request = requestStore.get(fileDeleteMatch[1], sessionId);
      if (!request) throw new HttpError(404, 'request_not_found', 'Solicitação não encontrada nesta conversa.');
      if (!requestStore.canEdit(request)) throw new HttpError(409, 'request_closed', `A solicitação está em ${request.state} e não aceita alterações.`);
      const removed = requestStore.removeFile(request.id, sessionId, fileDeleteMatch[2]);
      if (!removed.ok) throw new HttpError(404, removed.error.code, removed.error.message);
      fileStore.remove(request.id, removed.file);
      sendJson(res, 200, { removido: true, id: removed.file.id });
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
      assertPrivate(req);
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
        assertPrivate(req);
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
      assertPrivate(req);
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

      // Fase 4: o site e a página vêm do navegador, mas são validados aqui.
      const requestedSite = typeof body.siteId === 'string' && body.siteId ? body.siteId : config.site?.id;
      const site = siteContext?.site(requestedSite);
      if (site) {
        session.siteId = site.id;
        if (typeof body.path === 'string' || typeof body.pageId === 'string') {
          const current = siteContext.currentContext(site.id, { path: body.path, pageId: body.pageId });
          session.siteState = { path: current.path, pageId: current.page?.id ?? null };
        }
        sessions.save(session);
      }

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

    /* --------------------------- voz (TTS) --------------------------- */
    // Estado do motor. Não chama a rede: apenas verifica o worker local.
    if (route === '/api/voice/status' && (method === 'GET' || method === 'HEAD')) {
      assertAuth(req);
      checkRate(req);
      const state = await voice.status();
      sendJson(res, 200, { ...state, streaming: true, mime: 'audio/mpeg', maxChars: 3000 });
      return;
    }

    // Catálogo de vozes pt-BR do motor do servidor. A interface combina isto
    // com as vozes do próprio navegador; se o provedor estiver fora do ar, a
    // lista volta vazia e a voz do navegador continua funcionando.
    if (route === '/api/voice/voices' && (method === 'GET' || method === 'HEAD')) {
      assertAuth(req);
      checkVoiceRate(req);
      const voices = await voice.listVoices({ force: url.searchParams.get('force') === '1' });
      sendJson(res, 200, {
        voices: voices.map((item) => ({
          engine: 'edge',
          shortName: item.shortName,
          locale: item.locale,
          gender: item.gender,
        })),
        defaultVoice: voice.voice,
        rate: voice.rate,
      });
      return;
    }

    // Instrumentação da voz: o que foi realmente enviado ao motor em cada
    // segmento. Só memória, teto de 50 registros, exige o mesmo token da API.
    if (route === '/api/voice/diagnostics' && method === 'GET') {
      assertAuth(req);
      checkRate(req);
      const sessionId = url.searchParams.get('sessionId') || '';
      const entries = voice.diagnostics(sessionId ? { sessionId } : {});
      sendJson(res, 200, { count: entries.length, entries, voice: voice.voice, rate: voice.rate });
      return;
    }

    // Sintetiza a fala de UMA mensagem da sessão. Texto -> MP3 em stream.
    // Não cria sessão, não altera histórico, não executa ferramentas.
    if (route === '/api/voice/tts' && method === 'POST') {
      assertAuth(req);
      assertSameOrigin(req);
      checkVoiceRate(req); // balde próprio: uma resposta falada = vários pedidos
      const body = await readJsonBody(req, { maxBytes: 32 * 1024 });
      const session = sessions.get(typeof body.sessionId === 'string' ? body.sessionId : '');
      if (!session) throw new HttpError(404, 'session_not_found', 'Sessão não encontrada.');
      const text = typeof body.text === 'string' ? body.text : '';
      // Identificadores de rastreio (opcionais): ligam mensagem, segmento e áudio.
      const turnId = typeof body.turnId === 'number' || typeof body.turnId === 'string' ? String(body.turnId).slice(0, 24) : null;
      const segmentId = typeof body.segmentId === 'string' ? body.segmentId.slice(0, 40) : null;
      // Voz escolhida na interface (opcional). A lista é fechada no serviço.
      const requestedVoice = typeof body.voice === 'string' ? body.voice.slice(0, 64) : null;

      let result;
      try {
        result = voice.synthesizeStream(text, {
          signal: abortSignalFor(req, res),
          turnId,
          segmentId,
          sessionId: session.id,
          voice: requestedVoice,
        });
      } catch (error) {
        sendError(res, error?.status || 503, error?.code || 'voice_error', error?.message || 'Falha na voz.');
        return;
      }

      res.writeHead(200, {
        'Content-Type': result.mime,
        'Cache-Control': 'no-store',
        'X-Kirana-Voice': result.meta.voice,
        ...(segmentId ? { 'X-Kirana-Segment': segmentId } : {}),
        'X-Accel-Buffering': 'no',
        'Transfer-Encoding': 'chunked',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });

      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        logger.info('voz: síntese encerrada', { code: error || 'ok', ...result.meta, session: session.id });
        if (!res.writableEnded) res.end();
      };

      result.stream.on('data', (chunk) => {
        if (!res.write(chunk)) {
          result.stream.pause();
          res.once('drain', () => result.stream.resume());
        }
      });
      result.stream.on('end', () => finish());
      result.stream.on('error', () => finish('voice_stream_error'));
      res.on('close', () => {
        if (!done) {
          try { result.child.kill(); } catch { /* já morto */ }
          finish('client_closed');
        }
      });
      return;
    }

    /* --------------- site de demonstração: contato com autorização --------------- */
    if (route === '/api/demo/contact/prepare' && method === 'POST') {
      checkRate(req);
      assertSameOrigin(req);
      const body = await readJsonBody(req, { maxBytes: config.maxBodyBytes });
      const result = demoContact.prepare({ values: body.values });
      if (!result.ok) {
        sendJson(res, result.status || 400, { error: result.error, message: result.message, errors: result.errors });
        return;
      }
      sendJson(res, 200, { token: result.token, expiresAt: result.expiresAt, confirmationRequired: true });
      return;
    }

    if (route === '/api/demo/contact/submit' && method === 'POST') {
      checkRate(req);
      assertSameOrigin(req);
      const body = await readJsonBody(req, { maxBytes: config.maxBodyBytes });
      const result = demoContact.submit({ token: body.token, values: body.values });
      if (!result.ok) {
        sendJson(res, result.status || 400, { error: result.error, message: result.message });
        return;
      }
      sendJson(res, 201, { protocolo: result.protocolo, criadoEm: result.criadoEm, stored: true });
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
    voice,
    close() {
      voice.close();
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
