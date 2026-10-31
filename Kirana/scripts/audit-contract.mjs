#!/usr/bin/env node
/**
 * Sonda de contrato: valida CADA requisição que a Kirana envia a
 * /v1/chat/completions contra um contrato estrito no estilo do Gateway v0.2.0
 * (campo desconhecido, content nulo, mensagem malformada, tool schema inválido…).
 *
 * Uso: node scripts/audit-contract.mjs
 * Não é um teste formal — o teste permanente é test/contract.test.js.
 */
import http from 'node:http';

import { loadConfig } from '../src/config.js';
import { createKiranaServer } from '../src/server.js';
import { validateGatewayPayload } from '../src/contract.js';

/* -------------------------------------------------------------------------- */
/* Gateway que valida o contrato e responde qualquer chamada                  */
/* -------------------------------------------------------------------------- */
function startContractGateway(script) {
  const violations = [];
  const requests = [];
  let call = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-6-luna' }, { id: 'gpt-6.1-sol' }] }));
      return;
    }
    if (url.pathname !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const found = validateGatewayPayload(body);
    if (found.length) {
      violations.push({ call: call + 1, errors: found.map((e) => `${e.path}: ${e.message}`) });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_request', message: found.map((e) => `${e.path}: ${e.message}`).join(' | ') } }));
      return;
    }
    requests.push(body);
    const decision = script({ body, callIndex: call }) || {};
    call += 1;

    if (decision.status >= 400) {
      res.writeHead(decision.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: decision.error || 'erro' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    if (decision.toolCalls?.length) {
      res.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { tool_calls: decision.toolCalls.map((c, i) => ({ index: i, id: c.id || `call_${call}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } }],
        })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: decision.text ?? 'ok' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        violations,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function startKirana(gatewayUrl, env = {}) {
  const config = loadConfig({
    KIRANA_GATEWAY_URL: gatewayUrl,
    KIRANA_GATEWAY_API_KEY: 'test-key',
    KIRANA_MODEL_PROBE: 'false',
    KIRANA_LOG_LEVEL: 'error',
    KIRANA_DATA_DIR: `/tmp/kirana-audit-${Date.now()}`,
    KIRANA_PORT: '0',
    ...env,
  });
  const noop = () => {};
  const logger = { error: noop, warn: noop, info: noop, debug: noop, redact: (v) => v, child: () => logger };
  const app = createKiranaServer({ config, logger });
  await app.listen();
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, close: () => app.close() };
}

async function ssePost(base, path, payload) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const events = text
    .split('\n\n')
    .map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    .filter((d) => d && d !== '[DONE]')
    .map((d) => { try { return JSON.parse(d); } catch { return null; } })
    .filter(Boolean);
  return { status: response.status, events };
}

const scenarios = [];
const record = (name, ok, detail = '') => scenarios.push({ name, ok, detail });

/* ------------------------------- cenários -------------------------------- */
const lastUser = (body) => {
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    if (body.messages[i].role === 'user') return String(body.messages[i].content || '');
  }
  return '';
};
const alreadyCalled = (body) => body.messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);

const gateway = await startContractGateway(({ body }) => {
  const text = lastUser(body);
  if (/fallback/i.test(text) && body.model === 'gpt-6-luna') return { status: 500, error: 'luna indisponível' };
  if (alreadyCalled(body)) return { text: 'Resposta após a ferramenta.' };
  if (/registrar interesse/i.test(text)) {
    return {
      toolCalls: [
        { name: 'registrar_interesse_comercial', args: { nome: 'Ana Demo', canal_tipo: 'email', canal_valor: 'ana@exemplo.com', interesse: 'Atendimento', consentimento: true } },
      ],
    };
  }
  if (/ferramenta desconhecida/i.test(text)) {
    return { toolCalls: [{ name: 'executar_comando', args: { cmd: 'rm -rf /' } }] };
  }
  if (/servi|whatsapp/i.test(text)) {
    return { toolCalls: [{ name: 'consultar_servicos', args: { consulta: 'whatsapp' } }] };
  }
  if (/abortar/i.test(text)) return { text: 'início de resposta ' };
  return { text: 'Resposta do modelo.' };
});

try {
  const kirana = await startKirana(gateway.url);
  // Sessão 1: conversa + ferramenta de leitura + vários turnos
  let session = await (await fetch(`${kirana.base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  for (const message of ['Oi', 'Quais serviços?', 'E sobre WhatsApp?', 'Continuando o assunto', 'Mais uma pergunta']) {
    const run = await ssePost(kirana.base, '/api/chat', { sessionId: session.id, message });
    record(`turno: ${message}`, run.status === 200 && !run.events.some((e) => e.type === 'error'), `status ${run.status}`);
  }

  // Sessão 2: ferramenta de escrita + confirmação
  session = await (await fetch(`${kirana.base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const writeRun = await ssePost(kirana.base, '/api/chat', { sessionId: session.id, message: 'Quero registrar interesse' });
  const action = writeRun.events.find((e) => e.type === 'confirmation')?.action;
  record('escrita: pede confirmação', Boolean(action), action ? 'ok' : 'sem ação');
  if (action) {
    const confirmed = await ssePost(kirana.base, '/api/chat/confirm', { sessionId: session.id, actionId: action.id, approve: true });
    record('escrita: confirmação executada', confirmed.status === 200 && !confirmed.events.some((e) => e.type === 'error'));
  }

  // Sessão 3: memória
  session = await (await fetch(`${kirana.base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  await fetch(`${kirana.base}/api/memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'nome', value: 'Ana', consent: true }),
  });
  const memRun = await ssePost(kirana.base, '/api/chat', { sessionId: session.id, message: 'O que você sabe sobre mim?' });
  record('memória: turno com memória no prompt', memRun.status === 200 && !memRun.events.some((e) => e.type === 'error'));

  // Sessão 5: ferramenta desconhecida pedida pelo modelo
  session = await (await fetch(`${kirana.base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const unknownRun = await ssePost(kirana.base, '/api/chat', { sessionId: session.id, message: 'Tente usar uma ferramenta desconhecida' });
  record('ferramenta desconhecida recusada', unknownRun.status === 200 && unknownRun.events.some((e) => e.type === 'tool_result' && e.ok === false));

  // Sessão 6: fallback Luna → Sol
  session = await (await fetch(`${kirana.base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const fbRun = await ssePost(kirana.base, '/api/chat', { sessionId: session.id, message: 'Teste de fallback' });
  const fbDone = fbRun.events.find((e) => e.type === 'done');
  record('fallback acionado', Boolean(fbDone?.fallbackUsed), `modelo final ${fbDone?.model}`);

  // Sessão 7: interrupção e continuação da conversa
  session = await (await fetch(`${kirana.base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const controller = new AbortController();
  const abortPromise = fetch(`${kirana.base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, message: 'Pode abortar esta resposta' }),
    signal: controller.signal,
  }).catch(() => null);
  setTimeout(() => controller.abort(), 30);
  await abortPromise;
  const afterAbort = await ssePost(kirana.base, '/api/chat', { sessionId: session.id, message: 'Continuando depois da interrupção' });
  record('retomada após interrupção', afterAbort.status === 200 && !afterAbort.events.some((e) => e.type === 'error'));

  // Sessão 4: mensagem longa + caracteres especiais
  session = await (await fetch(`${kirana.base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const longRun = await ssePost(kirana.base, '/api/chat', {
    sessionId: session.id,
    message: `Teste com acentos, emoji 🙂, aspas "duplas", barra \\ e quebra\nde linha. ${'palavra '.repeat(200)}`,
  });
  record('mensagem longa/acentuada', longRun.status === 200 && !longRun.events.some((e) => e.type === 'error'));

  await kirana.close();
} finally {
  await gateway.close();
}

/* -------------------------------- relatório ------------------------------- */
console.log('\n=== Sonda de contrato do payload ===\n');
for (const item of scenarios) {
  console.log(`  ${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`);
}
console.log(`\nRequisições válidas enviadas ao gateway: ${gateway.requests.length}`);
console.log(`Violações de contrato: ${gateway.violations.length}`);
if (gateway.violations.length) {
  for (const violation of gateway.violations) {
    console.log(`  ✗ chamada #${violation.call}`);
    for (const error of violation.errors) console.log(`      - ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log('Nenhuma violação: todo payload enviado respeita o contrato estrito.');
}
