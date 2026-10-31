/**
 * R08/R01/R02 (consistência) — "ok" não significa "trouxe dado".
 *
 * Defeito relatado: uma ferramenta aparecia com `ok` e a Kirana dizia não
 * conseguir acessar o catálogo. Investigação (correção pós-0.5.3): os dois estavam certos.
 * `ok` sempre significou "executou sem erro" — não "havia conteúdo suficiente
 * para responder". Agora o resultado carrega `sem_dados`, a pílula mostra
 * `ok · sem dados` e o modelo recebe essa distinção no próprio resultado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toolPillView } from '../public/stream-state.js';
import { semDados } from '../src/agent.js';
import { startFakeGateway, startKirana, postSse } from './helpers.js';

test('pílula: ok, ok sem dados e falha são três estados diferentes', () => {
  assert.deepEqual(toolPillView({ title: 'Listar soluções', ok: true }), {
    label: 'Listar soluções · ok',
    tone: 'ok',
  });
  assert.deepEqual(toolPillView({ title: 'Listar soluções', ok: true, semDados: true }), {
    label: 'Listar soluções · ok, sem dados',
    tone: 'warn',
  });
  assert.equal(toolPillView({ title: 'Listar soluções', ok: false, errorCode: 'tool_error' }).tone, 'fail');
  assert.equal(toolPillView({ title: 'x', pending: true }).label, 'x · aguardando');
});

test('semDados: distingue "sem conteúdo" de "tem conteúdo"', () => {
  assert.equal(semDados(null), true, 'sem resultado');
  assert.equal(semDados({ conhecida: false, mensagem: 'não catalogada' }), true, 'página fora do catálogo');
  assert.equal(semDados({ servicos: [] }), true, 'lista vazia');
  assert.equal(semDados({ servicos: [], projetos: [] }), true, 'todas as listas vazias');
  assert.equal(semDados([ ]), true, 'array vazio');
  assert.equal(semDados({ servicos: [{ id: 'x' }] }), false, 'tem conteúdo');
  assert.equal(semDados({ ok: true, resumo: 'texto' }), false, 'objeto sem lista mas com informação');
});

test('o evento tool_result traz semDados separado de ok', async () => {
  const fake = await startFakeGateway({
    script: ({ callIndex }) =>
      callIndex === 0
        ? { toolCalls: [{ name: 'explain_current_page', args: {} }] }
        : { text: 'Não há essa página no catálogo.' },
  });
  const kirana = await startKirana({ gatewayUrl: fake.url, env: { KIRANA_MODEL_PROBE: 'false' } });

  try {
    const sessao = await (await fetch(`${kirana.base}/api/session`, { method: 'POST' })).json();
    const { events } = await postSse(kirana.base, '/api/chat', {
      sessionId: sessao.id,
      message: 'o que tem nesta página?',
      siteId: 'oportunity',
      // Página real do catálogo, mas sem documento próprio: a ferramenta
      // executa (ok) e devolve `conhecida: false` — o caso "ok sem dados".
      siteState: { path: '/contato' },
    });

    const resultado = events.find((e) => e.type === 'tool_result');
    assert.ok(resultado, 'deveria haver um tool_result');
    assert.equal(resultado.ok, true, 'a ferramenta executou');
    assert.equal(typeof resultado.semDados, 'boolean', 'semDados precisa vir explícito no evento');
    // Coerência: marcar semDados só quando o conteúdo realmente não serve.
    assert.equal(resultado.semDados, semDados(resultado.data ?? null));

    // O resultado da ferramenta volta ao modelo com a distinção disponível.
    const corpo = fake.requests.at(-1);
    const mensagemFerramenta = corpo.messages.find((m) => m.role === 'tool');
    assert.ok(mensagemFerramenta, 'o resultado da ferramenta precisa voltar ao modelo');
    const conteudo = String(mensagemFerramenta.content);
    assert.match(conteudo, /"ok":true/);
    if (resultado.semDados) assert.match(conteudo, /sem_dados/);
  } finally {
    await kirana.close();
    await fake.close();
  }
});
