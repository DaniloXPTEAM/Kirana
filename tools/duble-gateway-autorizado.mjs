/**
 * DUBLÊ DE GATEWAY AUTORIZADO — só para testar o verificador.
 *
 * Imita o Gateway v0.4.1 **incluindo a validação estrita do corpo**: qualquer
 * campo fora de [model, messages, stream, tools, tool_choice,
 * parallel_tool_calls, stream_options] é rejeitado com
 * `400 unsupported_parameter`, exatamente como `validateChatRequest()` em
 * `Gateway/src/responses.js`. É isso que impede `max_tokens` de voltar sem ser
 * percebido.
 *
 * NÃO é o Gateway. Não fala com nenhum provedor. Nenhum modelo é executado.
 *
 * Uso:  node tools/duble-gateway-autorizado.mjs [porta]   (padrão 1456)
 */
import { createServer } from 'node:http';

const PORTA = Number(process.argv[2] || 1456);
const CAMPOS_ACEITOS = new Set(['model', 'messages', 'stream', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream_options']);
const MODELOS = [{ id: 'modelo-falso-a', object: 'model' }, { id: 'modelo-falso-b', object: 'model' }];
const RUNS = [];

const registrarRun = (modelo) => {
  const run = {
    id: `run_${String(RUNS.length + 1).padStart(6, '0')}`,
    createdAt: new Date().toISOString(),
    modelRequested: modelo, modelReported: modelo, identityVerified: true,
    upstreamId: `resp_duble_${RUNS.length + 1}`, upstreamStatus: 'completed',
    firstUsefulMs: 110, totalMs: 350, toolCalls: 0,
    usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
  };
  RUNS.unshift(run);
  return run;
};

const servidor = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORTA}`);
  const json = (status, dados) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(dados));
  };
  const erro = (status, code, message) => json(status, { error: { message, type: 'gateway_error', code } });

  if (url.pathname === '/health') return json(200, { status: 'ok', authenticated: true, version: '0.4.1', app: 'dublê' });

  if (url.pathname === '/auth/status' && req.method === 'GET') {
    return json(200, { authenticated: true, sharing: true, tokenStorage: 'memory-only', grantedScopes: ['chat'] });
  }

  if (url.pathname === '/v1/engine' && req.method === 'GET') {
    return json(200, {
      object: 'engine',
      gateway: { version: '0.4.1', app: 'dublê', provider: 'siwc-responses', authenticated: true },
      policy: { routing_enabled: false, primary_model: MODELOS[0].id, fallback_model: null, cost_policy: 'plan-only' },
      models: MODELOS, runs_recorded: RUNS.length,
    });
  }

  if (url.pathname === '/v1/capabilities' && req.method === 'GET') {
    return json(200, { object: 'list', data: [
      { name: 'text.chat', ready: true, requires_authentication: true },
      { name: 'files.create', ready: true, requires_authentication: false },
    ] });
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') return json(200, { object: 'list', data: MODELOS });

  if (url.pathname === '/v1/runs' && req.method === 'GET') {
    return json(200, { object: 'list', data: RUNS.slice(0, Number(url.searchParams.get('limit') || 50)) });
  }
  if (url.pathname.startsWith('/v1/runs/') && req.method === 'GET') {
    const run = RUNS.find((r) => r.id === url.pathname.split('/').pop());
    return run ? json(200, run) : erro(404, 'run_not_found', 'Run not found.');
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      let pedido;
      try { pedido = JSON.parse(corpo); } catch { return erro(400, 'invalid_json', 'Request body must be valid JSON.'); }

      // validação estrita — igual ao Gateway real
      if (!pedido || typeof pedido !== 'object' || Array.isArray(pedido)) return erro(400, 'invalid_request', 'Request body must be a JSON object.');
      const fora = Object.keys(pedido).filter((k) => !CAMPOS_ACEITOS.has(k));
      if (fora.length) return erro(400, 'unsupported_parameter', `Unsupported request field: ${fora[0]}. This gateway only forwards validated ChatGPT-plan-compatible fields.`);
      if (typeof pedido.model !== 'string' || !pedido.model) return erro(400, 'invalid_model', 'Provide a model identifier from GET /v1/models.');
      if (!Array.isArray(pedido.messages) || pedido.messages.length < 1 || pedido.messages.length > 100) return erro(400, 'invalid_messages', 'messages must contain 1–100 messages.');
      if (pedido.stream !== undefined && typeof pedido.stream !== 'boolean') return erro(400, 'invalid_stream', 'stream must be boolean.');
      if (!MODELOS.some((m) => m.id === pedido.model)) return erro(400, 'model_not_available', 'Requested model is not in this account’s current ChatGPT plan model list.');

      registrarRun(pedido.model);
      const texto = 'ok';

      if (!pedido.stream) {
        return json(200, {
          id: 'chatcmpl-duble', object: 'chat.completion', model: pedido.model,
          choices: [{ index: 0, message: { role: 'assistant', content: texto }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
        });
      }

      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      const pedacos = ['o', 'k'];
      let i = 0;
      const timer = setInterval(() => {
        if (i < pedacos.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: pedacos[i] }, finish_reason: null }] })}\n\n`);
          i += 1;
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        if (pedido.stream_options?.include_usage) {
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        clearInterval(timer);
        res.end();
      }, 120);
      res.on('close', () => clearInterval(timer));
      return undefined;
    });
    return undefined;
  }

  return erro(404, 'not_found', 'Unknown local gateway route.');
});

servidor.listen(PORTA, '127.0.0.1', () => console.log(`dublê de gateway autorizado em http://127.0.0.1:${PORTA} (contrato estrito, nenhum modelo real)`));
