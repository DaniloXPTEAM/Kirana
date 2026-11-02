#!/usr/bin/env node
/**
 * Teste REAL de navegador (Playwright/Chromium).
 *
 * Sobe nada por conta própria: espera a Kirana já rodando em KIRANA_BASE_URL
 * (padrão http://127.0.0.1:1455) com o gateway simulado apontado.
 *
 * Cenário obrigatório do marco 2:
 *   "Kirana, abra a página de contato, preencha meu interesse nos serviços de
 *    IA e me mostre os dados antes de enviar."
 *
 * Verifica no DOM de verdade:
 *   - navegação para #contato
 *   - campos do formulário preenchidos
 *   - cartão de confirmação com os dados
 *   - envio só depois do clique (e protocolo real na tela)
 *   - caminho de cancelamento (nada é enviado)
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

async function openWidget(page) {
  await page.goto(`${BASE}/demo/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.KiranaSite && window.KiranaWidget), null, { timeout: 15000 });
  const host = page.locator('#kirana-widget-root');
  await host.locator('[data-kirana-toggle]').click();
  await host.locator('[data-kirana-form] input').waitFor({ timeout: 10000 });
  return host;
}

async function ask(host, text) {
  const input = host.locator('[data-kirana-form] input');
  await input.fill(text);
  await host.locator('[data-kirana-send]').click();
}

async function waitIdle(host) {
  await host.locator('[data-kirana-typing]').waitFor({ state: 'detached', timeout: 45000 }).catch(() => {});
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on('console', (message) => {
  if (message.type() === 'error') console.log(`   [console.error] ${message.text().slice(0, 200)}`);
});

try {
  /* ---------------- caminho feliz: navegar, preencher, confirmar --------- */
  let host = await openWidget(page);
  check('widget monta na página', await host.locator('[data-kirana-toggle]').count() > 0);

  await ask(host, 'Kirana, abra a página de contato');
  await waitIdle(host);
  await page.waitForFunction(() => window.location.hash === '#contato', null, { timeout: 20000 }).catch(() => {});
  check('navegou para a página de contato', (await page.evaluate(() => window.location.hash)) === '#contato', await page.evaluate(() => window.location.hash));
  check('estado compartilhado reflete a página', (await page.evaluate(() => window.KiranaSite.getState().page)) === 'contato');

  await ask(host, 'Agora preencha meu interesse nos serviços de IA');
  await waitIdle(host);
  await page.waitForFunction(() => document.getElementById('f-nome')?.value?.length > 0, null, { timeout: 20000 }).catch(() => {});
  const form = await page.evaluate(() => window.KiranaSite.readForm());
  check('formulário preenchido de verdade no DOM', form.nome === 'Ana Demo' && form.email.includes('@'), JSON.stringify({ nome: form.nome, email: form.email }));
  check('interesse selecionado', /Atendimento digital/.test(form.interesse), form.interesse);

  await ask(host, 'Pode enviar o pedido');
  const confirmCard = host.locator('[data-kirana-confirmation]');
  await confirmCard.waitFor({ timeout: 30000 }).catch(() => {});
  check('pede confirmação antes de enviar', await confirmCard.count() > 0);
  const confirmText = await confirmCard.innerText().catch(() => '');
  check('confirmação mostra os dados', /Ana Demo/.test(confirmText) && /ana\.demo@exemplo\.com/.test(confirmText), confirmText.split('\n').slice(0, 3).join(' | '));
  check('nada foi enviado antes da confirmação', (await page.evaluate(() => window.KiranaSite.getState().formStep)) !== 'sent');

  await host.locator('[data-kirana-confirm]').click();
  await page.waitForFunction(() => window.KiranaSite.getState().formStep === 'sent', null, { timeout: 30000 }).catch(() => {});
  const resultText = await page.locator('#form-result').innerText().catch(() => '');
  check('envio executado após confirmação', (await page.evaluate(() => window.KiranaSite.getState().formStep)) === 'sent', resultText);
  check('resultado real exibido (protocolo)', /OPP-|protocolo/i.test(resultText), resultText.slice(0, 120));

  /* ------------------------- caminho de cancelamento -------------------- */
  const page2 = await context.newPage();
  const host2 = await openWidget(page2);
  await ask(host2, 'Kirana, abra a página de contato');
  await waitIdle(host2);
  await ask(host2, 'Preencha meu interesse nos serviços de IA');
  await waitIdle(host2);
  await ask(host2, 'Pode enviar o pedido');
  const cancelCard = host2.locator('[data-kirana-confirmation]');
  await cancelCard.waitFor({ timeout: 30000 }).catch(() => {});
  check('segunda sessão também pede confirmação', (await cancelCard.count()) > 0);
  await host2.locator('[data-kirana-cancel]').click();
  await page2.waitForTimeout(700);
  const step2 = await page2.evaluate(() => window.KiranaSite.getState().formStep);
  check('cancelamento não envia nada', step2 !== 'sent', `formStep=${step2}`);
  const status2 = await host2.locator('[data-kirana-status]').innerText().catch(() => '');
  check('cancelamento é registrado na interface', /cancel/i.test(status2), status2.slice(0, 80));
  await page2.close();

  /* --------------------- regressão da UI antiga (vanilla) --------------- */
  const vanilla = await context.newPage();
  await vanilla.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const composer = await vanilla.locator('#composer, textarea, input[type="text"]').first().isVisible().catch(() => false);
  check('interface vanilla da Kirana continua no ar', composer);
  const hasStreamState = await vanilla.evaluate(async () => {
    try {
      const response = await fetch('/stream-state.js');
      return response.ok;
    } catch {
      return false;
    }
  });
  check('stream-state.js (correção do indicador) continua servido', hasStreamState);
  await vanilla.close();
} finally {
  await browser.close();
}

console.log('');
console.log(`${results.filter((r) => r.ok).length}/${results.length} verificações de navegador OK`);
if (failures > 0) {
  console.log(`${failures} falha(s)`);
  process.exit(1);
}
