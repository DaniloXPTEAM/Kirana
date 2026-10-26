/**
 * Kirana — widget CopilotKit v2 (Fase 4).
 *
 * Por que este arquivo existe separado de `widget/src/main.jsx`
 * ------------------------------------------------------------
 * O site publicado (opportunity.ia.br) é HTML estático: para ele, a interface
 * residente é a vanilla (`public/app.js` + `public/site-agent.js`) e o widget
 * v1 continua válido para os sites de demonstração. Este módulo é a camada
 * **v2** exigida na Fase 4, usada quando a página do cliente é React:
 *
 *   import { mountKiranaV2 } from '/widget/kirana-v2.js';
 *   mountKiranaV2({ runtimeUrl: '/api/copilot', siteId: 'opportunity-ai' });
 *
 * O que ele usa da API v2 (e nada da v1)
 * --------------------------------------
 *  - `CopilotKitCoreReact` + `CopilotKitContext` (`/v2/context`): o provider
 *    headless — a v2 não traz um componente pronto de provider;
 *  - `useAgent()`: conversa e `runAgent` (o mesmo agente do LangGraph);
 *  - `useAgentContext()`: publica a página atual para o agente;
 *  - `useFrontendTool()`: registra a ferramenta de NAVEGAÇÃO no navegador.
 *
 * Divisão de responsabilidade (importante)
 * ----------------------------------------
 * A ferramenta `navigate_to_page` existe em dois transportes do MESMO contrato:
 *  - servidor (`src/site/tools.js`): decide e autoriza — é o que o modelo chama;
 *  - navegador (aqui): executa, e só para caminho presente na allowlist que o
 *    servidor publica em `/api/site/info`. O navegador nunca decide sozinho.
 *
 * Nada de credencial: este código fala apenas com `/api/copilot` da própria
 * origem; a chave do Gateway fica no servidor.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CopilotKitContext, CopilotKitCoreReact } from '@copilotkit/react-core/v2/context';
import { useAgent, useAgentContext, useFrontendTool } from '@copilotkit/react-core/v2/headless';

/**
 * Texto de uma mensagem v2.
 *
 * Na v2 o conteúdo pode vir como string ou como lista de partes
 * (`{type:'text', text}`), dependendo do agente/transporte. Sem isto o painel
 * mostrava `[object Object]` em algumas respostas.
 */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text ?? '' : ''))
      .join('')
      .trim();
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/** Provider mínimo: a v2 headless espera o contexto, não um componente. */
function KiranaProvider({ runtimeUrl, headers, children }) {
  const core = useMemo(
    () => new CopilotKitCoreReact({ runtimeUrl, ...(headers ? { headers } : {}) }),
    [runtimeUrl, headers],
  );
  useEffect(() => () => core.stopAll?.(), [core]);
  const value = useMemo(() => ({ copilotkit: core, executingToolCallIds: new Set() }), [core]);
  return React.createElement(CopilotKitContext.Provider, { value }, children);
}

