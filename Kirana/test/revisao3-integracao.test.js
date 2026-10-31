/**
 * Revisão 3 — os três defeitos vistos de PONTA A PONTA, pela API da Kirana.
 *
 * Os testes de unidade ficam em tools/teste-revisao3.mjs; aqui a pergunta é
 * outra: o que a tela recebe depois que o Gateway responde assim? Estes casos
 * sobem o servidor real da Kirana (`createKiranaServer`) contra um Gateway falso
 * que fala SSE no formato do Gateway v0.4.1.
 *
 * A. stream cortado não pode virar resposta concluída (evento `done` sem erro);
 * B. 401 de chave local ≠ 401 de SIWC ≠ 401 sem código;
 * C. descoberta que falhou não fica presa: erro de autorização força reconsulta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startKirana, postSse } from './helpers.js';

/**
 * Gateway falso controlável: `roteiro(req, res, corpo)` decide cada resposta.
 * O caminho /v1/models conta quantas vezes foi consultado (para o caso C).
 */
async function gatewayFalso(roteiro) {
  const estado = { modelosConsultados: 0, chats: 0, modelosPedidos: [], autorizado: false };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const partes = [];
    for await (const c of req) partes.push(c);
    const corpo = partes.length ? JSON.parse(Buffer.concat(partes).toString('utf8')) : null;

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '0.4.1', authenticated: estado.autorizado === true }));
      return;
    }
    if (url.pathname === '/v1/models') {
      estado.modelosConsultados += 1;
      return roteiro.modelos(req, res, estado);
    }
    if (url.pathname === '/v1/chat/completions') {
      estado.chats += 1;
      estado.modelosPedidos.push(corpo?.model);
      return roteiro.chat(req, res, corpo, estado);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    estado,
    close: () => new Promise((r) => server.close(r)),
  };
}

const sse = (res, pedacos) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  for (const p of pedacos) res.write(p);
  res.end();
};
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (t) => frame({ choices: [{ index: 0, delta: { content: t } }] });
const final = (m = 'stop') => frame({ choices: [{ index: 0, delta: {}, finish_reason: m }] });
const DONE = 'data: [DONE]\n\n';

async function novaSessao(base) {
  const r = await fetch(`${base}/api/session`, { method: 'POST' });
  return r.json();
}

