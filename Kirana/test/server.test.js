/** Testes de integração: servidor da Kirana + gateway falso (SSE real por HTTP). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startFakeGateway, startKirana, postSse, getJson, textFrom } from './helpers.js';

async function newSession(base, headers = {}) {
  const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  return response.json();
}

test('GET /health responde ok', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { status, body } = await getJson(kirana.base, '/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('a interface é servida com cabeçalhos de segurança e sem chave', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const response = await fetch(`${kirana.base}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Kirana/);
    assert.ok(response.headers.get('content-security-policy'));
    assert.equal(html.includes('test-key'), false);

    const config = await getJson(kirana.base, '/api/config');
    const serialized = JSON.stringify(config.body);
    assert.equal(serialized.includes('test-key'), false);
    assert.equal(config.body.models.primary, 'gpt-6-luna');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('conversa completa com streaming preserva contexto', async () => {
  const gateway = await startFakeGateway({
    script: ({ callIndex }) => ({ text: callIndex === 0 ? 'Olá! Eu sou a Kirana.' : 'Você perguntou sobre serviços.' }),
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const session = await newSession(kirana.base);

    const first = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Oi, tudo bem?' });
    assert.equal(first.ok, true);
    assert.equal(textFrom(first.events), 'Olá! Eu sou a Kirana.');
    const done = first.events.find((e) => e.type === 'done');
    assert.ok(done);
    assert.equal(done.model, 'gpt-6-luna');
    assert.ok(done.totalMs > 0);

    await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Quais serviços vocês têm?' });

    // O segundo turno deve levar o histórico do primeiro.
    const secondRequest = gateway.requests[1];
    const contents = secondRequest.messages.map((m) => m.content).join(' | ');
    assert.match(contents, /Oi, tudo bem\?/);
    assert.match(contents, /Olá! Eu sou a Kirana\./);
    assert.equal(secondRequest.messages[0].role, 'system');
    assert.match(secondRequest.messages[0].content, /Kirana/);

    // Regressão do Gateway v0.2.0: nenhum campo fora do contrato pode sair.
    for (const request of gateway.requests) {
      assert.equal('temperature' in request, false, 'temperature não deve ser enviado ao gateway');
      assert.equal('parallel_tool_calls' in request, false);
      assert.equal('max_tokens' in request, false);
      const allowed = ['model', 'messages', 'stream', 'tools'];
      for (const field of Object.keys(request)) assert.ok(allowed.includes(field), `campo inesperado no payload: ${field}`);
    }

    const { body } = await getJson(kirana.base, `/api/session/${session.id}`);
    assert.equal(body.messages.length, 4);
    assert.equal(body.messages[0].role, 'user');
    assert.ok(body.stats.turns >= 2);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('ciclo completo de ferramenta de leitura', async () => {
  let calls = 0;
  const gateway = await startFakeGateway({
    script: () => {
      calls += 1;
      if (calls === 1) return { toolCalls: [{ name: 'consultar_servicos', args: { consulta: 'whatsapp' } }] };
      return { text: 'Encontrei o serviço de atendimento digital e WhatsApp.' };
    },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const session = await newSession(kirana.base);
    const run = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Quais serviços vocês têm para WhatsApp?' });

    assert.equal(run.ok, true);
    const types = run.events.map((e) => e.type);
    assert.ok(types.includes('tool_start'));
    const toolResult = run.events.find((e) => e.type === 'tool_result');
    assert.equal(toolResult.ok, true);
    assert.equal(toolResult.name, 'consultar_servicos');
    assert.match(textFrom(run.events), /atendimento digital/);

    // O resultado da ferramenta precisa chegar ao modelo no segundo round.
    const secondMessages = gateway.requests[1].messages;
    const toolMessage = secondMessages.find((m) => m.role === 'tool');
    assert.ok(toolMessage);
    assert.match(toolMessage.content, /atendimento/);
    assert.ok(secondMessages.some((m) => m.role === 'assistant' && m.tool_calls?.length));

    const { body } = await getJson(kirana.base, `/api/session/${session.id}`);
    assert.ok(body.stats.toolCalls >= 1);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('ferramenta de escrita só executa após confirmação', async () => {
  let calls = 0;
  const gateway = await startFakeGateway({
    script: () => {
      calls += 1;
      if (calls === 1) {
        return {
          toolCalls: [
            {
              name: 'registrar_interesse_comercial',
              args: {
                nome: 'Ana Demo',
                canal_tipo: 'email',
                canal_valor: 'ana@exemplo.com',
                interesse: 'Atendimento no WhatsApp',
                consentimento: true,
              },
            },
          ],
        };
      }
      if (calls === 2) return { text: 'Preparei o registro. Confirma para eu concluir?' };
      return { text: 'Registrado localmente com protocolo INT-TESTE.' };
    },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const session = await newSession(kirana.base);
    const run = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Quero falar com a equipe sobre atendimento.' });

    const confirmation = run.events.find((e) => e.type === 'confirmation');
    assert.ok(confirmation, 'deve emitir evento de confirmação');
    assert.match(confirmation.action.summary, /Ana Demo/);

    // Nada foi gravado ainda.
    assert.equal(fs.existsSync(path.join(kirana.dataDir, 'interests.jsonl')), false);

    const { body: pending } = await getJson(kirana.base, `/api/session/${session.id}`);
    assert.equal(pending.pendingAction.id, confirmation.action.id);

    const confirmed = await postSse(kirana.base, '/api/chat/confirm', {
      sessionId: session.id,
      actionId: confirmation.action.id,
      approve: true,
    });
    assert.equal(confirmed.ok, true);
    const toolResult = confirmed.events.find((e) => e.type === 'tool_result');
    assert.equal(toolResult.executed, true);
    assert.equal(toolResult.ok, true);

    const interestLines = fs
      .readFileSync(path.join(kirana.dataDir, 'interests.jsonl'), 'utf8')
      .trim()
      .split('\n');
    assert.equal(interestLines.length, 1);
    const record = JSON.parse(interestLines[0]);
    assert.equal(record.nome, 'Ana Demo');
    assert.equal(record.envio_externo, false);
    assert.match(record.protocolo, /^INT-/);

    const { body: after } = await getJson(kirana.base, `/api/session/${session.id}`);
    assert.equal(after.pendingAction, null);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('recusar a confirmação não grava nada', async () => {
  let calls = 0;
  const gateway = await startFakeGateway({
    script: () => {
      calls += 1;
      if (calls === 1) {
        return {
          toolCalls: [
            {
              name: 'salvar_memoria',
              args: { chave: 'nome', valor: 'Ana' },
            },
          ],
        };
      }
      return { text: 'Quer que eu guarde seu nome?' };
    },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const session = await newSession(kirana.base);
    const run = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Meu nome é Ana, lembre disso.' });
    const action = run.events.find((e) => e.type === 'confirmation').action;

    const declined = await postSse(kirana.base, '/api/chat/confirm', {
      sessionId: session.id,
      actionId: action.id,
      approve: false,
    });
    assert.equal(declined.ok, true);
    assert.equal(declined.events.find((e) => e.type === 'done').resolved, 'declined');

    const { body } = await getJson(kirana.base, '/api/memory');
    assert.equal(body.items.length, 0);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('ação pendente expirada é recusada', async () => {
  let calls = 0;
  const gateway = await startFakeGateway({
    script: () => {
      calls += 1;
      if (calls === 1) return { toolCalls: [{ name: 'salvar_memoria', args: { chave: 'cidade', valor: 'Fortaleza' } }] };
      return { text: 'ok' };
    },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const session = await newSession(kirana.base);
    const run = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Lembre que moro em Fortaleza.' });
    const action = run.events.find((e) => e.type === 'confirmation').action;

    // Expira manualmente a ação no arquivo da sessão.
    const stored = kirana.app.sessions.get(session.id);
    stored.pendingAction.expiresAt = new Date(Date.now() - 1000).toISOString();
    kirana.app.sessions.save(stored);

    const response = await postSse(kirana.base, '/api/chat/confirm', { sessionId: session.id, actionId: action.id, approve: true });
    assert.equal(response.ok, true);
    const error = response.events.find((e) => e.type === 'error');
    assert.equal(error.code, 'action_expired');

    const { body } = await getJson(kirana.base, '/api/memory');
    assert.equal(body.items.length, 0);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('fallback de modelo quando o primário falha antes do primeiro token', async () => {
  const models = [];
  const gateway = await startFakeGateway({
    script: ({ body }) => {
      models.push(body.model);
      if (body.model === 'gpt-6-luna') return { status: 500, error: 'luna fora do ar' };
      return { text: 'Resposta do modelo alternativo.' };
    },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const session = await newSession(kirana.base);
    const run = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'oi' });
    assert.deepEqual(models.slice(0, 2), ['gpt-6-luna', 'gpt-6.1-sol']);
    assert.equal(textFrom(run.events), 'Resposta do modelo alternativo.');
    const done = run.events.find((e) => e.type === 'done');
    assert.equal(done.fallbackUsed, true);
    assert.ok(run.events.some((e) => e.type === 'status' && e.stage === 'retry'));
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('erro do gateway vira mensagem compreensível, sem travar', async () => {
  const gateway = await startFakeGateway({ script: () => ({ status: 401, error: 'unauthorized' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const session = await newSession(kirana.base);
    const run = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'oi' });
    const error = run.events.find((e) => e.type === 'error');
    assert.ok(error);
    assert.match(error.message, /chave|gateway/i);
    // 401 do gateway falso vem sem `error.code`: a Kirana não adivinha a causa
    // (revisão 3, item B) — relata como não conclusivo e aponta o diagnóstico.
    assert.equal(error.code, 'gateway_auth_unknown');
    assert.match(error.message, /diagnosticar-modelos|não vou adivinhar/i);

    // A sessão continua utilizável.
    const { status } = await getJson(kirana.base, `/api/session/${session.id}`);
    assert.equal(status, 200);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('validações de entrada da API', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const noSession = await postSse(kirana.base, '/api/chat', { message: 'oi' });
    assert.equal(noSession.status, 400);
    assert.equal(noSession.error.code, 'missing_session');

    const unknown = await postSse(kirana.base, '/api/chat', { sessionId: 's_inexistente', message: 'oi' });
    assert.equal(unknown.status, 404);

    const emptyMessage = await newSession(kirana.base);
    const empty = await postSse(kirana.base, '/api/chat', { sessionId: emptyMessage.id, message: '   ' });
    assert.equal(empty.status, 400);

    const badJson = await fetch(`${kirana.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{nao-e-json',
    });
    assert.equal(badJson.status, 400);

    const notFound = await getJson(kirana.base, '/api/session/s_naoexiste');
    assert.equal(notFound.status, 404);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('rate limiting responde 429', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: { KIRANA_RATE_LIMIT_MAX: '1' } });
  try {
    const session = await newSession(kirana.base);
    const first = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'primeira' });
    assert.equal(first.ok, true);
    const second = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'segunda' });
    assert.equal(second.status, 429);
    assert.equal(second.error.code, 'rate_limited');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('token de acesso é exigido quando configurado', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env: { KIRANA_ACCESS_TOKEN: 'segredo-local' } });
  try {
    const session = await newSession(kirana.base);

    const blocked = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'oi' });
    assert.equal(blocked.status, 401);

    const allowed = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'oi' }, {
      headers: { 'X-Kirana-Token': 'segredo-local' },
    });
    assert.equal(allowed.ok, true);
    assert.equal(textFrom(allowed.events), 'ok');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('origem diferente é bloqueada nas rotas de chat', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const session = await newSession(kirana.base);
    const response = await fetch(`${kirana.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://site-malicioso.example' },
      body: JSON.stringify({ sessionId: session.id, message: 'oi' }),
    });
    assert.equal(response.status, 403);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('memória via API exige consentimento e permite exclusão', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const withoutConsent = await fetch(`${kirana.base}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'nome', value: 'Ana' }),
    });
    assert.equal(withoutConsent.status, 400);

    const created = await fetch(`${kirana.base}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'nome', value: 'Ana', consent: true }),
    });
    assert.equal(created.status, 201);
    const { item } = await created.json();

    const list = await getJson(kirana.base, '/api/memory');
    assert.equal(list.body.items.length, 1);

    const removed = await fetch(`${kirana.base}/api/memory/${item.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const after = await getJson(kirana.base, '/api/memory');
    assert.equal(after.body.items.length, 0);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('listagem de ferramentas e status do gateway', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const tools = await getJson(kirana.base, '/api/tools');
    assert.ok(tools.body.tools.length >= 4);
    assert.ok(tools.body.tools.every((t) => ['read', 'write'].includes(t.kind)));

    const status = await getJson(kirana.base, '/api/status');
    assert.equal(status.body.gateway.reachable, true);
    assert.equal(status.body.model.active, 'gpt-6-luna');
    assert.equal(JSON.stringify(status.body).includes('test-key'), false);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});
