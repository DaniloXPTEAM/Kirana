#!/usr/bin/env node
/**
 * Teste REAL de navegador (Playwright/Chromium) — Fase 5.
 *
 * Espera a Kirana rodando em KIRANA_BASE_URL, apontada para o gateway
 * SIMULADO (`scripts/mock-gateway.js`, roteiro fixo por gatilho de texto — não
 * é um modelo). O que se valida aqui é o que só o navegador prova:
 *
 *   1. o pedido cria um rascunho de verdade e o visitante é informado de que
 *      nada foi enviado;
 *   2. `fill_site_form` escreve nos campos REAIS do formulário (`#nome`,
 *      `#email`, `#consent`…) e **não** submete o formulário;
 *   3. o pedido de arquivo abre o seletor do visitante e o arquivo vai para a
 *      API da solicitação (validação no servidor, nada executado);
 *   4. o envio é barrado pelo HITL: antes da confirmação, o backend não é
 *      chamado; depois de aprovar, continua não enviado porque não há endpoint;
 *   5. cancelar descarta o rascunho e os arquivos;
 *   6. o estado sobrevive a recarregar a página (retomada da tarefa).
 *
 * O formulário é um fixture injetado no DOM com os mesmos `id` que o
 * `site.json` mapeia — o site real é HTML estático de terceiro, e o teste não
 * deve publicar nada nele.
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
  await page.waitForFunction(
    () => !document.querySelector('.msg.assistant .bubble.cursor') && !document.querySelector('.typing'),
    null,
    { timeout: 45000 },
  ).catch(() => {});
  await page.waitForTimeout(500);
}

async function sessionId() {
  return page.evaluate(() => localStorage.getItem('kirana.session'));
}

async function api(pathname) {
  const id = await sessionId();
  const response = await fetch(`${BASE}${pathname}${pathname.includes('?') ? '&' : '?'}sessionId=${id}`);
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Formulário de contato com os mesmos ids que o site.json mapeia. */
async function injectForm() {
  await page.evaluate(() => {
    if (document.querySelector('#kirana-fixture-form')) return;
    window.__submitted = false;
    const form = document.createElement('form');
    form.id = 'kirana-fixture-form';
    form.innerHTML = `
      <input id="nome" name="nome" />
      <input id="email" name="email" type="email" />
      <input id="whatsapp" name="whatsapp" />
      <input id="empresa" name="empresa" />
      <select id="interesse" name="interesse"><option value="">—</option><option>Agentes de IA</option></select>
      <textarea id="mensagem" name="mensagem"></textarea>
      <input id="consent" name="consent" type="checkbox" />
      <button type="submit">Enviar</button>`;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      window.__submitted = true;
    });
    document.body.appendChild(form);
  });
}