test('A (ponta a ponta): stream cortado chega à tela como interrupção, não como conclusão', async () => {
  const gateway = await gatewayFalso({
    modelos: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-5' }] }));
    },
    // Texto parcial e EOF, sem finish_reason e sem [DONE].
    chat: (req, res) => sse(res, [delta('Resposta pela metade')]),
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const sessao = await novaSessao(kirana.base);
    const { events } = await postSse(kirana.base, '/api/chat', { sessionId: sessao.id, message: 'oi' });

    const erro = events.find((e) => e.type === 'error');
    assert.ok(erro, 'deveria emitir evento de erro em vez de concluir');
    assert.equal(erro.code, 'stream_interrupted');
    assert.match(erro.message, /interrompida|incompleto/i);

    // O texto parcial pode ter aparecido, mas NUNCA junto de um "done" de sucesso.
    const terminou = events.find((e) => e.type === 'done' || e.type === 'assistant_done');
    assert.equal(terminou, undefined, 'não pode haver evento de conclusão');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('A (ponta a ponta): texto + finish_reason + [DONE] conclui normalmente', async () => {
  const gateway = await gatewayFalso({
    modelos: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-5' }] }));
    },
    chat: (req, res) => sse(res, [delta('Tudo '), delta('certo.'), final('stop'), DONE]),
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const sessao = await novaSessao(kirana.base);
    const { events } = await postSse(kirana.base, '/api/chat', { sessionId: sessao.id, message: 'oi' });

    assert.equal(events.find((e) => e.type === 'error'), undefined, 'não deveria haver erro');
    const texto = events.filter((e) => e.type === 'delta' || e.type === 'message_delta').map((e) => e.text).join('');
    assert.match(texto, /Tudo certo\./);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

for (const [nome, status, corpo, esperado, trecho] of [
  ['B (ponta a ponta): 401 de CHAVE LOCAL não manda autorizar a conta', 401, { error: { message: 'Missing or invalid gateway bearer key.', code: 'invalid_api_key' } }, 'unauthorized', /chave LOCAL/i],
  ['B (ponta a ponta): 401 de SIWC manda autorizar no navegador', 401, { error: { message: 'Run the local Sign in with ChatGPT flow first.', code: 'authentication_required' } }, 'gateway_auth', /auth\/start/i],
  ['B (ponta a ponta): 403 sem código é não conclusivo', 403, { error: { message: 'Forbidden.' } }, 'gateway_auth_unknown', /não vou adivinhar/i],
]) {
  test(nome, async () => {
    const gateway = await gatewayFalso({
      modelos: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-5' }] }));
      },
      chat: (req, res) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(corpo));
      },
    });
    const kirana = await startKirana({ gatewayUrl: gateway.url });
    try {
      const sessao = await novaSessao(kirana.base);
      const { events } = await postSse(kirana.base, '/api/chat', { sessionId: sessao.id, message: 'oi' });
      const erro = events.find((e) => e.type === 'error');
      assert.ok(erro, 'deveria emitir erro');
      assert.equal(erro.code, esperado);
      assert.match(erro.message, trecho);
      // texto cru do upstream não aparece na tela
      assert.doesNotMatch(erro.message, /Missing or invalid gateway bearer key|Run the local Sign in/);
    } finally {
      await kirana.close();
      await gateway.close();
    }
  });
}

test('C (ponta a ponta): descoberta falha, autoriza, próxima mensagem já consulta de novo', async () => {
  const gateway = await gatewayFalso({
    modelos: (req, res, estado) => {
      if (!estado.autorizado) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Run the local Sign in with ChatGPT flow first.', code: 'authentication_required' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'gpt-4o-mini' }] }));
    },
    chat: (req, res, corpoPedido, estado) => {
      if (!estado.autorizado) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Run the local Sign in with ChatGPT flow first.', code: 'authentication_required' } }));
        return;
      }
      sse(res, [delta('ok'), final('stop'), DONE]);
    },
  });
  const gatewayControl = gateway.estado;

  // KIRANA_MODEL_PROBE ligado: a primeira mensagem tenta descobrir e falha.
  const kirana = await startKirana({
    gatewayUrl: gateway.url,
    env: { KIRANA_MODEL_PROBE: 'true', KIRANA_PRIMARY_MODEL: 'gpt-6-luna', KIRANA_FALLBACK_MODEL: 'gpt-6.1-sol' },
  });
  try {
    const sessao = await novaSessao(kirana.base);
    const primeira = await postSse(kirana.base, '/api/chat', { sessionId: sessao.id, message: 'oi' });
    assert.equal(primeira.events.find((e) => e.type === 'error')?.code, 'gateway_auth', 'primeira mensagem sem autorização');
    const consultasIniciais = gateway.estado.modelosConsultados;
    assert.ok(consultasIniciais >= 1, 'deveria ter consultado /v1/models');

    // Usuário autoriza no navegador (o Gateway passa a responder o catálogo).
    gatewayControl.autorizado = true;

    const segunda = await postSse(kirana.base, '/api/chat', { sessionId: sessao.id, message: 'oi de novo' });
    assert.equal(segunda.events.find((e) => e.type === 'error'), undefined, 'segunda mensagem deveria funcionar');
    assert.ok(
      gateway.estado.modelosConsultados > consultasIniciais,
      'deveria reconsultar /v1/models logo após a autorização (sem esperar 5 minutos)',
    );

    // E o modelo efetivamente pedido ao gateway é um dos anunciados — não o
    // 'gpt-6-luna' do .env, que não existe no catálogo deste teste.
    const pedidos = gateway.estado.modelosPedidos;
    assert.equal(pedidos[0], 'gpt-6-luna', 'antes de autorizar, a Kirana tenta o configurado');
    const ultimo = pedidos[pedidos.length - 1];
    assert.ok(['gpt-5', 'gpt-4o-mini'].includes(ultimo), `depois de autorizar, o modelo vem do catálogo: ${ultimo}`);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});