/** Normaliza caminho no navegador (defesa em profundidade; o servidor decide). */
function safePath(raw) {
  const value = String(raw ?? '').trim();
  if (!value || /^(?:[a-z]+:)?\/\//i.test(value) || /^(?:javascript|data|file|vbscript):/i.test(value)) return null;
  if (!value.startsWith('/') || /\.\./.test(value)) return null;
  return value.split(/[?#]/)[0];
}

function KiranaPanel({ agentId, siteId, siteName = 'Opportunity AI', allowlist = [], onNavigate, initialPath }) {
  // O runtime da Kirana expõe o agente como `kirana` (não `default`): em v2 o
  // nome precisa ser explícito, senão o hook procura um agente inexistente.
  const { agent, isReady } = useAgent({ agentId });
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState(initialPath || (typeof location !== 'undefined' ? location.pathname : '/'));
  const listRef = useRef(null);

  /* ------------------------------- mensagens ------------------------------ */
  useEffect(() => {
    if (!agent) return undefined;
    const sync = () => setMessages(Array.isArray(agent.messages) ? [...agent.messages] : []);
    sync();
    const subscription = agent.subscribe?.({
      onMessagesChanged: sync,
      onRunInitialized: () => setBusy(true),
      onRunFinalized: () => setBusy(false),
      onRunFailed: () => setBusy(false),
    });
    return () => subscription?.unsubscribe?.();
  }, [agent]);

  useEffect(() => {
    listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight });
  }, [messages]);

  /* ------------------------------- contexto ------------------------------- */
  useAgentContext({
    description: 'Página do site que o visitante está vendo agora (informada pelo próprio site).',
    value: { siteId, siteName, path },
  });

  /* ---------------------------- ferramenta de UI -------------------------- */
  useFrontendTool(
    {
      name: 'navigate_to_page',
      description:
        'Abre uma página interna do site no navegador do visitante. Só caminhos da allowlist publicada pelo servidor são aceitos.',
      handler: async ({ path: target }) => {
        const clean = safePath(target);
        if (!clean) return { ok: false, erro: 'caminho inválido' };
        const allowed = allowlist.length === 0 || allowlist.some((route) => route.replace(/\/$/, '') === clean.replace(/\/$/, ''));
        if (!allowed) return { ok: false, erro: `rota não autorizada: ${clean}` };
        setPath(clean);
        if (onNavigate) onNavigate(clean);
        else if (typeof history !== 'undefined') history.pushState({ path: clean }, '', clean);
        return { ok: true, path: clean };
      },
    },
    [allowlist, onNavigate],
  );

  /* -------------------------------- enviar -------------------------------- */
  const send = useCallback(
    async (event) => {
      event?.preventDefault?.();
      const clean = text.trim();
      if (!clean || busy || !agent) return;
      setText('');
      setBusy(true);
      try {
        agent.addMessage?.({ id: `u_${Date.now()}`, role: 'user', content: clean });
        await agent.runAgent?.();
      } finally {
        setBusy(false);
      }
    },
    [agent, busy, text],
  );

  const bubbles = messages.filter((message) => message.role === 'user' || message.role === 'assistant');

  return React.createElement(
    'div',
    { className: 'kirana-v2', 'data-kirana-v2': 'true' },
    React.createElement(
      'header',
      { className: 'kirana-v2__head' },
      React.createElement('strong', null, 'Kirana'),
      React.createElement('span', null, isReady ? 'pronta' : 'conectando…'),
    ),
    React.createElement(
      'div',
      { className: 'kirana-v2__messages', ref: listRef },
      bubbles.length === 0
        ? React.createElement('p', { className: 'kirana-v2__hint' }, 'Pergunte sobre os serviços, peça para abrir uma página ou tirar dúvidas.')
        : bubbles.map((message, index) =>
            React.createElement(
              'div',
              { key: message.id || index, className: `kirana-v2__msg kirana-v2__msg--${message.role}` },
              messageText(message),
            ),
          ),
      busy ? React.createElement('p', { className: 'kirana-v2__hint' }, 'Kirana está respondendo…') : null,
    ),
    React.createElement(
      'form',
      { className: 'kirana-v2__composer', onSubmit: send },
      React.createElement('input', {
        value: text,
        onChange: (event) => setText(event.target.value),
        placeholder: 'Escreva para a Kirana…',
        'aria-label': 'Mensagem para a Kirana',
        disabled: !isReady,
      }),
      React.createElement('button', { type: 'submit', disabled: busy || !text.trim() }, 'Enviar'),
    ),
  );
}

/**
 * Monta o widget v2 num elemento (ou cria o host).
 *
 * @param {object} options
 * @param {string} [options.runtimeUrl]  URL do runtime AG-UI (padrão /api/copilot)
 * @param {string} [options.siteId]      id do site (isolamento por cliente)
 * @param {string} [options.siteName]
 * @param {string[]} [options.allowlist] rotas autorizadas (de /api/site/info)
 * @param {(path: string) => void} [options.onNavigate]
 * @param {HTMLElement} [options.target]
 */
export function mountKiranaV2({
  runtimeUrl = '/api/copilot',
  agentId = 'kirana',
  siteId = null,
  siteName = 'Opportunity AI',
  allowlist = [],
  onNavigate = null,
  initialPath = null,
  target = null,
} = {}) {
  const host = target ?? document.createElement('div');
  if (!target) {
    host.id = 'kirana-v2-root';
    document.body.appendChild(host);
  }
  createRoot(host).render(
    React.createElement(
      KiranaProvider,
      { runtimeUrl },
      React.createElement(KiranaPanel, { agentId, siteId, siteName, allowlist, onNavigate, initialPath }),
    ),
  );
  return host;
}

export { KiranaProvider, KiranaPanel, safePath };
