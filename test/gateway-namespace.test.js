/**
 * Regressão v0.5.1 — "unknown_tool" com o Gateway REAL.
 *
 * Defeito relatado no primeiro teste no Windows (gateway real v0.4.x):
 *
 *   - a interface mostrava `gateway.consultar_servicos · ok`;
 *   - a Kirana respondia que a consulta ao catálogo tinha falhado;
 *   - `list_services` e `get_site_context` retornavam `unknown_tool`.
 *
 * Causa (comprovada no código do Gateway, não suposta): o Gateway v0.4.x envolve
 * as ferramentas do cliente no namespace `gateway`
 * (`toNamespacedTools`) e devolve o nome da chamada como
 * `displayToolName(namespace, name)` → `gateway.<nome>`
 * (`src/responses.js` do pacote em `integrations/`). A Kirana procurava o nome
 * EXATO no registro → não achava nada → `unknown_tool` para TODAS as ferramentas.
 *
 * Por que as suítes não pegaram: o gateway falso devolvia o nome cru. Aqui ele
 * é configurado com `namespaced: true`, que reproduz o comportamento real.
 *
 * Estes testes são de INTEGRAÇÃO com servidor real da Kirana + gateway falso
 * declarado. O gateway real nunca é chamado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startFakeGateway, startKirana, postSse } from './helpers.js';
import { canonicalToolName } from '../src/tools/names.js';

async function newSession(base) {
  const response = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return response.json();
}

/* ------------------------------------------------ 1. normalização de nomes */

test('canonicalToolName remove o namespace do Gateway e preserva o resto', () => {
  assert.equal(canonicalToolName('gateway.consultar_servicos'), 'consultar_servicos');
  assert.equal(canonicalToolName('gateway.list_services'), 'list_services');
  assert.equal(canonicalToolName('consultar_servicos'), 'consultar_servicos');
  // Namespace diferente de `gateway` não é nosso: fica intacto.
  assert.equal(canonicalToolName('outro.time.list_services'), 'outro.time.list_services');
  // Nome com ponto legítimo (não é namespace do gateway) continua igual.
  assert.equal(canonicalToolName('gatewayx.list_services'), 'gatewayx.list_services');
  // Robustez com entradas estranhas.
  assert.equal(canonicalToolName(''), '');
  assert.equal(canonicalToolName(null), '');
  assert.equal(canonicalToolName(undefined), '');
});

/* ------------------------------ 2. ferramenta interna com gateway real-like */

