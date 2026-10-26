/**
 * Kirana — ponte com o site (Fase 4).
 *
 * Este arquivo é o "lado site" da integração: ele informa em que página o
 * visitante está, executa a navegação autorizada pelo servidor e apresenta os
 * pedidos de dados. Não é uma segunda interface de assistente — é a camada que
 * faz a Kirana agir DENTRO do site (a conversa continua na interface da Kirana,
 * ou no widget incorporado).
 *
 * Por que vanilla e não React: o site publicado (opportunity.ia.br) é HTML
 * estático com um único `site.js` de 5 KB, sem framework (verificado em
 * 26/10/2026: nenhum marcador de Next/Astro/React/WordPress). Injetar React ali
 * seria mais peso do que o site inteiro. Para seções React existe o kit em
 * `integrations/site-kit-react/`, que usa os hooks v2 do CopilotKit.
 *
 * Regras de segurança:
 *  - só executa `navigate` para caminho interno, validado de novo aqui (o
 *    servidor já validou, isto é defesa em profundidade);
 *  - nunca usa `eval`, `innerHTML` com conteúdo do modelo ou `javascript:`;
 *  - ação desconhecida é registrada e ignorada (o teste cobre isso).
 */

/** Tipos de ação que esta ponte sabe executar. */
export const SITE_ACTIONS = ['navigate', 'request_input', 'confirmation_granted'];

/** Normaliza caminho: interno, sem `..`, sem esquema. */
export function safePath(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (/^(?:[a-z]+:)?\/\//i.test(value)) return null;
  if (/^(?:javascript|data|file|vbscript):/i.test(value)) return null;
  if (!value.startsWith('/') || /\.\./.test(value)) return null;
  return value.split(/[?#]/)[0];
}

/**
 * Cria a ponte.
 *
 * @param {object} options
 * @param {(path: string) => void} [options.onNavigate]  como navegar (padrão: location.assign)
 * @param {(request: object) => void} [options.onInputRequest]  como mostrar o pedido de dados
 * @param {(info: object) => void} [options.onContext]  recebe o contexto validado do servidor
 */
export function createSiteBridge({
  apiBase = '',
  siteId = null,
  sessionId = null,
  headers = () => ({}),
  onNavigate = null,
  onInputRequest = null,
  onContext = null,
  onUnknownAction = null,
  fetchImpl = (...args) => fetch(...args),
  location: locationImpl = globalThis.location,
  history: historyImpl = globalThis.history,
  document: documentImpl = globalThis.document,
  logger = console,
  now = () => Date.now(),
} = {}) {
  const applied = []; // histórico de ações executadas (diagnóstico)
  const ignored = []; // ações recusadas/desconhecidas
  let current = null;

  /** Navega de verdade. Multi-página usa location; SPA usa history + scroll. */
  function defaultNavigate(path) {
    if (onNavigate) {
      onNavigate(path);
      return 'handler';
    }
    // Página única (site local, testes): troca o hash sem recarregar.
    const isSpa = documentImpl?.documentElement?.dataset?.kiranaSpa === 'true';
    if (isSpa && historyImpl?.pushState) {
      historyImpl.pushState({ path }, '', path);
      globalThis.dispatchEvent?.(new CustomEvent('kirana:site-navigated', { detail: { path } }));
      globalThis.scrollTo?.({ top: 0, behavior: 'smooth' });
      return 'spa';
    }
    if (locationImpl?.assign) {
      locationImpl.assign(path);
      return 'full';
    }
    return 'none';
  }

  /** Executa uma diretiva vinda de uma ferramenta. */
  function apply(action) {
    if (!action || typeof action !== 'object' || !action.type) {
      ignored.push({ reason: 'invalid_action', at: now() });
      return { ok: false, reason: 'invalid_action' };
    }
    if (!SITE_ACTIONS.includes(action.type)) {
      ignored.push({ reason: 'unknown_action', type: String(action.type).slice(0, 40), at: now() });
      onUnknownAction?.(action);
      logger.warn?.('[kirana-site] ação desconhecida ignorada', action.type);
      return { ok: false, reason: 'unknown_action' };
    }

    if (action.type === 'navigate') {
      const path = safePath(action.path);
      if (!path) {
        ignored.push({ reason: 'unsafe_path', raw: String(action.path).slice(0, 80), at: now() });
        return { ok: false, reason: 'unsafe_path' };
      }
      const how = defaultNavigate(path);
      applied.push({ type: 'navigate', path, how, at: now() });
      // Confirma ao servidor que a navegação aconteceu (a Kirana pode então
      // explicar a nova página sem adivinhar).
      announce(path);
      return { ok: true, path, how };
    }

    if (action.type === 'request_input') {
      applied.push({ type: 'request_input', fields: action.campos?.length ?? 0, at: now() });
      onInputRequest?.(action);
      return { ok: true };
    }

    // confirmation_granted: a interface só sinaliza; nada externo é disparado.
    applied.push({ type: 'confirmation_granted', at: now() });
    return { ok: true };
  }

  /** Envia a página atual ao servidor (validação lá, não aqui). */
  async function announce(path = locationImpl?.pathname ?? '/') {
    try {
      const response = await fetchImpl(`${apiBase}/api/site/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({ siteId, sessionId, path }),
      });
      if (!response.ok) return null;
      current = await response.json();
      onContext?.(current);
      return current;
    } catch (error) {
      logger.debug?.('[kirana-site] contexto não enviado', error?.message);
      return null;
    }
  }

  return {
    apply,
    announce,
    get context() {
      return current;
    },
    get applied() {
      return applied.slice();
    },
    get ignored() {
      return ignored.slice();
    },
    navigate: (path) => apply({ type: 'navigate', path }),
    setSession: (id) => {
      sessionId = id;
    },
  };
}

/**
 * Liga automaticamente numa página estática.
 *
 * Uso no site publicado (sem framework):
 *
 *   <script src="https://kirana.exemplo/kirana/site-agent.js"
 *           data-kirana-api="https://kirana.exemplo"
 *           data-site-id="opportunity-ai" defer></script>
 *   <script>KiranaSite.announce();</script>
 *
 * `data-kirana-spa="true"` no <html> faz a navegação usar history.pushState em
 * vez de recarregar a página.
 */
export function mountSiteBridge({ apiBase, siteId } = {}) {
  const script = globalThis.document?.currentScript;
  const base = apiBase ?? script?.dataset?.kiranaApi ?? '';
  const id = siteId ?? script?.dataset?.siteId ?? null;
  const bridge = createSiteBridge({ apiBase: base, siteId: id });
  globalThis.KiranaSite = Object.assign(globalThis.KiranaSite ?? {}, {
    bridge,
    apply: (action) => bridge.apply(action),
    announce: (path) => bridge.announce(path),
  });
  // Mantém o contexto atualizado em navegação de SPA e no botão voltar.
  globalThis.addEventListener?.('popstate', () => bridge.announce());
  return bridge;
}
