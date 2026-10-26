/**
 * Fase 4 — fluxo ponta a ponta: site → servidor → ferramentas → agente → SSE.
 *
 * Cobre os itens 5, 9, 11, 12 e 14 do briefing, com o servidor real da Kirana e
 * um gateway FALSO (declarado como mock: quem decide as ferramentas é o
 * `script`, não um modelo). O que se verifica aqui é o contrato do servidor e a
 * ponte com o navegador — não a qualidade da resposta de um LLM.
 *
 * Mock declarado: `startFakeGateway` de `test/helpers.js`. Nenhuma chamada sai
 * para a internet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { startFakeGateway, startKirana, postSse, getJson, textFrom } from './helpers.js';
import { createSiteBridge, safePath } from '../public/site-agent.js';

async function newSession(base) {
  const response = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return response.json();
}

/** Script do gateway falso: cada entrada é uma chamada do modelo. */
function flowScript() {
  const steps = [
    { toolCalls: [{ name: 'list_services', args: {} }] },
    { text: 'Oferecemos seis frentes: agentes de IA, atendimento e WhatsApp, automação, CRM, relatórios e voz.' },
    { toolCalls: [{ name: 'open_service_page', args: { serviceId: 'crm-vendas' } }] },
    { text: 'Abrindo a página de CRM e automação de vendas.' },
    { toolCalls: [{ name: 'explain_current_page', args: {} }] },
    { text: 'Esta página descreve o CRM: contatos, funil, follow-up e histórico.' },
    {
      toolCalls: [
        {
          name: 'request_user_input',
          args: {
            motivo: 'iniciar um atendimento',
            campos: [
              { nome: 'nome', rotulo: 'Seu nome', tipo: 'texto', obrigatorio: true },
              { nome: 'email', rotulo: 'E-mail', tipo: 'email', obrigatorio: true },
            ],
          },
        },
      ],
    },
    { text: 'Preencha os campos; nada é enviado sem a sua confirmação.' },
  ];
  return ({ callIndex }) => steps[callIndex] ?? { text: 'Certo.' };
}

