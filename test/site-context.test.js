/**
 * Fase 4 — contexto do site: página atual, allowlist e isolamento por site.
 *
 * Cobre os itens 2, 4, 8 e 12 do briefing: reconhecer a página, navegar só no
 * autorizado, recusar rota desconhecida e não vazar um site para o outro.
 *
 * Nada aqui faz rede: `sitesDir` é o diretório real do repositório.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createSiteKit } from '../src/copilot/site-kit.js';
import { createSiteContext, normalizePath, samePath } from '../src/site/context.js';

const SITES_DIR = path.join(process.cwd(), 'sites');
const siteKit = createSiteKit({ sitesDir: SITES_DIR });
const siteContext = createSiteContext({ siteKit, sitesDir: SITES_DIR });
const SITE = 'opportunity-ai';

test('normalizePath bloqueia travessia, esquema e query', () => {
  // A barra final é preservada (é a forma publicada no sitemap); a comparação
  // é que ignora a diferença — ver samePath abaixo.
  assert.equal(normalizePath('/solucoes/'), '/solucoes/');
  assert.equal(normalizePath('/solucoes/crm-vendas?x=1#y'), '/solucoes/crm-vendas');
  // Travessia não é "corrigida": é recusada (string vazia = caminho inválido).
  assert.equal(normalizePath('/../etc/passwd'), '');
  assert.equal(normalizePath('%2e%2e/segredo'), '');
  // URL externa vira caminho interno sem esquema utilizável — e, mesmo assim,
  // a allowlist recusa (ver canNavigate).
  assert.equal(normalizePath('https://opportunity.ia.br/sobre'), '/https:/opportunity.ia.br/sobre');
  // Vazio significa "não informado" — diferente de "/" (home).
  assert.equal(normalizePath(''), '');
  assert.equal(normalizePath('/'), '/');
  assert.equal(samePath('/solucoes', '/solucoes/'), true);
  assert.equal(samePath('/solucoes', '/labs'), false);
  // Caminho inválido nunca casa — nem com a home.
  assert.equal(samePath('/../x', '/'), false);
  assert.equal(samePath('', '/'), false);
});

test('a config do site é validada: identidade, URL, conhecimento e ferramentas', () => {
  const site = siteContext.site(SITE);
  assert.ok(site, 'site opportunity-ai deve existir');
  assert.equal(site.name, 'Opportunity AI');
  assert.equal(site.siteUrl, 'https://opportunity.ia.br');
  assert.equal(site.agentName, 'Kirana');
  assert.equal(site.knowledgeDir, 'knowledge');
  assert.ok(site.pages.length >= 15, 'páginas declaradas');
  assert.ok(site.routes.allowlist.length >= 20, 'allowlist do sitemap');
  assert.ok(site.routes.allowlist.every((route) => route.startsWith('/')), 'allowlist só com caminhos internos');
  assert.deepEqual(
    site.tools.map((tool) => tool.name).sort(),
    [
      'explain_current_page',
      'explain_service',
      'get_site_context',
      'list_services',
      'list_site_pages',
      'navigate_to_page',
      'open_service_page',
      'request_user_input',
      'show_confirmation',
    ],
  );
  // Toda ferramenta declarada tem categoria; ações com efeito são explícitas.
  for (const tool of site.tools) {
    assert.ok(['read', 'navigation', 'sensitive'].includes(tool.category), `${tool.name}: categoria`);
  }
  assert.equal(site.tools.find((tool) => tool.name === 'show_confirmation').category, 'sensitive');
  // Upload não é oferecido porque não existe endpoint seguro (declarado, não fingido).
  assert.equal(site.tools.some((tool) => tool.name === 'request_file_upload'), false);
  assert.match(site.permissions.deniedReasons.request_file_upload, /upload|arquivo/i);
});

test('site desconhecido não é resolvido (isolamento por siteId)', () => {
  assert.equal(siteContext.site('site-inexistente'), null);
  assert.equal(siteContext.site(''), null);
  assert.equal(siteContext.knowledgeFor('site-inexistente'), null);
  // E não cai no site padrão por engano.
  assert.equal(siteContext.currentContext('site-inexistente', { path: '/' }).matched, false);
});

test('reconhece a página atual, inclusive com barra final e alias', () => {
  const home = siteContext.currentContext(SITE, { path: '/' });
  assert.equal(home.matched, true);
  assert.equal(home.page.id, 'home');

  const folha = siteContext.currentContext(SITE, { path: '/solucoes/crm-vendas' });
  assert.equal(folha.page.id, 'solucao-crm-vendas');
  assert.equal(folha.service.serviceId, 'crm-vendas');

  // O sitemap publica /solucoes/ COM barra; o visitante chega em /solucoes.
  const semBarra = siteContext.currentContext(SITE, { path: '/solucoes' });
  assert.equal(semBarra.matched, true);
  assert.equal(semBarra.page.id, 'solucoes');

  // pageId tem prioridade sobre path (widget sabe a página, URL pode estar suja).
  const porId = siteContext.currentContext(SITE, { pageId: 'contato', path: '/qualquer' });
  assert.equal(porId.page.id, 'contato');
});

test('página desconhecida é marcada como não conhecida, sem inventar', () => {
  const unknown = siteContext.currentContext(SITE, { path: '/promocao-secreta' });
  assert.equal(unknown.matched, false);
  assert.equal(unknown.page.id, null);
  assert.match(unknown.page.title, /não catalogada/i);
  assert.equal(unknown.service, null);
  assert.equal(unknown.path, '/promocao-secreta');
});

test('navegação só é autorizada dentro da allowlist', () => {
  const ok = siteContext.canNavigate(SITE, '/solucoes/voz');
  assert.equal(ok.ok, true);
  assert.equal(ok.path, '/solucoes/voz');

  assert.equal(siteContext.canNavigate(SITE, '/admin').reason, 'not_allowed');
  assert.equal(siteContext.canNavigate(SITE, '/wp-login.php').reason, 'not_allowed');
  assert.equal(siteContext.canNavigate(SITE, 'https://exemplo.com/x').reason, 'external_url');
  assert.equal(siteContext.canNavigate(SITE, 'javascript:alert(1)').reason, 'external_url');
  assert.equal(siteContext.canNavigate(SITE, '/solucoes/../../etc').ok, false);

  // Toda página declarada é navegável (não há página "fantasma" na config).
  for (const page of siteContext.site(SITE).pages) {
    if (page.id === 'home') continue;
    const result = siteContext.canNavigate(SITE, page.path);
    assert.equal(result.ok, true, `${page.id} (${page.path}) deveria ser navegável: ${result.reason}`);
  }
});

test('site sem allowlist declarada não navega para lugar nenhum', () => {
  const fakeKit = {
    resolve: (id) =>
      id === 'sem-lista'
        ? { id: 'sem-lista', name: 'Sem lista', pages: [], routes: {}, tools: [], permissions: {} }
        : null,
  };
  const ctx = createSiteContext({ siteKit: fakeKit, sitesDir: SITES_DIR });
  const result = ctx.canNavigate('sem-lista', '/qualquer');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_allowlist');
});

test('a página padrão é a home e o catálogo de páginas vem da config real', () => {
  assert.equal(siteContext.defaultPage(SITE).id, 'home');
  const pages = siteContext.site(SITE).pages;
  assert.ok(pages.length >= 15);
  assert.ok(pages.some((page) => page.path === '/contato'));
  assert.ok(pages.some((page) => page.path === '/privacidade'));
  // O catálogo de serviços vem do conhecimento real, com caminho publicado.
  for (const service of siteContext.knowledgeFor(SITE).services()) {
    assert.match(service.path, /^\/solucoes\//);
  }
});

test('o conhecimento é servido por site e é o mesmo objeto em cache', () => {
  const first = siteContext.knowledgeFor(SITE);
  const second = siteContext.knowledgeFor(SITE);
  assert.equal(first, second, 'cache evita reler 11 arquivos por turno');
  assert.equal(first.docs.length, 14);
  assert.equal(siteContext.refreshIfStale(SITE), false, 'nada mudou: não recarrega');
});
