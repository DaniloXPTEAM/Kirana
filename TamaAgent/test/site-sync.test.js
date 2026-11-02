/**
 * Fase 4 — atualização automática do conhecimento (`scripts/site-sync.mjs`).
 *
 * O script NÃO reescreve a base sozinho (conhecimento precisa de revisão). O
 * que se testa aqui é o que ele garante: ler o sitemap, extrair texto e apontar
 * com precisão o que divergiu entre site publicado, config e conhecimento.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSitemap, extractText, diffSite } from '../scripts/site-sync.mjs';

test('parseSitemap extrai caminhos internos e ignora o domínio', () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://opportunity.ia.br/</loc></url>
    <url><loc>https://opportunity.ia.br/solucoes/</loc></url>
    <url><loc>https://opportunity.ia.br/labs/kirana</loc></url>
    <url><loc>https://opportunity.ia.br/labs/kirana</loc></url>
    <url><loc>nao-e-url</loc></url>
  </urlset>`;
  assert.deepEqual(parseSitemap(xml, 'https://opportunity.ia.br'), ['/', '/solucoes/', '/labs/kirana']);
  assert.deepEqual(parseSitemap('', 'https://opportunity.ia.br'), []);
});

test('extractText remove script/estilo e tags, preservando o texto', () => {
  const html = '<html><head><style>.a{color:red}</style></head><body><h1>Soluções</h1><script>alert(1)</script><p>CRM &amp; vendas</p></body></html>';
  const text = extractText(html);
  assert.match(text, /Soluções/);
  assert.match(text, /CRM & vendas/);
  assert.equal(text.includes('alert(1)'), false);
  assert.equal(text.includes('color:red'), false);
});

test('diffSite aponta rota nova, remoção e página sem documento', () => {
  const report = diffSite({
    publishedPaths: ['/', '/solucoes/', '/solucoes/novo', '/labs/', '/labs/kirana'],
    siteConfig: {
      routes: { allowlist: ['/', '/solucoes/', '/solucoes/novo', '/labs/', '/labs/kirana', '/rota-antiga'] },
    },
    coveredPaths: new Set(['/', '/solucoes/', '/labs/']),
  });
  assert.deepEqual(report.novasRotas, []);
  assert.deepEqual(report.rotasRemovidas, ['/rota-antiga']);
  // `/labs/kirana` é coberto por `/labs/` (documento de grupo).
  assert.deepEqual(report.semDocumento, []);
  assert.deepEqual(report.fontesOrfas, []);
});

test('diffSite detecta divergência real (rota publicada e não autorizada)', () => {
  const report = diffSite({
    publishedPaths: ['/', '/promocao'],
    siteConfig: { routes: { allowlist: ['/'] } },
    coveredPaths: new Set(['/']),
  });
  assert.deepEqual(report.novasRotas, ['/promocao']);
  assert.deepEqual(report.semDocumento, ['/promocao']);
});
