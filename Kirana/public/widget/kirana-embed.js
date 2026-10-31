/**
 * Kirana — kit de incorporação no site (script único, sem dependência).
 *
 * Para que serve
 * --------------
 * O site público (`https://opportunity.ia.br`) é estático. Este arquivo é o
 * **único** que precisa ser adicionado a ele:
 *
 *   <script src="https://kirana.seudominio.com.br/widget/kirana-embed.js"
 *           data-kirana-url="https://kirana.seudominio.com.br"
 *           data-kirana-site="opportunity-ai"
 *           defer></script>
 *
 * O que ele NÃO faz (de propósito):
 *   - não contém chave, token nem credencial de nenhum tipo;
 *   - não lê cookie, localStorage nem dado do visitante;
 *   - não altera o conteúdo, o CSS ou a navegação do site;
 *   - não chama API da Kirana direto do JS do site: o painel abre num iframe da
 *     própria origem da Kirana, então as chamadas são same-origin e a chave do
 *     Gateway nunca precisa existir no navegador.
 *
 * Modos
 * -----
 *   iframe (padrão) — mais seguro e independente do CSS do site. Exige
 *                     `KIRANA_EMBED_ORIGINS=https://opportunity.ia.br` na Kirana.
 *   script          — monta o widget React v2 direto na página. Exige que o site
 *                     liste a origem em `allowedOrigins`/KIRANA_ALLOWED_ORIGINS.
 *
 * Atributos aceitos no <script>:
 *   data-kirana-url    URL base da Kirana (obrigatório)
 *   data-kirana-site   id do site em `sites/` (padrão: opportunity-ai)
 *   data-kirana-mode   `iframe` (padrão) ou `script`
 *   data-kirana-label  texto do botão flutuante (padrão: "Falar com a Kirana")
 *   data-kirana-open   `true` para abrir o painel já no carregamento
 */
(function kiranaEmbed() {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var base = (script.getAttribute('data-kirana-url') || '').replace(/\/+$/, '');
  if (!base) {
    console.warn('[kirana-embed] informe data-kirana-url (ex.: https://kirana.seudominio.com.br)');
    return;
  }
  var siteId = script.getAttribute('data-kirana-site') || 'opportunity-ai';
  var mode = (script.getAttribute('data-kirana-mode') || 'iframe').toLowerCase();
  var label = script.getAttribute('data-kirana-label') || 'Falar com a Kirana';
  var abrirNoInicio = script.getAttribute('data-kirana-open') === 'true';

  // Idempotência: um site pode acabar incluindo o script duas vezes.
  if (document.getElementById('kirana-embed-root')) return;

  var root = document.createElement('div');
  root.id = 'kirana-embed-root';
  // `all: initial` isola o widget do CSS da página; posição e z-index são
  // explícitos para não depender de estilos herdados.
  root.setAttribute(
    'style',
    'all: initial; position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;' +
      'font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;',
  );

  var botao = document.createElement('button');
  botao.type = 'button';
  botao.setAttribute('aria-label', label);
  botao.textContent = label;
  botao.setAttribute(
    'style',
    'all: initial; cursor: pointer; border: 0; border-radius: 999px; padding: 14px 20px;' +
      'font: 600 15px/1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #fff;' +
      'background: linear-gradient(135deg, #6d5efc, #37b1c4); box-shadow: 0 10px 28px rgba(30,20,90,.28);',
  );

  var painel = null;

  function alternar(abrir) {
    var visivel = painel && painel.style.display !== 'none';
    var deveAbrir = typeof abrir === 'boolean' ? abrir : !visivel;
    if (deveAbrir && !painel) montarPainel();
    if (painel) painel.style.display = deveAbrir ? 'block' : 'none';
    botao.setAttribute('aria-expanded', String(deveAbrir));
  }

  function montarPainel() {
    if (mode === 'script') {
      montarScript();
      return;
    }
    var iframe = document.createElement('iframe');
    iframe.id = 'kirana-embed-frame';
    iframe.title = 'Kirana — assistente da Opportunity AI';
    // O painel é servido pela própria Kirana: chamadas de API viram same-origin
    // e nenhuma credencial precisa existir nesta página.
    iframe.src = base + '/?embed=1&site=' + encodeURIComponent(siteId);
    iframe.setAttribute('allow', 'microphone; autoplay');
    iframe.setAttribute(
      'style',
      'all: initial; display: block; width: min(420px, calc(100vw - 32px)); height: min(640px, calc(100vh - 120px));' +
        'border: 0; border-radius: 18px; background: #fff; box-shadow: 0 24px 64px rgba(20,16,60,.32);' +
        'margin-bottom: 12px;',
    );
    painel = iframe;
    root.appendChild(iframe);
  }

  function montarScript() {
    // Modo alternativo: monta o widget React v2 carregado do host da Kirana.
    var modulo = document.createElement('script');
    modulo.type = 'module';
    modulo.textContent =
      'import { mountKiranaV2 } from ' +
      JSON.stringify(base + '/widget/kirana-v2.js') +
      ';' +
      'const host = document.createElement("div");' +
      'host.id = "kirana-v2-inline";' +
      'host.setAttribute("style", "width:min(420px,calc(100vw - 32px));height:min(640px,calc(100vh - 120px));background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 24px 64px rgba(20,16,60,.32);margin-bottom:12px;");' +
      'document.getElementById("kirana-embed-root").appendChild(host);' +
      'mountKiranaV2({ runtimeUrl: ' +
      JSON.stringify(base + '/api/copilot') +
      ', siteId: ' +
      JSON.stringify(siteId) +
      ', initialPath: location.pathname, target: host });';
    painel = document.createElement('div');
    painel.setAttribute('style', 'all: initial;');
    painel.appendChild(modulo); // o módulo é executado uma única vez
    root.appendChild(painel);
  }

  botao.addEventListener('click', function () {
    alternar();
  });
  root.appendChild(botao);
  document.body.appendChild(root);

  if (abrirNoInicio) alternar(true);
})();
