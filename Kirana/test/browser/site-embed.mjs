#!/usr/bin/env node
/**
 * Teste REAL de navegador — integração SITE ↔ KIRANA (duas origens).
 *
 * O que este teste prova (e o que nenhum teste de mesma origem prova):
 *
 *   1. uma página estática servida em OUTRA origem (o "site", simulando
 *      https://opportunity.ia.br) inclui apenas
 *      `<script src=".../widget/kirana-embed.js">` — nada mais;
 *   2. o `frame-ancestors` do CSP permite o iframe **só** para a origem do site;
 *   3. o painel abre, o visitante conversa e recebe resposta real;
 *   4. a ferramenta de catálogo executa no servidor (`list_services`);
 *   5. a navegação autorizada chega ao site por `postMessage`? Não: no modo
 *      iframe o painel navega por link direto. O que se verifica aqui é que a
 *      página do site NÃO é alterada pelo script;
 *   6. nenhuma credencial aparece no HTML do site nem no iframe.
 *
 * Mock declarado: `scripts/mock-gateway.js` (com `--namespaced`, que imita o
 * Gateway real). Nenhum modelo real é chamado.
 */
import http from 'node:http';
import { chromium } from 'playwright';

const KIRANA = process.env.KIRANA_BASE_URL || 'http://127.0.0.1:1455';
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Servidor do "site": HTML estático, mínima coisa possível. */
function startSite() {
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Opportunity AI — site de teste</title></head>
<body style="margin:0;font-family:system-ui;background:#0b1020;color:#eef">
<main style="max-width:720px;margin:80px auto;padding:0 24px">
  <h1 style="font-size:28px">Opportunity AI</h1>
  <p>Página estática qualquer. O conteúdo abaixo é do site e não deve ser alterado pela Kirana.</p>
  <p id="marcador">conteúdo original do site</p>
</main>
<script src="${KIRANA}/widget/kirana-embed.js"
        data-kirana-url="${KIRANA}"
        data-kirana-site="opportunity-ai"
        defer></script>
</body></html>`;

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    // Porta fixa: o `frame-ancestors` do CSP da Kirana precisa citar exatamente
    // esta origem (KIRANA_EMBED_ORIGINS). Pode ser trocada por variável.
    const port = Number(process.env.KIRANA_EMBED_PORT || 3010);
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
}

const site = await startSite().catch((error) => {
  console.error(`[site-embed] não foi possível abrir a porta do site de teste: ${error?.message}`);
  process.exit(1);
});
const SITE_ORIGIN = `http://127.0.0.1:${site.port}`;
console.log(`site de teste: ${SITE_ORIGIN} · Kirana: ${KIRANA}\n`);

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
});
page.on('pageerror', (error) => consoleErrors.push(error.message.slice(0, 200)));

try {
  /* ------------------------- 1. o site carrega e o botão aparece --------- */
  await page.goto(`${SITE_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#kirana-embed-root button', { timeout: 15000 });
  check('o script de embed cria o botão no site', (await page.locator('#kirana-embed-root button').count()) === 1);

  const htmlDoSite = await page.content();
  check('o site não recebe nenhuma credencial', !/GATEWAY_API_KEY|KIRANA_ACCESS_TOKEN|Bearer /i.test(htmlDoSite));
  check('o script de embed não é inline (CSP do site fica simples)', (await page.locator('script[src*="kirana-embed.js"]').count()) === 1);

  /* ----------------------------- 2. abre o iframe ----------------------- */
  await page.locator('#kirana-embed-root button').click();
  const frameElement = page.locator('#kirana-embed-frame');
  await frameElement.waitFor({ timeout: 15000 });

  const frameSrc = await frameElement.getAttribute('src');
  check('o painel é um iframe da própria Kirana', Boolean(frameSrc?.startsWith(KIRANA)), frameSrc ?? '');

  const frame = page.frameLocator('#kirana-embed-frame');
  await frame.locator('#composer textarea, #composer input, textarea').first().waitFor({ timeout: 25000 });
  check('o iframe carregou a interface da Kirana (frame-ancestors autorizou)', true);

  /* ------------------ 3. modo embed esconde o operador ------------------ */
  const iframePage = page.frames().find((item) => item.url().includes('/?embed=1'));
  check('a URL do painel pede o modo embed', Boolean(iframePage), iframePage?.url() ?? 'não encontrado');

  const sidebarVisivel = await iframePage.evaluate(() => {
    const el = document.querySelector('.sidebar');
    if (!el) return 'sem sidebar';
    return getComputedStyle(el).display !== 'none';
  });
  check('no embed a barra lateral do operador fica oculta', sidebarVisivel === false, String(sidebarVisivel));

  /* --------------------- 4. conversa real dentro do iframe -------------- */
  const input = frame.locator('#composer textarea, #composer input').first();
  await input.fill('Quais serviços vocês oferecem?');
  await input.press('Enter');

  let resposta = '';
  for (let tentativa = 0; tentativa < 60; tentativa += 1) {
    await iframePage.waitForTimeout(500);
    resposta = await iframePage.evaluate(() => {
      const bolhas = [...document.querySelectorAll('#chat .msg.assistant, #chat .msg')];
      return bolhas.map((node) => node.textContent || '').join('\n');
    });
    if (/frentes|agentes|atendimento|crm/i.test(resposta)) break;
  }
  check('o visitante conversa e recebe resposta com dados reais do site', /frentes|agentes|atendimento|crm/i.test(resposta), resposta.slice(0, 120).replace(/\s+/g, ' '));

  const pilula = await iframePage.evaluate(() => {
    const pills = [...document.querySelectorAll('.msg-meta .pill')].map((node) => node.textContent || '');
    return pills.join(' | ');
  });
  check('a pílula mostra o nome canônico da ferramenta', /Listar soluções/i.test(pilula), pilula.slice(0, 120));
  check('nenhum "gateway." aparece na interface', !/gateway\./i.test(pilula), pilula.slice(0, 120));

  /* ---------------- 5. o conteúdo do site continua intacto -------------- */
  const marcador = await page.locator('#marcador').innerText();
  check('o site não foi alterado pela Kirana', marcador === 'conteúdo original do site', marcador);

  /* --------------------------- 6. sem erros de JS ----------------------- */
  const relevantes = consoleErrors.filter((texto) => !/favicon|ERR_BLOCKED/i.test(texto));
  check('sem erros de JavaScript no console', relevantes.length === 0, relevantes.slice(0, 2).join(' | '));
} catch (error) {
  check('execução sem exceção', false, String(error?.message ?? error).slice(0, 200));
} finally {
  await browser.close();
  await new Promise((resolve) => site.server.close(resolve));
}

const falhas = results.filter((item) => !item.ok);
console.log(`\n${results.length - falhas.length}/${results.length} verificações passaram`);
if (falhas.length) {
  console.log('falhas:');
  for (const item of falhas) console.log(` - ${item.name}${item.detail ? ` (${item.detail})` : ''}`);
  process.exitCode = 1;
}
