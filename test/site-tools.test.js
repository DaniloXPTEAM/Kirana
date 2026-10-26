/**
 * Fase 4 — ferramentas do site: handlers reais, nada simulado.
 *
 * Cobre os itens 6, 9 e 10 do briefing. A regra que estes testes protegem: se a
 * ferramenta não consegue fazer, ela DIZ que não consegue. Nenhum handler
 * devolve "enviado com sucesso" sem ter enviado nada, e nenhum devolve
 * credencial.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createSiteKit } from '../src/copilot/site-kit.js';
import { createSiteContext } from '../src/site/context.js';
import { createSiteTools } from '../src/site/tools.js';

const SITES_DIR = path.join(process.cwd(), 'sites');
const SITE = 'opportunity-ai';
const siteContext = createSiteContext({ siteKit: createSiteKit({ sitesDir: SITES_DIR }), sitesDir: SITES_DIR });
const { tools, enabledFor } = createSiteTools({ siteContext, defaultSiteId: SITE });

const ctx = (extra = {}) => ({ siteId: SITE, siteState: {}, ...extra });
const tool = (name) => {
  const found = tools.find((entry) => entry.name === name);
  assert.ok(found, `ferramenta ${name} deve existir`);
  return found;
};
const call = (name, args = {}, extra = {}) => tool(name).handler(args, ctx(extra));

test('as 9 ferramentas têm nome, título, descrição, schema e handler executável', () => {
  assert.equal(tools.length, 9);
  for (const entry of tools) {
    assert.match(entry.name, /^[a-z][a-z0-9_]+$/);
    assert.ok(entry.title?.length > 3, `${entry.name}: título`);
    assert.ok(entry.description?.length > 20, `${entry.name}: descrição para o modelo`);
    assert.equal(entry.parameters.type, 'object');
    assert.equal(typeof entry.handler, 'function', `${entry.name}: handler real`);
  }
  // `enabledFor` respeita o site.json (ordem e composição).
  const enabled = enabledFor(SITE).map((entry) => entry.name);
  assert.equal(enabled.length, 9);
  assert.deepEqual(enabledFor('site-inexistente'), []);
});

test('get_site_context devolve identidade, página atual e o que não está disponível', () => {
  const result = call('get_site_context', {}, { siteState: { path: '/solucoes/voz' } });
  assert.equal(result.ok, true);
  assert.equal(result.site.id, SITE);
  assert.equal(result.site.name, 'Opportunity AI');
  assert.equal(result.site.agente, 'Kirana');
  assert.equal(result.paginaAtual.id, 'solucao-voz');
  assert.equal(result.servicoEmFoco.serviceId, 'voz');
  assert.equal(result.paginaConhecida, true);
  assert.ok(result.rotasPermitidas >= 20);
  assert.equal(result.conhecimento.documentos, 14);
  // Upload não existe: a ferramenta informa, não finge.
  assert.equal(result.uploads.disponivel, false);
  assert.ok(result.uploads.motivo.length > 5);
  // Nada de credencial/segredo na resposta.
  assert.equal(/api[_-]?key|token|secret/i.test(JSON.stringify(result)), false);
});

test('list_site_pages só devolve páginas internas autorizadas', () => {
  const result = call('list_site_pages');
  assert.equal(result.ok, true);
  assert.ok(result.paginas.length >= 15);
  for (const page of result.paginas) {
    assert.match(page.caminho, /^\//);
    assert.equal(page.caminho.includes('://'), false);
  }
  assert.ok(result.paginas.some((page) => page.caminho === '/contato'));
});

test('list_services devolve o catálogo real (6), nunca inventado', () => {
  const result = call('list_services');
  assert.equal(result.ok, true);
  assert.equal(result.servicos.length, 6);
  const ids = result.servicos.map((service) => service.serviceId).sort();
  assert.deepEqual(ids, ['agentes-ia', 'atendimento', 'automacao', 'crm-vendas', 'relatorios', 'voz']);
  for (const service of result.servicos) {
    assert.match(service.caminho, /^\/solucoes\//);
    assert.ok(service.nome.length > 3);
  }
});

test('explain_service usa o conhecimento do site e admite quando não há dados', () => {
  const voz = call('explain_service', { serviceId: 'voz' });
  assert.equal(voz.ok, true);
  assert.equal(voz.serviceId, 'voz');
  assert.match(voz.nome, /voz/i);
  assert.equal(voz.caminho, '/solucoes/voz');
  assert.match(voz.limitacoes, /pesquisa|prototip/i);
  assert.ok(voz.fonte.startsWith('https://opportunity.ia.br/'));
  // Sinônimo do público ("whatsapp") resolve para o serviço certo.
  const whats = call('explain_service', { serviceId: 'whatsapp' });
  assert.equal(whats.serviceId, 'atendimento');
  // Apelido de campo ("servico") também é aceito — modelo pode traduzir.
  assert.equal(call('explain_service', { servico: 'voz' }).serviceId, 'voz');
  // Serviço inexistente: erro claro, sem catálogo inventado.
  const nope = call('explain_service', { serviceId: 'blockchain' });
  assert.equal(nope.ok, false);
  assert.ok(nope.erro.length > 5);
});

test('explain_current_page explica a página onde o visitante está', () => {
  const result = call('explain_current_page', {}, { siteState: { path: '/labs/kirana' } });
  assert.equal(result.ok, true);
  assert.equal(result.pagina.id, 'labs-kirana');
  assert.equal(result.conhecida, true);
  assert.ok(result.resumo.length > 40);
  assert.ok(Array.isArray(result.detalhes));
  // Página fora do catálogo: diz que não conhece, não improvisa.
  const unknown = call('explain_current_page', {}, { siteState: { path: '/pagina-inexistente' } });
  assert.equal(unknown.conhecida, false);
  assert.equal(unknown.pagina.id, null);
  assert.match(unknown.mensagem, /não tenho esta página catalogada/i);
  assert.equal(unknown.detalhes, undefined);
});

test('navigate_to_page devolve diretiva de navegação para rota autorizada', () => {
  const result = call('navigate_to_page', { path: '/solucoes/crm-vendas' });
  assert.equal(result.ok, true);
  assert.equal(result.siteAction.type, 'navigate');
  assert.equal(result.siteAction.path, '/solucoes/crm-vendas');
  // O servidor autoriza; quem navega é o navegador (aqui não há `window`).
  assert.equal(typeof globalThis.window, 'undefined');
});

test('navigate_to_page recusa rota fora da allowlist e URL externa', () => {
  const admin = call('navigate_to_page', { path: '/admin' });
  assert.equal(admin.ok, false);
  assert.equal(admin.siteAction, undefined);
  assert.match(admin.erro, /permitid|autoriz/i);

  const externo = call('navigate_to_page', { path: 'https://exemplo.com/golpe' });
  assert.equal(externo.ok, false);
  assert.equal(externo.motivo, 'external_url');
  assert.equal(externo.siteAction, undefined);

  const travessia = call('navigate_to_page', { path: '/solucoes/../../etc/passwd' });
  assert.equal(travessia.ok, false);
  assert.equal(travessia.motivo, 'invalid_path');
  assert.equal(travessia.siteAction, undefined);
});

test('open_service_page abre a página real do serviço escolhido', () => {
  const result = call('open_service_page', { serviceId: 'relatorios' });
  assert.equal(result.ok, true);
  assert.equal(result.siteAction.type, 'navigate');
  assert.equal(result.siteAction.path, '/solucoes/relatorios');
  const desconhecido = call('open_service_page', { serviceId: 'foguete' });
  assert.equal(desconhecido.ok, false);
  assert.equal(desconhecido.siteAction, undefined);
});

test('request_user_input apresenta campos e não envia nada', () => {
  const result = call('request_user_input', {
    motivo: 'iniciar um atendimento',
    campos: [
      { nome: 'nome', rotulo: 'Seu nome', tipo: 'texto', obrigatorio: true },
      { nome: 'email', rotulo: 'E-mail', tipo: 'email', obrigatorio: true },
      { nome: '../../x', rotulo: 'Campo sujo' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.siteAction.type, 'request_input');
  assert.equal(result.siteAction.campos.length, 3);
  // Nome de campo é saneado (só letras/números/underscore/hífen).
  const nomes = result.siteAction.campos.map((campo) => campo.nome);
  assert.deepEqual(nomes, ['nome', 'email', 'x']);
  assert.match(result.mensagem, /nada foi enviado/i);
});

test('show_confirmation exige confirmação e não executa efeito externo', () => {
  const entry = tool('show_confirmation');
  assert.equal(entry.kind, 'write');
  assert.equal(entry.requiresConfirmation, true);

  const result = entry.handler(
    { acao: 'enviar formulário de contato', resumo: 'Enviar nome e e-mail para a Opportunity AI.' },
    ctx(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.executado, false);
  assert.equal(result.siteAction.type, 'confirmation_granted');
  assert.match(result.motivo, /nada foi enviado/i);
});

test('nenhuma ferramenta de upload é registrada (limitação declarada, não simulada)', () => {
  assert.equal(tools.some((entry) => entry.name === 'request_file_upload'), false);
  assert.equal(enabledFor(SITE).some((entry) => entry.name === 'request_file_upload'), false);
});

test('site sem essas ferramentas declaradas é recusado (isolamento por site)', () => {
  // O site de demonstração não declara nenhuma ferramenta da Fase 4.
  const demo = call('get_site_context', {}, { siteId: 'demo-opportunity' });
  assert.equal(demo.ok, false);
  assert.match(demo.erro, /não está habilitada|desconhecido/i);
  const demoNav = call('navigate_to_page', { path: '/contato' }, { siteId: 'demo-opportunity' });
  assert.equal(demoNav.ok, false);
  assert.equal(demoNav.siteAction, undefined);
});

test('sem site na sessão, ferramentas de contexto falham em vez de usar outro site', () => {
  const semSite = createSiteTools({ siteContext, defaultSiteId: null });
  const getContext = semSite.tools.find((entry) => entry.name === 'get_site_context');
  const result = getContext.handler({}, {});
  assert.equal(result.ok, false);
  assert.match(result.erro, /site/i);
});

test('ferramenta inexistente não é inventada em tempo de execução', () => {
  const pedido = tools.find((entry) => entry.name === 'abrir_pix');
  assert.equal(pedido, undefined);
});
