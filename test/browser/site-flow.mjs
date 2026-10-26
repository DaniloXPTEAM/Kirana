#!/usr/bin/env node
/**
 * Teste REAL de navegador (Playwright/Chromium) — Fase 4.
 *
 * Espera a Kirana já rodando em KIRANA_BASE_URL (padrão http://127.0.0.1:1455)
 * apontada para o gateway SIMULADO (`scripts/mock-gateway.js`). O roteiro do
 * mock é declarado: as ferramentas são escolhidas por gatilho de texto, não por
 * um modelo. O que este teste valida de verdade é o caminho no navegador:
 * servidor → ferramenta → `site_action` → ponte do site → DOM.
 *
 * Cobre:
 *   1. a interface residente continua funcionando (chat da v0.4.4 preservado);
 *   2. "quais serviços vocês oferecem?" consulta o catálogo real;
 *   3. "quero conhecer o CRM" gera a diretiva de navegação autorizada;
 *   4. "o que preciso enviar?" mostra os campos, sem enviar nada;
 *   5. a ponte `site-agent.js` executa navegação real (pushState) e recusa o resto;
 *   6. o contexto da página chega ao servidor (POST /api/site/context).
 */
import { chromium } from 'playwright';

const BASE = process.env.KIRANA_BASE_URL || 'http://127.0.0.1:1455';
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message.slice(0, 200)}`));

async function ask(text) {
  const input = page.locator('#composer-input, textarea#input, [data-input]').first();
  await input.fill(text);
  await input.press('Enter');
}

async function waitIdle() {
  await page.waitForFunction(
    () => !document.querySelector('.msg.assistant .bubble.cursor') && !document.querySelector('.typing'),
    null,
    { timeout: 45000 },
  ).catch(() => {});
  await page.waitForTimeout(600);
}

try {
  /* ------------------------- 1. chat residente intacto ------------------- */
  await page.goto(`${BASE}/?path=/solucoes/voz`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chat, .chat, main', { timeout: 20000 });
  check('a interface residente da Kirana carrega', await page.locator('body').isVisible());
  check('a marca Kirana aparece na tela', (await page.content()).includes('Kirana'));

  /* --------------------- 2. catálogo real pelo fluxo --------------------- */
  await ask('Quais serviços vocês oferecem?');
  await waitIdle();
  const firstText = await page.locator('.msg.assistant').last().innerText();
  check('lista os serviços do conhecimento real', /frentes|CRM|atendimento/i.test(firstText), firstText.slice(0, 80).replace(/\n/g, ' '));
  const toolPills = await page.locator('.pill').allInnerTexts();
  check('mostra a ferramenta usada (list_services)', toolPills.some((text) => /Listar soluções/i.test(text)), toolPills.join(' | ').slice(0, 120));

  /* -------------------- 3. escolha → diretiva de navegação --------------- */
  await ask('Quero conhecer o CRM.');
  await waitIdle();
  const navText = await page.locator('.msg.assistant').last().innerText();
  const navPills = await page.locator('.pill').allInnerTexts();
  const navigated =
    /Ação do site: abrir \/solucoes\/crm-vendas/.test(navPills.join(' | ')) || /Abrindo/.test(navText);
  check('gera navegação autorizada para /solucoes/crm-vendas', navigated, `${navText.slice(0, 60).replace(/\n/g, ' ')} | ${navPills.slice(-2).join(' | ')}`);
  check('não sai da interface sozinha (nenhum redirecionamento)', new URL(page.url()).pathname === '/');

  /* --------------------- 4. pedido de dados, sem envio ------------------- */
  await page.goto(`${BASE}/?path=/contato`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chat, .chat, main', { timeout: 20000 });
  await ask('O que preciso enviar para começar?');
  await waitIdle();
  const card = page.locator('.input-card').last();
  const cardCount = await page.locator('.input-card').count();
  check('mostra o cartão de campos pedidos', cardCount > 0, `${cardCount} cartão(ões)`);
  if (cardCount) {
    const text = await card.innerText();
    check('o cartão lista os campos', /nome|e-?mail/i.test(text), text.slice(0, 70).replace(/\n/g, ' '));
    check('o cartão declara que nada é enviado', /nada é enviado|não é enviado|preenchid/i.test(text));
  }
  check('nenhum envio automático aconteceu (sem confirmação pendente)', (await page.locator('.confirm-card:not(.input-card)').count()) === 0);

  /* ------------- 5. ponte do site: navegação real e recusas -------------- */
  const bridgePage = await context.newPage();
  const bridgeErrors = [];
  bridgePage.on('pageerror', (error) => bridgeErrors.push(error.message));
  // Mesma origem do servidor (import de módulo não funciona em about:blank).
  await bridgePage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await bridgePage.evaluate(() => document.documentElement.setAttribute('data-kirana-spa', 'true'));
  const bridgeReport = await bridgePage.evaluate(async (base) => {
    const mod = await import(`${base}/site-agent.js`);
    const bridge = mod.createSiteBridge({ apiBase: base, siteId: 'opportunity-ai' });
    const applied = [];
    window.addEventListener('kirana:site-navigated', (event) => applied.push(event.detail.path));

    const ok = bridge.apply({ type: 'navigate', path: '/solucoes/crm-vendas' });
    const external = bridge.apply({ type: 'navigate', path: 'https://evil.example/x' });
    const unknown = bridge.apply({ type: 'rodar_codigo', code: 'alert(1)' });
    const asked = [];
    const second = mod.createSiteBridge({ apiBase: base, siteId: 'opportunity-ai', onInputRequest: (action) => asked.push(action) });
    second.apply({ type: 'request_input', campos: [{ nome: 'nome' }] });
    const context = await bridge.announce('/solucoes/voz');
    return {
      ok,
      external,
      unknown,
      asked: asked.length,
      applied,
      url: location.pathname,
      context: context ? { page: context.page?.id, service: context.service?.serviceId, matched: context.matched } : null,
    };
  }, BASE);

  check('a ponte navega de verdade no navegador (pushState)', bridgeReport.ok.ok === true && bridgeReport.applied.length === 1, JSON.stringify(bridgeReport.ok));
  check('a URL interna foi atualizada sem recarregar', bridgeReport.url === '/solucoes/crm-vendas', bridgeReport.url);
  check('URL externa é recusada pela ponte', bridgeReport.external.ok === false && bridgeReport.external.reason === 'unsafe_path');
  check('ação desconhecida é ignorada (sem eval)', bridgeReport.unknown.ok === false && bridgeReport.unknown.reason === 'unknown_action');
  check('pedido de dados chega à interface do site', bridgeReport.asked === 1);

  /* ---------------- 6. contexto de página validado no servidor ----------- */
  check('o servidor reconhece a página informada', bridgeReport.context?.matched === true && bridgeReport.context?.page === 'solucao-voz', JSON.stringify(bridgeReport.context));
  check('o servidor resolve o serviço em foco', bridgeReport.context?.service === 'voz');

  check('sem erros de JavaScript no console', consoleErrors.length === 0 && bridgeErrors.length === 0, [...consoleErrors, ...bridgeErrors].join(' | ').slice(0, 200));
  await bridgePage.close();
} catch (error) {
  check('execução sem exceção', false, error.message);
} finally {
  await context.close();
  await browser.close();
}

console.log(`\n${results.length - failures}/${results.length} verificações passaram`);
if (failures) {
  console.log('falhas:');
  for (const result of results.filter((item) => !item.ok)) console.log(` - ${result.name} ${result.detail}`);
}
process.exit(failures ? 1 : 0);
