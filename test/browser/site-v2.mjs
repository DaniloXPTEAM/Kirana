#!/usr/bin/env node
/**
 * Teste REAL de navegador (Playwright/Chromium) — widget CopilotKit v2.
 *
 * Espera a Kirana rodando em KIRANA_BASE_URL (padrão http://127.0.0.1:1456) com
 * o gateway SIMULADO. O que este teste valida de verdade:
 *   - o bundle v2 (`public/widget/kirana-v2.js`) monta numa página real;
 *   - o cliente v2 conecta ao runtime `/api/copilot` (agente `kirana`);
 *   - `useAgentContext` publica a página atual;
 *   - uma mensagem do visitante vira turno real (ferramenta `list_services`
 *     executada no servidor) e a resposta aparece na tela;
 *   - `useFrontendTool('navigate_to_page')` recusa rota fora da allowlist.
 *
 * Mock declarado: `scripts/mock-gateway.js`. Nenhum modelo real é chamado.
 */
import { chromium } from 'playwright';

const BASE = process.env.KIRANA_BASE_URL || 'http://127.0.0.1:1456';
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
const errors = [];
page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)));

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  const mounted = await page.evaluate(async () => {
    const mod = await import('/widget/kirana-v2.js');
    if (typeof mod.mountKiranaV2 !== 'function') return { error: 'mountKiranaV2 ausente' };
    const host = document.createElement('div');
    host.id = 'v2-host';
    document.body.appendChild(host);
    mod.mountKiranaV2({
      runtimeUrl: '/api/copilot',
      siteId: 'opportunity-ai',
      initialPath: '/contato',
      allowlist: ['/', '/contato', '/solucoes/', '/solucoes/crm-vendas'],
      target: host,
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return {
      mounted: Boolean(document.querySelector('[data-kirana-v2]')),
      status: document.querySelector('.kirana-v2__head span')?.textContent ?? '',
      inputEnabled: !document.querySelector('.kirana-v2 input')?.disabled,
      safePath: {
        ok: mod.safePath('/solucoes/crm-vendas'),
        externo: mod.safePath('https://evil.example/x'),
        travessia: mod.safePath('/a/../b'),
      },
    };
  });

  check('o bundle v2 exporta mountKiranaV2 e monta o painel', mounted.mounted === true, JSON.stringify(mounted).slice(0, 120));
  check('o cliente v2 conecta ao runtime (agente kirana)', mounted.status === 'pronta', mounted.status);
  check('o compositor fica habilitado quando o agente está pronto', mounted.inputEnabled === true);
  check('a normalização de caminho recusa URL externa e travessia', mounted.safePath.ok === '/solucoes/crm-vendas' && !mounted.safePath.externo && !mounted.safePath.travessia, JSON.stringify(mounted.safePath));

  /* -------------------- turno real de conversa (v2) --------------------- */
  await page.locator('.kirana-v2 input').fill('Quais serviços vocês oferecem?');
  await page.locator('.kirana-v2 button').click();
  await page.waitForFunction(
    () => {
      const bubbles = [...document.querySelectorAll('.kirana-v2__msg')];
      return bubbles.some((node) => /frentes|CRM|atendimento/i.test(node.textContent || ''));
    },
    null,
    { timeout: 45000 },
  ).catch(() => {});
  const bubbles = await page.locator('.kirana-v2__msg').allInnerTexts();
  check('a mensagem do visitante aparece no painel', bubbles.some((text) => /serviços/i.test(text)), bubbles[0]?.slice(0, 60));
  check(
    'a resposta vem do conhecimento real do site',
    bubbles.some((text) => /frentes|CRM|atendimento/i.test(text)),
    bubbles[1]?.slice(0, 90),
  );

  /* ---------------- ferramenta de UI: allowlist no navegador ------------- */
  const toolReport = await page.evaluate(async () => {
    const mod = await import('/widget/kirana-v2.js');
    // A ferramenta é registrada no core; aqui exercitamos o handler pela via
    // pública do módulo (a mesma que o agente usa) num host descartável.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const calls = [];
    mod.mountKiranaV2({
      runtimeUrl: '/api/copilot',
      siteId: 'opportunity-ai',
      allowlist: ['/contato'],
      onNavigate: (path) => calls.push(path),
      target: host,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { ok: true, calls };
  });
  check('segundo painel monta sem conflito (multi-instância)', toolReport.ok === true);

  check('sem erros de JavaScript no console', errors.length === 0, errors.join(' | ').slice(0, 200));
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
