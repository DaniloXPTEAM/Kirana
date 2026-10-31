/**
 * Contrato do payload do Gateway v0.2.0 — regressão permanente.
 *
 * Origem: em 24/10/2026 o gateway recusou `temperature` com HTTP 400
 * `unsupported_parameter`. Ao auditar o restante do payload apareceram mais
 * dois problemas da mesma família:
 *   - `content: null` em mensagens de assistente com tool_calls;
 *   - histórico com chamada de ferramenta sem resposta (após limite de rodadas).
 *
 * Estes testes exercitam o caminho COMPLETO (agente → gateway) e falham se
 * qualquer requisição sair fora do contrato.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { validateGatewayPayload } from '../src/contract.js';
import { loadConfig } from '../src/config.js';
import { createGatewayClient } from '../src/gateway.js';
import { silentLogger, startKirana, postSse } from './helpers.js';

/* -------------------------------------------------------------------------- */
/* 1. Validador                                                               */
/* -------------------------------------------------------------------------- */

const baseMessages = () => [
  { role: 'system', content: 'Você é Kirana.' },
  { role: 'user', content: 'Oi' },
];

test('validador aceita o payload mínimo esperado', () => {
  assert.deepEqual(validateGatewayPayload({ model: 'gpt-6-luna', messages: baseMessages(), stream: true }), []);
});

test('validador recusa temperature e demais campos opt-in', () => {
  const errors = validateGatewayPayload({ model: 'm', messages: baseMessages(), stream: true, temperature: 0.6 });
  assert.ok(errors.some((e) => /temperature/.test(e.message)));

  const allowed = validateGatewayPayload({ model: 'm', messages: baseMessages(), stream: true, temperature: 0.6 }, { allowOptInFields: true });
  assert.deepEqual(allowed, []);
});

test('validador recusa content null em mensagem com tool_calls', () => {
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
  ];
  const errors = validateGatewayPayload({ model: 'm', messages, stream: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /null/);
});

test('validador recusa mensagem de ferramenta sem tool_call_id ou vazia', () => {
  const noId = validateGatewayPayload({
    model: 'm',
    messages: [{ role: 'system', content: 's' }, { role: 'tool', content: '{}' }],
    stream: true,
  });
  assert.ok(noId.some((e) => /tool_call_id/.test(e.message)));

  const empty = validateGatewayPayload({
    model: 'm',
    messages: [{ role: 'system', content: 's' }, { role: 'tool', tool_call_id: 'c1', content: '   ' }],
    stream: true,
  });
  assert.ok(empty.some((e) => /vazio/.test(e.message)));
});

test('validador recusa assistant vazio, chaves internas e argumentos inválidos', () => {
  const emptyAssistant = validateGatewayPayload({
    model: 'm',
    messages: [{ role: 'system', content: 's' }, { role: 'assistant', content: '' }],
    stream: true,
  });
  assert.ok(emptyAssistant.some((e) => /content vazio/.test(e.message)));

  const internalKey = validateGatewayPayload({
    model: 'm',
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'oi', ttftMs: 12 }],
    stream: true,
  });
  assert.ok(internalKey.some((e) => /chave não permitida/.test(e.message)));

  const badArgs = validateGatewayPayload({
    model: 'm',
    messages: [
      { role: 'system', content: 's' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: 'não-json' } }] },
    ],
    stream: true,
  });
  assert.ok(badArgs.some((e) => /JSON válido/.test(e.message)));
});

test('validador recusa tool schema incompleto', () => {
  const errors = validateGatewayPayload({
    model: 'm',
    messages: baseMessages(),
    stream: true,
    tools: [{ type: 'function', function: { name: 'x', parameters: { type: 'object', properties: {} } } }],
  });
  assert.ok(errors.some((e) => /description obrigatória/.test(e.message)));

  const wrongParameters = validateGatewayPayload({
    model: 'm',
    messages: baseMessages(),
    stream: true,
    tools: [{ type: 'function', function: { name: 'x', description: 'd', parameters: { properties: {} } } }],
  });
  assert.ok(wrongParameters.some((e) => /parameters.type/.test(e.message)));
});

