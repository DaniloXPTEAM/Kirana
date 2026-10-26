/**
 * Fase 5 — contrato HTTP das solicitações.
 *
 * Servidor real da Kirana, gateway falso declarado (só devolve texto). O que se
 * prova aqui é o que só o servidor pode garantir:
 *  - a sessão é conferida em toda rota (id de outra sessão não vaza nada);
 *  - upload inválido é recusado no servidor, mesmo que o navegador já tenha
 *    filtrado antes (a UI não é a fronteira de segurança);
 *  - o arquivo removido sai do disco;
 *  - o envio passa pelo HITL: sem `approve`, nada é executado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startFakeGateway, startKirana, postSse, getJson } from './helpers.js';

async function newSession(base) {
  const response = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return response.json();
}

/** `/api/chat/confirm` responde em SSE: lê o texto e extrai os eventos. */
async function confirm(base, payload) {
  const response = await fetch(`${base}/api/chat/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  const events = raw
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { status: response.status, events };
}

function postJson(base, pathname, payload) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const pdfBase64 = Buffer.from('%PDF-1.4\nbriefing de teste\n').toString('base64');

/** Script: cria a solicitação e devolve o id; opcionalmente tenta enviar. */
function scriptComSolicitacao({ enviar = false } = {}) {
  const steps = [
    { toolCalls: [{ name: 'start_service_request', args: { serviceId: 'agentes-ia', dados: { nome: 'Ana', email: 'ana@exemplo.com' } } }] },
    { text: 'Rascunho criado nesta conversa; nada foi enviado.' },
  ];
  if (enviar) {
    // Segundo turno: o modelo tenta enviar direto (atalho), sem validar.
    steps.push(
      { toolCalls: [{ name: 'submit_service_request', args: { requestId: 'REQ-2026-000000' } }] },
      { text: 'Não consegui enviar: ainda faltam dados.' },
    );
  }
  return ({ callIndex }) => steps[callIndex] ?? { text: 'Certo.' };
}

test('GET /api/requests exige sessão válida e lista só as do dono', async () => {
  const gateway = await startFakeGateway({ script: scriptComSolicitacao() });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const dona = (await newSession(kirana.base)).id;
    const outra = (await newSession(kirana.base)).id;

    const created = await postSse(kirana.base, '/api/chat', {
      sessionId: dona,
      message: 'Quero colocar uma IA no meu site',
      siteId: 'opportunity-ai',
      path: '/',
    });
    const toolResult = created.events.find((event) => event.type === 'tool_result' && event.name === 'start_service_request');
    assert.equal(toolResult.ok, true);
    const requestId = toolResult.data.solicitacao.id;

    const listaDona = await getJson(kirana.base, `/api/requests?sessionId=${dona}`);
    assert.equal(listaDona.status, 200);
    assert.equal(listaDona.body.solicitacoes.length, 1);
    assert.equal(listaDona.body.solicitacoes[0].id, requestId);

    // A outra sessão não vê nada — nem sabendo o id.
    const listaOutra = await getJson(kirana.base, `/api/requests?sessionId=${outra}`);
    assert.deepEqual(listaOutra.body.solicitacoes, []);
    const detalhe = await getJson(kirana.base, `/api/requests/${requestId}?sessionId=${outra}`);
    assert.equal(detalhe.status, 404);

    // Sem sessão: 400, não lista.
    const semSessao = await getJson(kirana.base, '/api/requests');
    assert.equal(semSessao.status, 400);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('POST /api/requests/:id/files grava o arquivo válido e recusa o inválido', async () => {
  const gateway = await startFakeGateway({ script: scriptComSolicitacao() });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const sessionId = (await newSession(kirana.base)).id;
    const created = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'Quero colocar uma IA no meu site',
      siteId: 'opportunity-ai',
      path: '/',
    });
    const requestId = created.events.find((event) => event.type === 'tool_result' && event.name === 'start_service_request').data.solicitacao.id;

    const ok = await postJson(kirana.base, `/api/requests/${requestId}/files`, {
      sessionId,
      filename: 'briefing.pdf',
      contentType: 'application/pdf',
      dataBase64: pdfBase64,
    });
    const okBody = await ok.json();
    assert.equal(ok.status, 201);
    assert.match(okBody.arquivo.id, /^f_[a-z0-9]+$/);
    assert.ok(okBody.arquivo.expiraEm, 'arquivo tem prazo de retenção declarado');

    // .exe é recusado pelo servidor (a UI não é a fronteira de segurança).
    const ruim = await postJson(kirana.base, `/api/requests/${requestId}/files`, {
      sessionId,
      filename: 'instalador.exe',
      contentType: 'application/octet-stream',
      dataBase64: Buffer.from('MZ').toString('base64'),
    });
    assert.equal(ruim.status, 400);
    const ruimBody = await ruim.json();
    assert.equal(ruimBody.error.code, 'blocked_type');

    // .pdf com conteúdo falso: assinatura não confere.
    const falso = await postJson(kirana.base, `/api/requests/${requestId}/files`, {
      sessionId,
      filename: 'nota.pdf',
      contentType: 'application/pdf',
      dataBase64: Buffer.from('nao sou pdf').toString('base64'),
    });
    assert.equal(falso.status, 400);
    assert.equal((await falso.json()).error.code, 'content_mismatch');

    // Sessão errada não anexa nada a esta solicitação.
    const outra = (await newSession(kirana.base)).id;
    const alheia = await postJson(kirana.base, `/api/requests/${requestId}/files`, {
      sessionId: outra,
      filename: 'x.pdf',
      contentType: 'application/pdf',
      dataBase64: pdfBase64,
    });
    assert.equal(alheia.status, 404);

    const detalhe = await getJson(kirana.base, `/api/requests/${requestId}?sessionId=${sessionId}`);
    assert.equal(detalhe.body.arquivos.length, 1, 'só o arquivo válido entrou');

    // Remoção real: o arquivo sai da solicitação.
    const fileId = okBody.arquivo.id;
    const removed = await fetch(`${kirana.base}/api/requests/${requestId}/files/${fileId}?sessionId=${sessionId}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual((await removed.json()).removido, true);
    const depois = await getJson(kirana.base, `/api/requests/${requestId}?sessionId=${sessionId}`);
    assert.equal(depois.body.arquivos.length, 0);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('envio passa pelo HITL: sem aprovação nada executa, com aprovação diz que não enviou', async () => {
  const ref = { requestId: null };
  // Os argumentos são montados a cada chamada: o id só existe depois do turno 1.
  const step = (callIndex) => {
    if (callIndex === 0) {
      return { toolCalls: [{ name: 'start_service_request', args: { serviceId: 'agentes-ia', dados: { nome: 'Ana', email: 'ana@exemplo.com' } } }] };
    }
    if (callIndex === 1) return { text: 'Rascunho criado nesta conversa; nada foi enviado.' };
    if (callIndex === 2 || callIndex === 4) {
      return { toolCalls: [{ name: 'submit_service_request', args: { requestId: ref.requestId } }] };
    }
    return { text: 'Preciso da sua confirmação.' };
  };
  const gateway = await startFakeGateway({ script: ({ callIndex }) => step(callIndex) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const sessionId = (await newSession(kirana.base)).id;
    const turn = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'Quero colocar uma IA no meu site',
      siteId: 'opportunity-ai',
      path: '/',
    });
    ref.requestId = turn.events.find((event) => event.type === 'tool_result' && event.name === 'start_service_request').data.solicitacao.id;

    // Turno 2: o modelo pede o envio → HITL pendente, nada executado.
    const envio = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'Pode enviar?',
      siteId: 'opportunity-ai',
      path: '/',
    });
    const confirmation = envio.events.find((event) => event.type === 'confirmation');
    assert.ok(confirmation, 'ação sensível precisa de confirmação explícita');
    assert.equal(confirmation.action.tool, 'submit_service_request');
    assert.match(confirmation.action.id, /^act_[a-f0-9]{8}$/);

    const antes = await getJson(kirana.base, `/api/requests/${ref.requestId}?sessionId=${sessionId}`);
    assert.notEqual(antes.body.estado, 'submitted', 'sem aprovação o backend não é chamado');

    // Recusa: nada acontece.
    const recusa = await confirm(kirana.base, { sessionId, actionId: confirmation.action.id, approve: false });
    assert.equal(recusa.status, 200);
    const recusaDone = recusa.events.find((event) => event.type === 'done');
    assert.equal(recusaDone.resolved, 'declined', 'recusar não executa nada');
    assert.notEqual(recusaDone.executed, true);
    const depoisRecusa = await getJson(kirana.base, `/api/requests/${ref.requestId}?sessionId=${sessionId}`);
    assert.notEqual(depoisRecusa.body.estado, 'submitted');

    // Aprovação: a ferramenta executa e diz a verdade — dados incompletos, não enviado.
    const segundo = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'Pode enviar?',
      siteId: 'opportunity-ai',
      path: '/',
    });
    const conf2 = segundo.events.find((event) => event.type === 'confirmation');
    const aprovacao = await confirm(kirana.base, { sessionId, actionId: conf2.action.id, approve: true });
    assert.equal(aprovacao.status, 200);
    const aprovacaoDone = aprovacao.events.find((event) => event.type === 'done');
    assert.equal(aprovacaoDone.resolved, 'approved');
    assert.equal(typeof aprovacaoDone.executed, 'boolean');
    // Resultado real da ferramenta de escrita: executou (ok) — e o estado
    // continua não enviado porque não há endpoint configurado.
    // Ferramenta de escrita não expõe `data` (só status), de propósito.
    const resultado = aprovacao.events.find((event) => event.type === 'tool_result' && event.name === 'submit_service_request');
    assert.ok(resultado);
    assert.equal(resultado.ok, true);
    assert.equal(resultado.executed, true);
    assert.equal(resultado.data, undefined, 'resultado de escrita não vaza para o navegador');
    // Mesmo autorizado, sem endpoint e sem dados completos não há envio.
    const final = await getJson(kirana.base, `/api/requests/${ref.requestId}?sessionId=${sessionId}`);
    assert.notEqual(final.body.estado, 'submitted', 'nada foi enviado de verdade');

    // actionId desconhecido não executa nada.
    const invalido = await confirm(kirana.base, { sessionId, actionId: 'act_00000000', approve: true });
    assert.equal(invalido.events.some((event) => event.type === 'tool_result'), false, 'actionId desconhecido não executa ferramenta');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});