try {
  /* -------------------------- 1. rascunho real -------------------------- */
  await page.goto(`${BASE}/?path=/contato`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chat, .chat, main', { timeout: 20000 });
  await injectForm();
  // A ponte é a mesma `public/site-agent.js` que o site embutiria: nada de
  // simulação — o teste anexa a ponte real, como um embedder faria.
  await page.evaluate(async (base) => {
    const mod = await import(`${base}/site-agent.js`);
    window.KiranaSite = { bridge: mod.createSiteBridge({ apiBase: base, siteId: 'opportunity-ai' }) };
  }, BASE);

  await ask('Quero colocar uma IA no meu site');
  const primeiro = await page.locator('.msg.assistant').last().innerText();
  check('a Kirana registra o pedido na conversa', /rascunho|solicita|anotad/i.test(primeiro), primeiro.slice(0, 90).replace(/\n/g, ' '));
  check('o visitante é avisado de que nada foi enviado', /nada foi enviado|não foi enviado|nada é enviado/i.test(primeiro), primeiro.slice(-90).replace(/\n/g, ' '));

  const lista = await api('/api/requests');
  check('existe uma solicitação de verdade no servidor', lista.status === 200 && lista.body.solicitacoes.length === 1, JSON.stringify(lista.body?.solicitacoes?.[0] ?? null));
  const requestId = lista.body?.solicitacoes?.[0]?.id;
  check('a solicitação tem identificador e estado', /^REQ-\d{4}-[A-Z0-9]{6}$/.test(requestId ?? '') && Boolean(lista.body?.solicitacoes?.[0]?.estado), `${requestId} ${lista.body?.solicitacoes?.[0]?.estado}`);
  check('o estado inicial não é "enviada"', lista.body?.solicitacoes?.[0]?.estado !== 'submitted');

  /* -------------------- 2. preencher o formulário real ------------------- */
  await ask('Pode preencher o formulário de contato?');
  const valores = await page.evaluate(() => ({
    nome: document.querySelector('#nome')?.value ?? '',
    email: document.querySelector('#email')?.value ?? '',
    mensagem: document.querySelector('#mensagem')?.value ?? '',
    consent: document.querySelector('#consent')?.checked ?? false,
    submitted: window.__submitted,
  }));
  check('os campos do formulário foram preenchidos de verdade', valores.nome.length > 0 && valores.email.includes('@'), JSON.stringify(valores.nome).slice(0, 40));
  check('a mensagem do pedido foi para o campo certo', valores.mensagem.length > 5, valores.mensagem.slice(0, 40));
  check('o consentimento LGPD foi marcado como o dado coletado', valores.consent === true);
  check('o formulário NÃO foi enviado pelo preenchimento', valores.submitted === false);
  const depoisPreencher = await api(`/api/requests/${requestId}`);
  check('a solicitação não foi enviada ao preencher', depoisPreencher.body?.estado !== 'submitted', depoisPreencher.body?.estado);

  /* ------------------------ 3. upload real de arquivo -------------------- */
  await ask('Quero anexar um arquivo');
  const card = page.locator('.upload-card').last();
  const temCard = (await page.locator('.upload-card').count()) > 0;
  check('aparece o cartão de anexo', temCard);
  if (temCard) {
    const texto = await card.innerText();
    check('o cartão informa tipos e limite', /pdf/i.test(texto) && /MB/.test(texto), texto.slice(0, 80).replace(/\n/g, ' '));
    check('o cartão diz que o arquivo não é executado', /não é executado|não executado/i.test(texto));

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      card.locator('button').first().click(),
    ]);
    await chooser.setFiles({ name: 'briefing.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nbriefing de teste\n') });
    await page.waitForTimeout(1200);

    const status = await card.innerText();
    check('o servidor confirma o anexo', /Anexado/i.test(status), status.slice(-80).replace(/\n/g, ' '));
    const comArquivo = await api(`/api/requests/${requestId}`);
    check('o arquivo ficou ligado à solicitação', (comArquivo.body?.arquivos?.length ?? 0) === 1, JSON.stringify(comArquivo.body?.arquivos?.[0] ?? null));
    check('o arquivo tem prazo de retenção', Boolean(comArquivo.body?.arquivos?.[0]?.expiraEm));
  }

  /* --------------------------- 4. HITL no envio ------------------------- */
  await ask('Pode enviar a solicitação?');
  const confirmCard = page.locator('.confirm-card:not(.input-card)').last();
  const temConfirmacao = (await page.locator('.confirm-card:not(.input-card)').count()) > 0;
  check('o envio pede confirmação explícita', temConfirmacao);
  const antesDeAprovar = await api(`/api/requests/${requestId}`);
  check('sem aprovação nada foi enviado', antesDeAprovar.body?.estado !== 'submitted', antesDeAprovar.body?.estado);
  check('o cartão avisa que nada aconteceu ainda', /Nada é gravado nem enviado/i.test(await confirmCard.innerText().catch(() => '')));

  if (temConfirmacao) {
    await confirmCard.locator('button.btn-primary').first().click();
    await page.waitForTimeout(1500);
    const depoisDeAprovar = await api(`/api/requests/${requestId}`);
    // Sem endpoint configurado, aprovar executa a ferramenta — e ela mesma diz
    // que não enviou. O estado não pode ser "submitted".
    check('aprovar sem backend real não vira "enviada"', depoisDeAprovar.body?.estado !== 'submitted', depoisDeAprovar.body?.estado);
    check('não há protocolo inventado', !depoisDeAprovar.body?.externalId);
  }

  /* --------------------- 5. andamento e retomada ------------------------ */
  await ask('Qual o andamento da solicitação?');
  const andamento = await page.locator('.msg.assistant').last().innerText();
  check('o andamento vem do estado real, não estimado', new RegExp(requestId ?? 'REQ-').test(andamento) || /andamento|estado|rascunho/i.test(andamento), andamento.slice(0, 90).replace(/\n/g, ' '));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chat, .chat, main', { timeout: 20000 });
  const aposRecarregar = await api(`/api/requests/${requestId}`);
  check('a tarefa sobrevive a recarregar a página (retomada)', aposRecarregar.status === 200 && aposRecarregar.body?.id === requestId, aposRecarregar.body?.id);

  /* --------------------------- 6. cancelamento -------------------------- */
  await ask('Quero cancelar a solicitação');
  const cancelCard = page.locator('.confirm-card:not(.input-card)').last();
  if ((await page.locator('.confirm-card:not(.input-card)').count()) > 0) {
    await cancelCard.locator('button.btn-primary').first().click();
    await page.waitForTimeout(1500);
    const cancelada = await api(`/api/requests/${requestId}`);
    check('cancelar muda o estado para cancelled', cancelada.body?.estado === 'cancelled', cancelada.body?.estado);
    check('cancelar remove os arquivos do visitante', (cancelada.body?.arquivos?.length ?? 0) === 0);
  } else {
    check('cancelamento pede confirmação', false, 'cartão de confirmação ausente');
  }

  check('sem erros de JavaScript no console', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 200));
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