test('com gateway namespaced, consultar_servicos EXECUTA (sem unknown_tool)', async () => {
  const gateway = await startFakeGateway({
    namespaced: true,
    script: ({ callIndex }) =>
      callIndex === 0
        ? { toolCalls: [{ name: 'consultar_servicos', args: { consulta: 'todos os serviços' } }] }
        : { text: 'Temos seis frentes de atuação.' },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { id: sessionId } = await newSession(kirana.base);
    const turn = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'Quais serviços a Opportunity AI oferece?',
      siteId: 'opportunity-ai',
      path: '/',
    });

    const result = turn.events.find((event) => event.type === 'tool_result');
    assert.ok(result, 'deve emitir tool_result');
    assert.equal(result.errorCode, null, `não pode ser unknown_tool (errorCode=${result.errorCode})`);
    assert.equal(result.ok, true, 'a ferramenta precisa executar de verdade');

    // O nome emitido é o canônico, sem o prefixo do gateway na interface.
    assert.equal(result.name, 'consultar_servicos');

    // E nada de unknown_tool em qualquer evento do turno.
    assert.equal(
      turn.events.some((event) => event.errorCode === 'unknown_tool'),
      false,
      'ferramenta registrada não pode virar unknown_tool',
    );

    // O modelo recebeu o resultado real (o texto vem depois da ferramenta).
    assert.equal(gateway.requests.length >= 2, true, 'houve segunda rodada com o resultado da ferramenta');
    const toolMessage = gateway.requests[1].messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage, 'o resultado da ferramenta voltou ao modelo');
    assert.match(toolMessage.content, /"ok":true/);
    assert.doesNotMatch(toolMessage.content, /unknown_tool/);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

/* ------------------- 3. ferramentas de site (a segunda falha relatada) ---- */

test('com gateway namespaced, list_services e get_site_context executam', async () => {
  const gateway = await startFakeGateway({
    namespaced: true,
    script: ({ callIndex }) => {
      if (callIndex === 0) return { toolCalls: [{ name: 'list_services', args: {} }] };
      if (callIndex === 1) return { toolCalls: [{ name: 'get_site_context', args: {} }] };
      return { text: 'São seis soluções; esta é a página inicial.' };
    },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { id: sessionId } = await newSession(kirana.base);
    const turn = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'Use as ferramentas de contexto e conhecimento do site.',
      siteId: 'opportunity-ai',
      path: '/',
    });

    const results = turn.events.filter((event) => event.type === 'tool_result');
    assert.equal(results.length, 2, 'as duas ferramentas devem executar');
    for (const result of results) {
      assert.equal(result.errorCode, null, `${result.name} não pode falhar`);
      assert.equal(result.ok, true, `${result.name} deve executar`);
    }
    assert.deepEqual(results.map((event) => event.name).sort(), ['get_site_context', 'list_services']);

    // Dados reais do site chegaram ao modelo (não é resposta inventada).
    const listResult = results.find((event) => event.name === 'list_services');
    assert.ok(Array.isArray(listResult.data?.servicos), 'list_services devolve os serviços reais');
    assert.ok(listResult.data.servicos.length >= 6);

    const contextResult = results.find((event) => event.name === 'get_site_context');
    assert.equal(contextResult.data?.site?.id, 'opportunity-ai');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

/* --------------- 4. diretiva para o navegador usa o nome canônico --------- */

test('site_action sai com o nome canônico da ferramenta (não "gateway.x")', async () => {
  const gateway = await startFakeGateway({
    namespaced: true,
    script: ({ callIndex }) =>
      callIndex === 0
        ? { toolCalls: [{ name: 'open_service_page', args: { serviceId: 'crm-vendas' } }] }
        : { text: 'Abrindo a página de CRM.' },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { id: sessionId } = await newSession(kirana.base);
    const turn = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'Quero conhecer o CRM.',
      siteId: 'opportunity-ai',
      path: '/',
    });
    const action = turn.events.find((event) => event.type === 'site_action');
    assert.ok(action, 'a diretiva de navegação precisa existir');
    assert.equal(action.tool, 'open_service_page', 'a ponte do site espera o nome canônico');
    assert.equal(action.action.path, '/solucoes/crm-vendas');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

/* ---------------- 5. escrita/HITL também sobrevive ao namespacing --------- */

test('ferramenta de escrita com gateway namespaced pede confirmação e executa', async () => {
  const gateway = await startFakeGateway({
    namespaced: true,
    script: ({ callIndex }) =>
      callIndex === 0
        ? {
            toolCalls: [
              {
                name: 'registrar_interesse_comercial',
                args: {
                  nome: 'Ana Teste',
                  canal_tipo: 'email',
                  canal_valor: 'ana@exemplo.com',
                  interesse: 'Agentes de IA',
                  mensagem: 'Quero um agente no meu site.',
                  consentimento: true,
                },
              },
            ],
          }
        : { text: 'Preciso da sua confirmação.' },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { id: sessionId } = await newSession(kirana.base);
    const turn = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'Quero registrar um interesse.',
      siteId: 'opportunity-ai',
      path: '/',
    });
    const confirmation = turn.events.find((event) => event.type === 'confirmation');
    assert.ok(confirmation, 'a ação de escrita precisa de confirmação explícita');
    assert.equal(confirmation.action.tool, 'registrar_interesse_comercial', 'nome canônico no HITL');
    assert.equal(
      turn.events.some((event) => event.errorCode === 'unknown_tool'),
      false,
      'a escrita não pode cair em unknown_tool',
    );
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

/* -------- 6. nomes sem namespace continuam funcionando (compatível) ------ */

test('gateway sem namespace (formato antigo) continua funcionando', async () => {
  const gateway = await startFakeGateway({
    script: ({ callIndex }) =>
      callIndex === 0
        ? { toolCalls: [{ name: 'list_services', args: {} }] }
        : { text: 'Seis soluções.' },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { id: sessionId } = await newSession(kirana.base);
    const turn = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'Quais serviços vocês oferecem?',
      siteId: 'opportunity-ai',
      path: '/',
    });
    const result = turn.events.find((event) => event.type === 'tool_result');
    assert.equal(result.ok, true);
    assert.equal(result.name, 'list_services');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

/* -- 7. nome realmente inexistente continua sendo erro verdadeiro e claro - */

test('ferramenta inexistente falha com mensagem útil, não silenciosa', async () => {
  const gateway = await startFakeGateway({
    namespaced: true,
    script: ({ callIndex }) =>
      callIndex === 0
        ? { toolCalls: [{ name: 'pesquisar_na_web', args: { consulta: 'opportunity.ia.br' } }] }
        : { text: 'Não tenho acesso à internet.' },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { id: sessionId } = await newSession(kirana.base);
    const turn = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'Pesquise https://opportunity.ia.br',
      siteId: 'opportunity-ai',
      path: '/',
    });
    const result = turn.events.find((event) => event.type === 'tool_result');
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'unknown_tool');
    // A interface nunca mostra o prefixo de infraestrutura do Gateway.
    assert.equal(result.name, 'pesquisar_na_web', 'nome exibido é o canônico, sem "gateway."');

    // O modelo precisa receber uma explicação acionável, com as ferramentas reais.
    const toolMessage = gateway.requests[1].messages.find((message) => message.role === 'tool');
    const payload = JSON.parse(toolMessage.content);
    assert.match(payload.erro.mensagem, /não está registrada|nao esta registrada|desconhecida/i);
    assert.ok(Array.isArray(payload.erro.disponiveis) && payload.erro.disponiveis.length >= 24);
    assert.ok(payload.erro.disponiveis.includes('list_services'));
    assert.match(payload.erro.orientacao, /internet|pesquisa/i);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

/* --------- 8. ferramenta de FRONTEND (AG-UI) com nome prefixado ---------- */

/**
 * Terceira falha relatada: no widget do site (caminho CopilotKit/AG-UI) as
 * ações de interface (`navigateToPage`, `fillContactForm`, ...) também paravam
 * de funcionar. O Gateway prefixa o nome do mesmo jeito; o mapa de ferramentas
 * de frontend é indexado pelo nome declarado pelo site. Sem normalização, a
 * chamada caía em `unknown_tool` e o navegador nunca navegava — mas a interface
 * ainda mostrava "ok".
 */
test('ferramenta de frontend executada pela interface com gateway namespaced', async () => {
  const gateway = await startFakeGateway({
    namespaced: true,
    script: ({ callIndex }) =>
      callIndex === 0
        ? { toolCalls: [{ name: 'navigateToPage', args: { page: 'contato' } }] }
        : { text: 'Abri a página de contato.' },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });

  const envelope = {
    method: 'agent/run',
    params: { agentId: 'kirana' },
    body: {
      threadId: 'thread_ns_frontend',
      runId: 'run_ns_frontend',
      messages: [{ id: 'u1', role: 'user', content: 'Abra a página de contato' }],
      tools: [
        {
          name: 'navigateToPage',
          description: 'Navega para uma página.',
          parameters: {
            type: 'object',
            properties: { page: { type: 'string', enum: ['inicio', 'solucoes', 'labs', 'contato'] } },
            required: ['page'],
          },
        },
      ],
      state: {},
      forwardedProps: { siteId: 'demo-opportunity' },
    },
  };

  try {
    const response = await fetch(`${kirana.base}/api/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    const text = await response.text();
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((payload) => payload && payload !== '[DONE]')
      .map((payload) => {
        try {
          return JSON.parse(payload);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const start = events.find((event) => event.type === 'TOOL_CALL_START');
    assert.ok(start, 'a interface precisa receber a chamada da ferramenta de frontend');
    assert.equal(start.toolCallName, 'navigateToPage', 'o navegador só conhece o nome declarado, sem prefixo');

    const args = events.filter((event) => event.type === 'TOOL_CALL_ARGS').map((event) => event.delta).join('');
    assert.match(args, /contato/);
    assert.equal(
      events.some((event) => /unknown_tool/.test(JSON.stringify(event))),
      false,
      'ferramenta declarada pelo site não pode virar unknown_tool',
    );
  } finally {
    await kirana.close();
    await gateway.close();
  }
});
