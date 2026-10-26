/** Utilitários compartilhados pelos testes (gateway falso + servidor da Kirana). */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { createKiranaServer } from '../src/server.js';

export const silentLogger = (() => {
  const noop = () => {};
  const logger = { error: noop, warn: noop, info: noop, debug: noop, redact: (v) => v };
  logger.child = () => logger;
  return logger;
})();

/**
 * Gateway falso que respeita o contrato OpenAI/SSE.
 * `script({ body, callIndex })` decide a resposta:
 *   { text }                            -> resposta em texto (streaming)
 *   { toolCalls: [{ name, args, id }] } -> chamada de ferramenta
 *   { status: 500, error: '...' }       -> erro HTTP
 *   { hang: true }                      -> não responde (para testar timeout)
 *
 * `namespaced: true` reproduz o comportamento do Gateway REAL v0.4.x: ele
 * envolve as ferramentas do cliente em um namespace (`gateway`) e devolve os
 * nomes como `gateway.<nome>` (ver `integrations/Kirana-ChatGPT-Gateway-*.zip`,
 * `src/responses.js` → `displayToolName`/`toNamespacedTools`). Sem essa opção o
 * mock devolve o nome cru — e é justamente essa diferença que escondeu o defeito
 * da v0.5.1.
 */
export async function startFakeGateway({ script, apiKey = 'test-key', namespaced = false } = {}) {
  const requests = [];
  let callIndex = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if ((req.headers.authorization || '') !== `Bearer ${apiKey}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
      return;
    }

    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-6-luna' }, { id: 'gpt-6.1-sol' }] }));
      return;
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const decision = (await script({ body, callIndex })) || {};
      callIndex += 1;

      if (decision.hang) return;

      if (decision.status && decision.status >= 400) {
        res.writeHead(decision.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: decision.error || 'erro simulado' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const id = `chatcmpl-${callIndex}`;

      if (decision.toolCalls?.length) {
        const toolCalls = decision.toolCalls.map((call, index) => ({
          index,
          id: call.id || `call_${callIndex}_${index}`,
          type: 'function',
          function: {
            name: namespaced ? `gateway.${call.name}` : call.name,
            arguments: JSON.stringify(call.args ?? {}),
          },
        }));
        // Envia em pedaços para exercitar o parser de SSE.
        res.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: { tool_calls: toolCalls.slice(0, 1) } }] })}\n\n`);
        if (toolCalls.length > 1) {
          res.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: { tool_calls: toolCalls.slice(1) } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const text = decision.text ?? 'ok';
      const pieces = text.match(/\S+\s*/g) || [];
      for (const piece of pieces) {
        res.write(`data: ${JSON.stringify({ id, model: body.model, choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 10 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get calls() {
      return requests.length;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function startKirana({ gatewayUrl, env = {}, overrides = {} } = {}) {
  const dataDir = env.KIRANA_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-test-'));
  const config = loadConfig({
    KIRANA_DATA_DIR: dataDir,
    KIRANA_GATEWAY_URL: gatewayUrl,
    KIRANA_GATEWAY_API_KEY: env.KIRANA_GATEWAY_API_KEY ?? 'test-key',
    KIRANA_HOST: '127.0.0.1',
    KIRANA_PORT: '0',
    KIRANA_MODEL_PROBE: 'false',
    KIRANA_LOG_LEVEL: 'error',
    ...env,
  });
  const app = createKiranaServer({ config, logger: silentLogger, ...overrides });
  await app.listen();
  const { port } = app.server.address();

  return {
    app,
    base: `http://127.0.0.1:${port}`,
    dataDir,
    async close() {
      await app.close();
    },
  };
}

/** Faz uma requisição SSE e devolve os eventos recebidos. */
export async function postSse(base, pathname, payload, { headers = {} } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    return { ok: false, status: response.status, error: error?.error ?? null, events: [] };
  }

  const raw = await response.text();
  const events = raw
    .split(/\n\n/)
    .map((frame) => frame.split(/\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join(''))
    .filter((data) => data && data !== '[DONE]')
    .map((data) => {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return { ok: true, status: response.status, events };
}

export async function getJson(base, pathname, headers = {}) {
  const response = await fetch(`${base}${pathname}`, { headers });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

export function textFrom(events) {
  return events.filter((event) => event.type === 'delta').map((event) => event.text).join('');
}
