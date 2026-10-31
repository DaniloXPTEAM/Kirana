/**
 * Endpoints HTTP do CopilotKit/AG-UI.
 *
 *   POST /api/agui    -> protocolo AG-UI puro (SSE). É o "adaptador" que o
 *                        CopilotKit consome via HttpAgent.
 *   ANY  /api/copilot -> runtime oficial do CopilotKit (v1), montado no mesmo
 *                        servidor Node, sem framework extra.
 *
 * Isolamento e segurança:
 *  - o site é identificado por cabeçalho (`x-kirana-site`) ou `forwardedProps`;
 *  - ferramentas são filtradas pelo kit do site;
 *  - nada de chave de gateway chega ao navegador;
 *  - se as dependências do CopilotKit não estiverem instaladas, a Kirana
 *    continua funcionando (o endpoint responde 503 explicando o motivo).
 */
import { randomUUID } from 'node:crypto';
import { runKiranaTurn, sseFrame } from './kirana-agui.js';

const MAX_BODY_BYTES = 512 * 1024;

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Corpo da requisição grande demais.'), { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** Cria o integrador do CopilotKit sobre um servidor Kirana já existente. */
export function createCopilotIntegration({ config, agent, sessions, siteKit, logger, getPort }) {
  const log = logger?.child?.('copilot') ?? logger;
  let copilotHandler = null;
  let copilotInitError = null;
  let copilotInitPromise = null;

  const selfBaseUrl = () => {
    const host = config.host === '0.0.0.0' || !config.host ? '127.0.0.1' : config.host;
    // `getPort` cobre porta efêmera (testes) e bind em 0.0.0.0.
    const port = (typeof getPort === 'function' ? getPort() : null) ?? config.port;
    return `http://${host}:${port}`;
  };

  /** Runtime oficial do CopilotKit (importado sob demanda). */
  async function ensureCopilotHandler() {
    if (copilotHandler) return copilotHandler;
    if (copilotInitError) throw copilotInitError;
    if (!copilotInitPromise) {
      copilotInitPromise = (async () => {
        const runtimePkg = await import('@copilotkit/runtime');
        const { HttpAgent } = await import('@ag-ui/client');
        const Adapter = runtimePkg.ExperimentalEmptyAdapter ?? runtimePkg.EmptyAdapter;
        if (!Adapter) throw new Error('Adapter vazio do CopilotKit não encontrado.');

        const aguiUrl = `${selfBaseUrl()}/api/agui`;
        const runtime = new runtimePkg.CopilotRuntime({
          // O agente da Kirana entra como agente AG-UI hospedado no próprio
          // servidor. O CopilotKit só orquestra: quem fala com o modelo e com o
          // gateway continua sendo a Kirana.
          agents: { kirana: new HttpAgent({ url: aguiUrl }) },
        });

        copilotHandler = runtimePkg.copilotRuntimeNodeHttpEndpoint({
          runtime,
          serviceAdapter: new Adapter(),
          baseUrl: '/api/copilot',
        });
        log.info('Runtime do CopilotKit inicializado', { aguiUrl });
        return copilotHandler;
      })().catch((error) => {
        copilotInitError = error;
        copilotInitPromise = null;
        log.error('Não foi possível inicializar o CopilotKit', { message: error?.message });
        throw error;
      });
    }
    return copilotInitPromise;
  }

  /** POST /api/agui — protocolo AG-UI. */
  async function handleAgUi(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed', message: 'Use POST.' });
      return;
    }

    let input;
    try {
      const raw = await readBody(req);
      input = raw ? JSON.parse(raw) : {};
    } catch (error) {
      sendJson(res, error.status || 400, { error: error.code || 'invalid_body', message: error.message });
      return;
    }

    const siteId = String(
      req.headers['x-kirana-site'] || input?.forwardedProps?.siteId || siteKit?.list?.()[0]?.id || '',
    ).slice(0, 64);

    if (siteKit && !siteKit.originAllowed(siteId, req.headers.origin)) {
      sendJson(res, 403, { error: 'forbidden_origin', message: 'Origem não autorizada para este site.' });
      return;
    }

    const runInput = {
      threadId: input.threadId || `thread_${randomUUID()}`,
      runId: input.runId || `run_${randomUUID()}`,
      messages: Array.isArray(input.messages) ? input.messages : [],
      tools: Array.isArray(input.tools) ? input.tools : [],
      state: input.state && typeof input.state === 'object' ? input.state : {},
      forwardedProps: input.forwardedProps && typeof input.forwardedProps === 'object' ? input.forwardedProps : {},
    };

    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => controller.abort());

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    try {
      for await (const event of runKiranaTurn({
        agent,
        sessions,
        siteKit,
        logger: log,
        input: runInput,
        siteId,
        signal: controller.signal,
      })) {
        if (res.writableEnded) break;
        res.write(sseFrame(event));
      }
    } catch (error) {
      log.error('Falha ao transmitir eventos AG-UI', { message: error?.message });
      if (!res.writableEnded) {
        res.write(sseFrame({ type: 'RUN_ERROR', message: error?.message || 'Erro interno.', code: error?.code || 'adapter_error' }));
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  /** Metadados para o widget (ações permitidas, recursos, identificação). */
  async function handleInfo(req, res, url) {
    const siteId = url.searchParams.get('site') || req.headers['x-kirana-site'] || '';
    const site = siteKit?.get(siteId) ?? null;
    sendJson(res, 200, {
      site: site
        ? {
            id: site.id,
            name: site.name,
            persona: site.persona,
            greeting: site.greeting,
            features: site.features,
            tools: site.tools.map((t) => ({ name: t.name, description: t.description, requiresConfirmation: t.requiresConfirmation })),
            stateKeys: site.stateKeys,
            generativeComponents: site.generativeComponents,
          }
        : null,
      agui: '/api/agui',
      copilotkit: '/api/copilot',
      sites: (siteKit?.list?.() ?? []).map((s) => s.id),
    });
  }

  /** Direciona /api/copilot* para o runtime oficial e /api/agui para nós. */
  async function handle(req, res, url) {
    const route = url.pathname;

    if (route === '/api/agui' || route === '/api/agui/') return handleAgUi(req, res);
    if (route === '/api/copilot/info' && req.method === 'GET') return handleInfo(req, res, url);

    if (route === '/api/copilot' || route.startsWith('/api/copilot/')) {
      try {
        const handler = await ensureCopilotHandler();
        return await handler(req, res);
      } catch (error) {
        sendJson(res, 503, {
          error: 'copilotkit_unavailable',
          message: 'CopilotKit não está disponível neste ambiente.',
          detail: error?.message || null,
        });
        return;
      }
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  return { handle, ensureCopilotHandler, get ready() { return Boolean(copilotHandler); }, get error() { return copilotInitError; } };
}