test('validador exige system apenas quando pedido (invariante do agente)', () => {
  const payload = { model: 'm', messages: [{ role: 'user', content: 'oi' }], stream: true };
  assert.deepEqual(validateGatewayPayload(payload), []);
  assert.equal(validateGatewayPayload(payload, { requireSystemPrompt: true }).length, 1);
});

/* -------------------------------------------------------------------------- */
/* 2. Barreira local no cliente do gateway                                     */
/* -------------------------------------------------------------------------- */

test('gateway bloqueia payload inválido antes de qualquer requisição', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const client = createGatewayClient({
      config: loadConfig({ KIRANA_GATEWAY_URL: `http://127.0.0.1:${port}`, KIRANA_GATEWAY_API_KEY: 'k' }),
      logger: silentLogger,
    });
    await assert.rejects(
      () =>
        client.chatStream({
          // mensagem de ferramenta sem tool_call_id: sanitização não consegue corrigir
          messages: [{ role: 'system', content: 's' }, { role: 'tool', content: '{}' }],
          model: 'gpt-6-luna',
        }),
      (error) => error.code === 'gateway_contract_error' && error.retryable === false,
    );
    assert.equal(hits, 0, 'nada deve ser enviado ao gateway');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* -------------------------------------------------------------------------- */
/* 3. Fim a fim: nenhuma requisição do agente pode violar o contrato           */
/* -------------------------------------------------------------------------- */

function startValidatingGateway(script) {
  const violations = [];
  const requests = [];

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
      violations.push(found);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_request', message: found.map((f) => f.message).join(' | ') } }));
      return;
    }

    requests.push(body);
    const decision = (await script({ body })) || {};
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });

    if (decision.toolCalls?.length) {
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: decision.toolCalls.map((call, index) => ({
                  index,
                  id: call.id || `call_${requests.length}_${index}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                })),
              },
            },
          ],
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
    server.listen(0, '127.0.0.1', async () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        violations,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const lastUserText = (body) => {
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    if (body.messages[i].role === 'user') return String(body.messages[i].content || '');
  }
  return '';
};
/** Ferramenta já usada NESTE turno (não em turnos anteriores da sessão). */
const alreadyUsedTool = (body) => {
  const roles = body.messages.map((m) => m.role);
  const lastUser = roles.lastIndexOf('user');
  return body.messages.slice(lastUser).some((m) => m.role === 'assistant' && m.tool_calls?.length);
};

async function newSession(base) {
  const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return response.json();
}

test('fluxos reais não produzem nenhuma violação de contrato', async () => {
  const gateway = await startValidatingGateway(({ body }) => {
    const text = lastUserText(body);
    if (/ferramenta desconhecida/i.test(text) && !alreadyUsedTool(body)) return { toolCalls: [{ name: 'executar_comando', args: { cmd: 'ls' } }] };
    if (alreadyUsedTool(body)) return { text: 'Resposta após ferramenta.' };
    if (/registrar interesse/i.test(text)) {
      return {
        toolCalls: [
          {
            name: 'registrar_interesse_comercial',
            args: { nome: 'Ana Demo', canal_tipo: 'email', canal_valor: 'ana@exemplo.com', interesse: 'Atendimento', consentimento: true },
          },
        ],
      };
    }
    if (/servi/i.test(text)) return { toolCalls: [{ name: 'consultar_servicos', args: { consulta: 'whatsapp' } }] };
    if (/várias ferramentas/i.test(text)) {
      return {
        toolCalls: [
          { name: 'consultar_servicos', args: { consulta: 'crm' } },
          { name: 'consultar_produtos', args: { consulta: 'crm' } },
        ],
      };
    }
    return { text: 'Resposta do modelo.' };
  });

  const kirana = await startKirana({ gatewayUrl: gateway.url, env: { KIRANA_MODEL_PROBE: 'false' } });
  try {
    // Conversa em vários turnos, com ferramenta de leitura no meio.
    let session = await newSession(kirana.base);
    for (const message of ['Oi', 'Quais serviços vocês têm?', 'E sobre atendimento?', 'Obrigado']) {
      const run = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message });
      assert.equal(run.ok, true, `turno "${message}" deveria responder`);
      assert.equal(run.events.some((e) => e.type === 'error'), false, `turno "${message}" não deveria falhar`);
    }

    // Escrita com confirmação.
    session = await newSession(kirana.base);
    const write = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Quero registrar interesse' });
    const action = write.events.find((e) => e.type === 'confirmation')?.action;
    assert.ok(action, 'deve pedir confirmação');
    const confirmed = await postSse(kirana.base, '/api/chat/confirm', { sessionId: session.id, actionId: action.id, approve: true });
    assert.equal(confirmed.events.some((e) => e.type === 'error'), false);

    // Ferramenta desconhecida + continuação da conversa.
    const unknown = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Use uma ferramenta desconhecida' });
    assert.ok(unknown.events.some((e) => e.type === 'tool_result' && e.errorCode === 'unknown_tool'), 'deve avisar o usuário');
    const after = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Continuando' });
    assert.equal(after.events.some((e) => e.type === 'error'), false);

    // Duas ferramentas na mesma rodada.
    const two = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Consulte várias ferramentas' });
    assert.equal(two.events.some((e) => e.type === 'error'), false);

    // Memória no prompt.
    await fetch(`${kirana.base}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'nome', value: 'Ana', consent: true }),
    });
    const withMemory = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'O que você sabe sobre mim?' });
    assert.equal(withMemory.events.some((e) => e.type === 'error'), false);

    // Interrupção e retomada.
    const controller = new AbortController();
    const aborted = fetch(`${kirana.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, message: 'Pode responder devagar' }),
      signal: controller.signal,
    }).catch(() => null);
    setTimeout(() => controller.abort(), 20);
    await aborted;
    const resumed = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Depois da interrupção' });
    assert.equal(resumed.events.some((e) => e.type === 'error'), false);

    assert.deepEqual(gateway.violations, [], `violações de contrato: ${JSON.stringify(gateway.violations)}`);
    assert.ok(gateway.requests.length >= 8, `esperava várias requisições, houve ${gateway.requests.length}`);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('limite de rodadas de ferramenta não deixa chamada sem resposta', async () => {
  // O gateway sempre pede ferramenta: com limite 0 o turno precisa encerrar
  // respondendo TODAS as chamadas, senão o turno seguinte vira HTTP 400.
  const gateway = await startValidatingGateway(() => ({
    toolCalls: [
      { name: 'consultar_servicos', args: { consulta: 'crm' } },
      { name: 'consultar_produtos', args: { consulta: 'crm' } },
    ],
  }));
  const kirana = await startKirana({
    gatewayUrl: gateway.url,
    env: { KIRANA_MODEL_PROBE: 'false', KIRANA_MAX_TOOL_ROUNDS: '0' },
  });

  try {
    const session = await newSession(kirana.base);
    const first = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Preciso de duas consultas' });
    assert.equal(first.ok, true);

    const stored = await (await fetch(`${kirana.base}/api/session/${session.id}`)).json();
    assert.ok(stored.stats.toolCalls >= 1);

    // O turno seguinte só funciona se o histórico estiver íntegro.
    const second = await postSse(kirana.base, '/api/chat', { sessionId: session.id, message: 'Mais uma pergunta' });
    assert.equal(second.events.some((e) => e.type === 'error'), false);
    assert.deepEqual(gateway.violations, []);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});