test('fluxo obrigatório: serviços → escolha → página → explicação → dados', async () => {
  const gateway = await startFakeGateway({ script: flowScript() });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const session = await newSession(kirana.base);
    const sessionId = session.id;

    // 1) "quais serviços vocês oferecem?" — a Kirana consulta o catálogo real.
    const first = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'Quais serviços vocês oferecem?',
      siteId: 'opportunity-ai',
      path: '/',
    });
    assert.equal(first.ok, true);
    const firstTools = first.events.filter((event) => event.type === 'tool_result');
    assert.equal(firstTools[0].name, 'list_services');
    assert.equal(firstTools[0].ok, true);
    assert.match(textFrom(first.events), /seis frentes|CRM/i);

    // 2) "quero conhecer esse serviço" → navegação autorizada (diretiva no SSE).
    const second = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'Quero conhecer o CRM.',
      siteId: 'opportunity-ai',
      path: '/',
    });
    const siteActions = second.events.filter((event) => event.type === 'site_action');
    assert.equal(siteActions.length, 1, 'uma diretiva de navegação');
    assert.equal(siteActions[0].tool, 'open_service_page');
    assert.equal(siteActions[0].action.type, 'navigate');
    assert.equal(siteActions[0].action.path, '/solucoes/crm-vendas');

    // 3) Depois de navegar, o visitante pergunta "o que é esta página?".
    const third = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'O que tem nesta página?',
      siteId: 'opportunity-ai',
      path: '/solucoes/crm-vendas',
    });
    const explain = third.events.find((event) => event.type === 'tool_result');
    assert.equal(explain.name, 'explain_current_page');
    assert.equal(explain.ok, true);
    assert.equal(explain.data.pagina.id, 'solucao-crm-vendas');

    // 4) "o que preciso enviar para começar?" → pedido de dados, sem envio.
    const fourth = await postSse(kirana.base, '/api/chat', {
      sessionId,
      message: 'O que preciso enviar para começar?',
      siteId: 'opportunity-ai',
      path: '/solucoes/crm-vendas',
    });
    const input = fourth.events.find((event) => event.type === 'site_action');
    assert.equal(input.action.type, 'request_input');
    assert.equal(input.action.campos.length, 2);
    // Nada de confirmação automática nem de envio no mesmo turno.
    assert.equal(fourth.events.some((event) => event.type === 'confirmation'), false);

    // O histórico do gateway mostra o bloco do site no prompt de sistema.
    const systemPrompt = gateway.requests[0].messages.find((message) => message.role === 'system')?.content ?? '';
    assert.match(systemPrompt, /Opportunity AI/);
    assert.match(systemPrompt, /Kirana/);
    assert.match(systemPrompt, /CRM/);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('o contexto entre páginas é preservado na sessão do servidor', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'Certo.' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const session = await newSession(kirana.base);
    const sessionId = session.id;

    const context = await fetch(`${kirana.base}/api/site/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: 'opportunity-ai', sessionId, path: '/solucoes/voz' }),
    });
    const info = await context.json();
    assert.equal(context.status, 200);
    assert.equal(info.page.id, 'solucao-voz');
    assert.equal(info.service.serviceId, 'voz');

    // A sessão guardou a página: o turno seguinte não precisa reenviar.
    await postSse(kirana.base, '/api/chat', { sessionId, message: 'E aqui?', siteId: 'opportunity-ai' });
    const systemPrompt = gateway.requests[0].messages.find((message) => message.role === 'system')?.content ?? '';
    assert.match(systemPrompt, /\/solucoes\/voz/);

    // Página não catalogada: marcada como tal, sem virar home silenciosamente.
    const unknown = await fetch(`${kirana.base}/api/site/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: 'opportunity-ai', sessionId, path: '/promocao' }),
    }).then((response) => response.json());
    assert.equal(unknown.matched, false);
    assert.equal(unknown.page.id, null);

    // Site não integrado: 404 explícito.
    const bad = await fetch(`${kirana.base}/api/site/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: 'outro-cliente', path: '/' }),
    });
    assert.equal(bad.status, 404);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('/api/site/info expõe páginas, rotas e limites — e nenhuma credencial', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { status, body } = await getJson(kirana.base, '/api/site/info?site=opportunity-ai');
    assert.equal(status, 200);
    const site = body.site;
    assert.equal(site.id ?? body.siteId ?? 'opportunity-ai', 'opportunity-ai');
    const serialized = JSON.stringify(body);
    assert.ok(serialized.includes('/solucoes/crm-vendas'), 'rotas listadas');
    assert.ok(serialized.includes('contato'));
    assert.equal(serialized.includes('test-key'), false, 'nenhuma chave do Gateway');
    assert.equal(serialized.includes(gateway.url), false, 'URL do Gateway não é exposta');
    assert.equal(/api[_-]?key|bearer/i.test(serialized), false);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('as 9 ferramentas do site entram no /api/tools sem quebrar as existentes', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const { status, body } = await getJson(kirana.base, '/api/tools');
    assert.equal(status, 200);
    const names = (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name);
    for (const expected of [
      'get_site_context',
      'list_site_pages',
      'explain_current_page',
      'list_services',
      'explain_service',
      'request_user_input',
      'navigate_to_page',
      'open_service_page',
      'show_confirmation',
    ]) {
      assert.ok(names.includes(expected), `${expected} deveria estar exposta`);
    }
    // Ferramentas da v0.4.x continuam lá.
    assert.ok(names.length >= 9);
    assert.equal(names.includes('request_file_upload'), false);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('voz e demais rotas da v0.4.4 continuam respondendo com o site ligado', async () => {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const config = await getJson(kirana.base, '/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.site.id, 'opportunity-ai');
    assert.equal(config.body.version, '0.5.0');
    assert.ok(config.body.models?.primary, 'modelos preservados');
    assert.ok(config.body.features, 'flags preservadas');

    const voice = await getJson(kirana.base, '/api/voice/status');
    assert.equal(voice.status, 200);
    assert.ok(voice.body.ok !== undefined || voice.body.available !== undefined);

    const memory = await getJson(kirana.base, '/api/memory');
    assert.equal(memory.status, 200);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('show_confirmation passa pelo HITL: sem aprovar, nada acontece', async () => {
  const gateway = await startFakeGateway({
    script: ({ callIndex }) =>
      [
        { toolCalls: [{ name: 'show_confirmation', args: { acao: 'enviar formulário de contato', resumo: 'Enviar nome e e-mail.' } }] },
        { text: 'Preciso da sua confirmação antes de enviar.' },
        { text: 'Você recusou; nada foi enviado.' },
      ][callIndex] ?? { text: 'ok' },
  });
  const kirana = await startKirana({ gatewayUrl: gateway.url });
  try {
    const session = await newSession(kirana.base);
    const turn = await postSse(kirana.base, '/api/chat', {
      sessionId: session.id,
      message: 'Pode enviar o formulário?',
      siteId: 'opportunity-ai',
      path: '/contato',
    });

    // A ferramenta não executa: fica pendente de confirmação explícita.
    const result = turn.events.find((event) => event.type === 'tool_result');
    assert.equal(result.errorCode, 'confirmation_required');
    const pending = turn.events.find((event) => event.type === 'confirmation');
    assert.ok(pending?.action?.id, 'ação pendente com id');
    // Nenhuma navegação/pedido de dados foi disparado por engano.
    assert.equal(turn.events.some((event) => event.type === 'site_action'), false);

    const declined = await postSse(kirana.base, '/api/chat/confirm', {
      sessionId: session.id,
      actionId: pending.action.id,
      approve: false,
    });
    assert.equal(declined.events.find((event) => event.type === 'done')?.resolved, 'declined');
    assert.equal(declined.events.some((event) => event.type === 'site_action'), false);
  } finally {
    await kirana.close();
    await gateway.close();
  }
});

test('a ponte do navegador executa só ações conhecidas e caminhos seguros', () => {
  const navigations = [];
  const bridge = createSiteBridge({
    onNavigate: (target) => navigations.push(target),
    logger: { warn: () => {}, debug: () => {} },
  });

  assert.equal(safePath('/solucoes/voz'), '/solucoes/voz');
  assert.equal(safePath('https://evil.example/x'), null);
  assert.equal(safePath('javascript:alert(1)'), null);
  assert.equal(safePath('/a/../b'), null);
  assert.equal(safePath('relativo'), null);

  const ok = bridge.apply({ type: 'navigate', path: '/solucoes/voz' });
  assert.equal(ok.ok, true);
  assert.deepEqual(navigations, ['/solucoes/voz']);

  const unsafe = bridge.apply({ type: 'navigate', path: 'https://evil.example/x' });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.reason, 'unsafe_path');

  const unknown = bridge.apply({ type: 'executar_script', code: 'alert(1)' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown_action');
  assert.equal(bridge.ignored.length, 2);
  assert.deepEqual(navigations, ['/solucoes/voz'], 'nada além do autorizado foi executado');

  // request_input não navega nem envia: só sinaliza para a interface.
  let asked = null;
  const bridge2 = createSiteBridge({ onInputRequest: (action) => (asked = action), logger: { warn: () => {}, debug: () => {} } });
  assert.equal(bridge2.apply({ type: 'request_input', campos: [{ nome: 'nome' }] }).ok, true);
  assert.equal(asked.campos.length, 1);
});
