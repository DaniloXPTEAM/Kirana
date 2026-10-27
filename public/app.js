/**
 * Kirana — cliente da interface.
 *
 * Toda a comunicação passa por /api/* neste mesmo host. Nenhuma chave do
 * gateway existe no navegador; só um token opcional de acesso local.
 */

import { createStreamState, applyEvent, finalize, composerView, toolPillView } from './stream-state.js';
import { createVoiceController } from './voice.js';

/**
 * Modo embed (`/?embed=1`) — usado quando a interface é aberta dentro do iframe
 * do site (ver `public/widget/kirana-embed.js`).
 *
 * O painel embutido não precisa da barra lateral (conversas, ferramentas,
 * status): ela existe para o operador local. Esconder por CSS evita mudar
 * qualquer lógica e mantém a interface completa quando aberta direto.
 */
if (new URLSearchParams(location.search).get('embed') === '1') {
  document.documentElement.dataset.kiranaEmbed = '1';
  document.addEventListener('DOMContentLoaded', () => document.body.classList.add('kirana-embed'));
}

/**
 * Fase 4: contexto do site e execução de ações autorizadas.
 *
 * A Kirana só sabe onde o visitante está se o navegador contar. A página é
 * enviada em cada turno (e no carregamento), mas quem valida é o servidor:
 * aqui não há allowlist, só transporte.
 */
/**
 * Ponte do site (Fase 4/5).
 *
 * Resolvida a cada uso, não no carregamento: quem embute a Kirana pode anexar
 * `window.KiranaSite = { bridge }` depois do script principal (é o caso do
 * widget). Sem ponte, as ações do site continuam sendo apenas exibidas.
 */
const siteBridgeNow = () => window.KiranaSite?.bridge ?? null;
const siteConfig = window.KIRANA_SITE ?? { id: '', path: '', pageId: '' };

function currentSitePayload() {
  const params = new URLSearchParams(location.search);
  const path = siteConfig.path || params.get('path') || location.pathname;
  const pageId = params.get('page') || '';
  // Sem siteId explícito, o servidor usa o site configurado (KIRANA_SITE_ID) —
  // a interface aberta sozinha continua funcionando como antes.
  if (!siteConfig.id && !path && !pageId) return {};
  return { ...(siteConfig.id ? { siteId: siteConfig.id } : {}), path, pageId };
}

const state = {
  sessionId: null,
  sessionTitle: '',
  sessions: [],
  messages: [],
  streaming: false,
  controller: null,
  pendingAction: null,
  config: null,
  tools: [],
  models: { active: null },
  token: sessionStorage.getItem('kirana.token') || '',
};

/**
 * Ponte com a voz: o app avisa o controlador sobre o turno em andamento para
 * que a fala acompanhe o texto. Fica vazio quando a voz não está montada, e
 * nesse caso `sendMessage()` se comporta exatamente como antes.
 */
const voiceBridge = { delta: null, done: null };

const els = {
  app: document.getElementById('app'),
  sidebar: document.getElementById('sidebar'),
  scrim: document.getElementById('scrim'),
  history: document.getElementById('history'),
  historyEmpty: document.getElementById('history-empty'),
  toolList: document.getElementById('tool-list'),
  chat: document.getElementById('chat'),
  chatScroll: document.getElementById('chat-scroll'),
  welcome: document.getElementById('welcome'),
  suggestions: document.getElementById('suggestions'),
  composer: document.getElementById('composer'),
  input: document.getElementById('composer-input'),
  send: document.getElementById('send'),
  voiceBtn: document.getElementById('voice-btn'),
  voiceStatus: document.getElementById('voice-status'),
  voiceConfigBtn: document.getElementById('voice-config-btn'),
  voiceSettings: document.getElementById('voice-settings'),
  voiceEngine: document.getElementById('voice-engine'),
  voiceSelect: document.getElementById('voice-select'),
  voiceRate: document.getElementById('voice-rate'),
  voicePreview: document.getElementById('voice-preview'),
  voiceSettingsHint: document.getElementById('voice-settings-hint'),
  stop: document.getElementById('stop'),
  composerStatus: document.getElementById('composer-status'),
  composerStatusText: document.getElementById('composer-status-text'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  modelPill: document.getElementById('model-pill'),
  sessionTitle: document.getElementById('session-title'),
  newChat: document.getElementById('new-chat'),
  sidebarOpen: document.getElementById('sidebar-open'),
  sidebarClose: document.getElementById('sidebar-close'),
  refreshStatus: document.getElementById('refresh-status'),
  memoryBtn: document.getElementById('open-memory'),
  memoryCount: document.getElementById('memory-count'),
  memoryModal: document.getElementById('memory-modal'),
  memoryClose: document.getElementById('memory-close'),
  memoryList: document.getElementById('memory-list'),
  memoryForm: document.getElementById('memory-form'),
  memoryError: document.getElementById('memory-error'),
  toast: document.getElementById('toast'),
};

/* ------------------------------- utilidades ------------------------------ */

function apiHeaders(extra = {}) {
  const headers = { ...extra };
  if (state.token) headers['X-Kirana-Token'] = state.token;
  return headers;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: apiHeaders({
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Falha na requisição (HTTP ${response.status}).`);
    error.code = payload?.error?.code || `http_${response.status}`;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Markdown mínimo e seguro (sem dependências, sem HTML cru). */
function formatHtml(text) {
  const escaped = escapeHtml(text || '');
  const blocks = escaped.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split('\n');
      const inline = (line) =>
        line
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
          .replace(/(https?:\/\/[^\s<)"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

      if (lines.every((line) => /^\s*[-*•]\s+/.test(line))) {
        return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
        return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
      }
      return `<p>${lines.map(inline).join('<br />')}</p>`;
    })
    .join('');
}

function toast(message, ms = 3200) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
}

function nearBottom() {
  const { scrollTop, scrollHeight, clientHeight } = els.chatScroll;
  return scrollHeight - (scrollTop + clientHeight) < 160;
}

function scrollToBottom(force = false) {
  if (force || nearBottom()) {
    requestAnimationFrame(() => {
      els.chatScroll.scrollTop = els.chatScroll.scrollHeight;
    });
  }
}

/* ------------------------------- SSE cliente ----------------------------- */

async function consumeSse(response, onEvent) {
  if (!response.body) throw new Error('O navegador não suporta streaming nesta conexão.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleFrame = (frame) => {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    if (!raw || raw === '[DONE]') return;
    try {
      onEvent(JSON.parse(raw));
    } catch {
      /* frame inválido: ignora */
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let match = buffer.match(/\r?\n\r?\n/);
    while (match) {
      const index = buffer.indexOf(match[0]);
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + match[0].length);
      handleFrame(frame);
      match = buffer.match(/\r?\n\r?\n/);
    }
  }
  if (buffer.trim()) handleFrame(buffer);
}

/* --------------------------------- render -------------------------------- */

/**
 * Avatar da Kirana — a MESMA face do cabeçalho e da tela de boas-vindas.
 *
 * Antes era um quadrado com a letra "K", diferente do rosto usado no cabeçalho:
 * ainterface mostrava duas "Kiranas" (rosto em cima, letra nas mensagens).
 */
function kiranaAvatar() {
  return el('div', {
    class: 'msg-avatar msg-avatar-kirana',
    'aria-hidden': 'true',
    html: '<svg viewBox="0 0 64 64" focusable="false"><use href="#kirana-face" /></svg>',
  });
}

/**
 * Avatar do usuário — ícone de pessoa, não a palavra "Você".
 *
 * Defeito da v0.4.2: a palavra "Você" em 34 px estourava o círculo e o texto
 * aparecia por cima/fora da bolha como um selo solto (o "Voz" fantasma que se
 * via na tela). Ícone não transborda em nenhum tamanho de fonte do sistema.
 */
function userAvatar() {
  return el('div', {
    class: 'msg-avatar msg-avatar-user',
    'aria-hidden': 'true',
    html: '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" fill="currentColor"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
  });
}

/**
 * Remove o cartão de boas-vindas do fluxo.
 *
 * v0.4.3 — antes ele só saía quando a PRIMEIRA RESPOSTA chegava
 * (`createAssistantShell`). Na prática a tela ficava com o cartão "Oi! Eu sou a
 * Kirana" (rosto + título + sugestões) logo acima da conversa em andamento: a
 * impressão era de dois agentes empilhados, um atrás do outro. Agora ele sai no
 * primeiro sinal de conversa — mensagem do usuário, mensagem da Kirana ou
 * restauração de uma sessão com histórico.
 */
function hideWelcome() {
  if (els.welcome && els.welcome.isConnected) els.welcome.remove();
}

function createAssistantShell() {
  hideWelcome();
  const bubble = el('div', { class: 'bubble' });
  const typing = el('div', { class: 'typing', html: '<span></span><span></span><span></span>' });
  bubble.appendChild(typing);
  const meta = el('div', { class: 'msg-meta' });
  const body = el('div', { class: 'msg-body' }, bubble, meta);
  const node = el(
    'article',
    { class: 'msg assistant', dataset: { role: 'assistant' } },
    kiranaAvatar(),
    body,
  );
  els.chat.appendChild(node);
  scrollToBottom(true);
  return { node, bubble, meta, typing, body };
}

function addUserMessage(text) {
  hideWelcome();
  const bubble = el('div', { class: 'bubble', html: formatHtml(text) });
  const node = el(
    'article',
    { class: 'msg user', dataset: { role: 'user' } },
    userAvatar(),
    el('div', { class: 'msg-body' }, bubble),
  );
  els.chat.appendChild(node);
  scrollToBottom(true);
  return node;
}

function addAssistantMessage(text, meta = {}) {
  const shell = createAssistantShell();
  shell.typing.remove();
  shell.bubble.innerHTML = formatHtml(text);
  if (meta.model) shell.meta.appendChild(el('span', { class: 'pill', text: meta.model }));
  if (meta.aborted) shell.meta.appendChild(el('span', { class: 'pill', text: 'interrompida' }));
  if (Number.isFinite(meta.ttftMs)) shell.meta.appendChild(el('span', { class: 'pill', text: `${formatMs(meta.ttftMs)} até 1º token` }));
  return shell;
}

function addAlert(container, message, { onRetry, info = false } = {}) {
  const body = el('div', { class: 'alert-body' }, el('span', { text: message }));
  if (onRetry) {
    body.appendChild(
      el(
        'button',
        { class: 'btn btn-ghost retry', type: 'button', onclick: onRetry },
        'Tentar novamente',
      ),
    );
  }
  const icon = el('div', {
    html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.6" r="1.2" fill="currentColor"/><path d="M12 3.2 2.8 19.4h18.4L12 3.2Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  });
  container.appendChild(el('div', { class: `alert${info ? ' info' : ''}`, role: 'alert' }, icon, body));
  scrollToBottom();
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function addToolPill(meta, { name, title, ok, pending, errorCode }) {
  // A pílula mostra o RESULTADO da ferramenta. Antes ela imprimia "· ok" mesmo
  // quando `ok === false` — a interface dizia sucesso para uma falha real.
  const view = toolPillView({ name, title, ok, pending, errorCode });
  meta.appendChild(el('span', { class: `pill tool-${view.tone}`, text: view.label }));
  scrollToBottom();
  return view;
}

function renderConfirmation(action, { resolved = false, outcome = '' } = {}) {
  const card = el('div', { class: `confirm-card${resolved ? ' resolved' : ''}`, dataset: { actionId: action.id } });
  card.appendChild(el('h3', { text: 'Confirmação necessária' }));
  card.appendChild(el('p', { class: 'summary', text: action.summary }));
  card.appendChild(el('p', { class: 'note', text: 'Nada é gravado nem enviado antes da sua confirmação.' }));

  const actions = el('div', { class: 'confirm-actions' });
  const yes = el('button', { class: 'btn btn-primary', type: 'button', text: 'Sim, confirmar' });
  const no = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Não, cancelar' });
  yes.addEventListener('click', () => confirmAction(action, true, card));
  no.addEventListener('click', () => confirmAction(action, false, card));
  actions.append(yes, no);
  card.appendChild(actions);

  if (resolved && outcome) card.appendChild(el('p', { class: 'outcome', text: outcome }));
  return card;
}

/**
 * Pedido de dados da Kirana.
 *
 * Deliberadamente NÃO é um formulário que envia sozinho: os campos vêm do
 * conhecimento do site, e o envio acontece onde o site já trata dados
 * (formulário de contato ou WhatsApp). Assim a Kirana pede, mas não coleta
 * nem armazena dado do visitante por conta própria.
 */
function renderInputRequest(container, action) {
  const campos = Array.isArray(action.campos) ? action.campos : [];
  const card = el('div', { class: 'confirm-card input-card' });
  // A ferramenta manda `motivo` + `campos[{nome,rotulo,tipo,obrigatorio}]`.
  card.appendChild(el('p', { class: 'confirm-title', text: action.titulo || action.motivo || 'Dados necessários para começar' }));
  if (campos.length) {
    const list = el('ul', { class: 'input-list' });
    for (const campo of campos) {
      if (typeof campo === 'string') {
        list.appendChild(el('li', { text: campo }));
        continue;
      }
      const label = campo.rotulo || campo.label || campo.nome || campo.name || '';
      if (!label) continue;
      const required = campo.obrigatorio ? ' *' : '';
      const why = campo.porque ? ` — ${campo.porque}` : campo.tipo ? ` (${campo.tipo})` : '';
      list.appendChild(el('li', { text: `${label}${required}${why}` }));
    }
    card.appendChild(list);
  }
  if (action.observacao) card.appendChild(el('p', { class: 'confirm-note', text: action.observacao }));
  card.appendChild(
    el('p', {
      class: 'confirm-note',
      text: 'Nada é enviado automaticamente. Os dados são preenchidos por você no formulário do site ou no WhatsApp indicado.',
    }),
  );
  if (action.path) {
    const open = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Abrir formulário do site' });
    open.addEventListener('click', () => siteBridgeNow()?.apply({ type: 'navigate', path: action.path }));
    card.appendChild(open);
  }
  container.appendChild(card);
  scrollToBottom(true);
}

/**
 * Pedido de arquivo (Fase 5).
 *
 * O botão abre o seletor nativo; o arquivo vai por `bridge.uploadFile` para o
 * endpoint da solicitação, onde tipo, tamanho e assinatura são conferidos. A
 * interface nunca afirma sucesso sem a resposta do servidor — e mostra o erro
 * real quando há um.
 */
function renderUploadRequest(container, action) {
  const card = el('div', { class: 'confirm-card input-card upload-card' });
  card.appendChild(el('p', { class: 'confirm-title', text: 'Anexar arquivo' }));
  if (action.motivo) card.appendChild(el('p', { class: 'confirm-note', text: action.motivo }));
  card.appendChild(
    el('p', {
      class: 'confirm-note',
      text: `Aceitos: ${action.accept || 'arquivos comuns'} · até ${action.maxMb ?? 5} MB · máximo ${action.maxFiles ?? 5} arquivo(s). O arquivo é guardado só nesta solicitação e não é executado.`,
    }),
  );

  const status = el('p', { class: 'confirm-note' });
  const button = el('button', { class: 'btn btn-primary', type: 'button', text: 'Escolher arquivo' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Abrindo seletor de arquivo…';
    const picked = await (siteBridgeNow()?.pickFile?.({ accept: action.accept, maxMb: action.maxMb ?? 5 }) ?? { ok: false, reason: 'no_bridge' });
    if (!picked.ok) {
      status.textContent =
        picked.reason === 'cancelled' ? 'Nenhum arquivo escolhido.' : picked.message || `Não foi possível anexar (${picked.reason}).`;
      button.disabled = false;
      return;
    }
    status.textContent = 'Enviando para o servidor…';
    const uploaded = await siteBridgeNow().uploadFile({ requestId: action.requestId, file: picked.file, sessionId: state.sessionId });
    if (uploaded.ok) {
      status.textContent = `Anexado: ${uploaded.file.nome} (${Math.round(uploaded.file.tamanho / 1024)} KB).`;
    } else {
      status.textContent = uploaded.message || `O servidor recusou o arquivo (${uploaded.reason}).`;
      button.disabled = false;
    }
  });

  card.appendChild(button);
  card.appendChild(status);
  container.appendChild(card);
  scrollToBottom(true);
}

function markCardResolved(card, outcome) {
  card.classList.add('resolved');
  const actions = card.querySelector('.confirm-actions');
  if (actions) actions.remove();
  if (outcome) card.appendChild(el('p', { class: 'outcome', text: outcome }));
}

/* ------------------------------- histórico ------------------------------- */

function renderHistory() {
  els.history.innerHTML = '';
  els.historyEmpty.hidden = state.sessions.length > 0;
  for (const session of state.sessions) {
    const del = el('button', {
      class: 'del',
      type: 'button',
      title: 'Apagar conversa',
      'aria-label': `Apagar conversa ${session.title}`,
      html: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
      onclick: async (event) => {
        event.stopPropagation();
        await deleteSession(session.id);
      },
    });
    const item = el(
      'li',
      {},
      el(
        'button',
        {
          class: 'history-item',
          type: 'button',
          'aria-current': String(session.id === state.sessionId),
          onclick: () => loadSession(session.id),
        },
        el('span', { class: 'title', text: session.title }),
        session.hasPendingAction ? el('span', { class: 'dot-pending', title: 'Ação aguardando confirmação' }) : null,
        del,
      ),
    );
    els.history.appendChild(item);
  }
}

async function refreshHistory() {
  try {
    const data = await api('/api/sessions');
    state.sessions = data.sessions || [];
    renderHistory();
  } catch {
    /* silencioso */
  }
}

async function deleteSession(id) {
  try {
    await api(`/api/session/${id}`, { method: 'DELETE' });
    if (id === state.sessionId) {
      state.sessionId = null;
      localStorage.removeItem('kirana.session');
    }
    await refreshHistory();
    if (!state.sessionId) await startNewSession({ silent: true });
    toast('Conversa apagada.');
  } catch (error) {
    toast(`Não foi possível apagar: ${error.message}`);
  }
}

/* -------------------------------- sessões -------------------------------- */

function renderSessionMessages(session) {
  els.chat.innerHTML = '';
  if (els.welcome) els.chat.appendChild(els.welcome);
  const hasMessages = (session.messages || []).length > 0;
  if (hasMessages && els.welcome) els.welcome.remove();

  for (const message of session.messages || []) {
    if (message.role === 'user') addUserMessage(message.content);
    else if (message.role === 'assistant') {
      const shell = addAssistantMessage(message.content, { model: message.model, aborted: message.aborted });
      if (message.tools?.length) {
        for (const tool of message.tools) addToolPill(shell.meta, { name: tool, title: state.tools.find((t) => t.name === tool)?.title || tool, ok: true });
      }
    }
  }

  if (session.pendingAction) {
    state.pendingAction = session.pendingAction;
    const shell = createAssistantShell();
    shell.typing.remove();
    shell.bubble.remove();
    shell.body.appendChild(renderConfirmation(session.pendingAction));
  } else {
    state.pendingAction = null;
  }

  els.sessionTitle.textContent = session.title || 'Conversa nova';
  document.title = `${session.title || 'Kirana'} · Opportunity AI`;
  scrollToBottom(true);
}

async function loadSession(id) {
  try {
    const session = await api(`/api/session/${id}`);
    state.sessionId = session.id;
    state.sessionTitle = session.title;
    state.messages = session.messages || [];
    localStorage.setItem('kirana.session', id);
    renderSessionMessages(session);
    renderHistory();
    closeSidebar();
  } catch (error) {
    toast(`Não foi possível abrir a conversa: ${error.message}`);
    if (error.status === 404) {
      localStorage.removeItem('kirana.session');
      await startNewSession({ silent: true });
    }
  }
}

async function startNewSession({ silent = false } = {}) {
  if (state.streaming) stopGeneration();
  try {
    const session = await api('/api/session', { method: 'POST', body: JSON.stringify({}) });
    state.sessionId = session.id;
    state.sessionTitle = session.title;
    state.messages = [];
    state.pendingAction = null;
    localStorage.setItem('kirana.session', session.id);
    els.chat.innerHTML = '';
    if (els.welcome) {
      els.welcome.hidden = false;
      els.chat.appendChild(els.welcome);
    }
    els.sessionTitle.textContent = 'Conversa nova';
    document.title = 'Kirana · Opportunity AI';
    els.input.value = '';
    autogrow();
    els.input.focus();
    await refreshHistory();
    renderHistory();
    closeSidebar();
    if (!silent) toast('Nova conversa iniciada.');
  } catch (error) {
    toast(`Não foi possível criar a conversa: ${error.message}`);
  }
}

/* --------------------------------- envio --------------------------------- */

/**
 * Aplica a visão do compositor (spinner / rótulo / botão Interromper).
 * A decisão de mostrar ou não vem de `stream-state.js` — nunca de flags soltas.
 */
function setStreamingUI(active, label) {
  state.streaming = active;
  els.composerStatus.hidden = !active;
  els.composerStatus.setAttribute('aria-hidden', String(!active));
  if (active && label) els.composerStatusText.textContent = label;
  els.send.disabled = active;
  els.input.setAttribute('aria-busy', String(active));
}

/** Sincroniza a UI com o estado do stream. */
function syncComposer(streamState) {
  const view = composerView(streamState);
  setStreamingUI(view.busy, view.label);
}

async function sendMessage(text) {
  if (state.streaming) return;
  const clean = text.trim();
  if (!clean) return;
  if (!state.sessionId) {
    await startNewSession({ silent: true });
    if (!state.sessionId) return;
  }

  els.input.value = '';
  autogrow();
  hideWelcome(); // a conversa começou: o cartão de boas-vindas não fica na tela
  addUserMessage(clean);

  // Se havia uma ação pendente e o usuário seguiu a conversa, o backend a cancela.
  const staleCard = els.chat.querySelector('.confirm-card:not(.resolved)');
  if (staleCard) markCardResolved(staleCard, 'Cancelada: a conversa continuou sem confirmação.');

  const shell = createAssistantShell();
  const controller = new AbortController();
  state.controller = controller;

  let stream = createStreamState();
  stream = applyEvent(stream, { type: 'start' });
  syncComposer(stream);

  let buffer = '';
  let gotFirstDelta = false;
  let aborted = false;
  let hadError = false;
  let toolFailures = 0;
  let pendingActionFromTurn = null;

  const paint = () => {
    if (!gotFirstDelta) {
      shell.typing.remove();
      gotFirstDelta = true;
    }
    shell.bubble.innerHTML = formatHtml(buffer);
    shell.bubble.classList.add('cursor');
    scrollToBottom();
  };

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify({ sessionId: state.sessionId, message: clean, ...currentSitePayload() }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw Object.assign(new Error(payload?.error?.message || `Falha (HTTP ${response.status}).`), {
        code: payload?.error?.code,
        status: response.status,
      });
    }

    await consumeSse(response, (event) => {
      // O estado do compositor é sempre derivado do evento, num único lugar.
      stream = applyEvent(stream, event);
      syncComposer(stream);

      switch (event.type) {
        case 'session':
          if (event.title) {
            els.sessionTitle.textContent = event.title;
          }
          break;
        case 'start':
          state.models.active = event.model;
          els.modelPill.textContent = event.model;
          break;
        case 'delta':
          buffer += event.text;
          paint();
          voiceBridge.delta?.(event.text);
          break;
        case 'tool_result': {
          shell.bubble.classList.remove('cursor');
          const pendente = event.errorCode === 'confirmation_required';
          addToolPill(shell.meta, { name: event.name, title: event.title, ok: event.ok, pending: pendente, errorCode: event.errorCode });
          // Falha de FERRAMENTA é diferente de falha de TRANSPORTE: o stream
          // pode terminar bem e a ferramenta ter falhado.
          if (event.ok === false && !pendente) toolFailures += 1;
          break;
        }
        case 'confirmation':
          pendingActionFromTurn = event.action;
          break;
        case 'site_action': {
          // O servidor autorizou; o navegador executa. Se a ação for
          // desconhecida, a ponte registra e ignora — nada de `eval`.
          const action = event.action || {};
          if (action.type === 'request_input') {
            shell.bubble.classList.remove('cursor');
            renderInputRequest(shell.node.querySelector('.msg-body'), action);
            break;
          }
          if (action.type === 'request_upload') {
            shell.bubble.classList.remove('cursor');
            renderUploadRequest(shell.node.querySelector('.msg-body'), action);
            break;
          }
          const bridge = siteBridgeNow();
          const result = bridge ? bridge.apply(action) : { ok: false, reason: 'no_bridge' };
          if (action.type === 'fill_form') {
            // Preencher não envia: o cartão diz o que foi escrito e nada mais.
            const filled = Array.isArray(result?.fields) ? result.fields : [];
            shell.meta.appendChild(
              el('span', {
                class: 'pill',
                text: filled.length
                  ? `Preenchi ${filled.length} campo(s) do formulário (nada foi enviado)`
                  : 'Não há esse formulário nesta tela — nada foi preenchido',
              }),
            );
            break;
          }
          if (result?.ok && action.type === 'navigate') {
            shell.meta.appendChild(el('span', { class: 'pill', text: `Navegando para ${result.path}` }));
          } else if (action.type === 'navigate') {
            // Modo autônomo (interface sem site embutido): mostra a intenção sem
            // navegar de verdade — a interface não é o site.
            shell.meta.appendChild(el('span', { class: 'pill', text: `Ação do site: abrir ${action.path}` }));
          }
          break;
        }
        case 'done':
          if (toolFailures > 0) {
            shell.meta.appendChild(
              el('span', {
                class: 'pill tool-fail',
                text: toolFailures === 1 ? '1 ferramenta com falha nesta resposta' : `${toolFailures} ferramentas com falha nesta resposta`,
              }),
            );
          }
          if (event.ttftMs) shell.meta.appendChild(el('span', { class: 'pill', text: `${formatMs(event.ttftMs)} até 1º token` }));
          if (event.totalMs) shell.meta.appendChild(el('span', { class: 'pill', text: `${formatMs(event.totalMs)} total` }));
          if (event.model) {
            els.modelPill.textContent = event.model;
            state.models.active = event.model;
          }
          if (event.aborted) aborted = true;
          break;
        case 'error':
          hadError = true;
          shell.bubble.classList.remove('cursor');
          addAlert(shell.node.querySelector('.msg-body'), event.message, {
            onRetry: () => sendMessage(clean),
          });
          break;
        default:
          break;
      }
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      aborted = true;
    } else {
      hadError = true;
      shell.bubble.classList.remove('cursor');
      addAlert(shell.node.querySelector('.msg-body'), error.message || 'Não foi possível falar com o backend.', {
        onRetry: () => sendMessage(clean),
      });
    }
  } finally {
    shell.bubble.classList.remove('cursor');
    if (gotFirstDelta && !buffer.trim()) {
      shell.bubble.innerHTML = '<p><em>(resposta vazia)</em></p>';
    }
    if (!gotFirstDelta && !hadError) {
      shell.typing.remove();
      if (!aborted) shell.bubble.innerHTML = '<p><em>Sem resposta do modelo.</em></p>';
    }
    if (aborted) {
      if (!buffer.trim()) shell.bubble.innerHTML = '<p><em>Geração interrompida.</em></p>';
      shell.meta.appendChild(el('span', { class: 'pill', text: 'interrompida' }));
    }
    if (hadError && !buffer.trim()) {
      shell.bubble.remove();
    }
    if (pendingActionFromTurn) {
      state.pendingAction = pendingActionFromTurn;
      shell.body.appendChild(renderConfirmation(pendingActionFromTurn));
    }
    // Fecha o turno em QUALQUER desfecho, inclusive stream encerrado sem `done`.
    stream = finalize(stream, { aborted, error: hadError });
    syncComposer(stream);
    if (stream.reason && stream.reason !== 'completed' && stream.reason !== 'aborted') {
      console.debug('[kirana] turno encerrado:', stream.reason);
    }
    state.controller = null;
    await refreshHistory();
    scrollToBottom();
    els.input.focus();
    // Avisa a voz do desfecho: só aqui sabemos se houve erro/interrupção.
    voiceBridge.done?.({
      // Sem `text`: o controlador de voz fala apenas o resto não falado.
      // Passar a resposta inteira aqui fazia a Kirana repetir tudo no fim.
      aborted,
      error: hadError,
      pendingAction: pendingActionFromTurn,
    });
  }
}

async function confirmAction(action, approve, card) {
  if (state.streaming) return;
  for (const button of card.querySelectorAll('button')) button.disabled = true;

  const shell = createAssistantShell();
  const controller = new AbortController();
  state.controller = controller;
  let stream = createStreamState();
  stream = applyEvent(stream, { type: 'status', label: approve ? 'Executando a ação confirmada…' : 'Cancelando…' });
  syncComposer(stream);

  let buffer = '';
  let gotFirstDelta = false;

  const paint = () => {
    if (!gotFirstDelta) {
      shell.typing.remove();
      gotFirstDelta = true;
    }
    shell.bubble.innerHTML = formatHtml(buffer);
    scrollToBottom();
  };

  try {
    const response = await fetch('/api/chat/confirm', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify({ sessionId: state.sessionId, actionId: action.id, approve }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw Object.assign(new Error(payload?.error?.message || `Falha (HTTP ${response.status}).`), { status: response.status });
    }

    await consumeSse(response, (event) => {
      stream = applyEvent(stream, event);
      syncComposer(stream);

      if (event.type === 'delta') {
        buffer += event.text;
        paint();
      } else if (event.type === 'tool_result') {
        addToolPill(shell.meta, { name: event.name, title: event.title, ok: event.ok, errorCode: event.errorCode });
      } else if (event.type === 'done') {
        if (event.totalMs) shell.meta.appendChild(el('span', { class: 'pill', text: `${formatMs(event.totalMs)} total` }));
        markCardResolved(card, approve ? 'Ação executada com confirmação.' : 'Ação cancelada por você.');
      } else if (event.type === 'error') {
        addAlert(shell.node.querySelector('.msg-body'), event.message);
        markCardResolved(card, 'A ação não pôde ser concluída.');
      }
    });
  } catch (error) {
    addAlert(shell.node.querySelector('.msg-body'), error.message || 'Falha ao confirmar a ação.');
    for (const button of card.querySelectorAll('button')) button.disabled = false;
  } finally {
    shell.typing.remove();
    if (!buffer.trim() && !shell.node.querySelector('.alert')) {
      shell.bubble.innerHTML = approve
        ? '<p>Ação concluída.</p>'
        : '<p>Sem problemas, não registrei nada.</p>';
    }
    state.pendingAction = null;
    voiceNoticeUntil = 0;
    voiceBridge.done?.({ aborted: false, error: false, pendingAction: null });
    stream = finalize(stream, { aborted: false });
    syncComposer(stream);
    state.controller = null;
    await refreshHistory();
    scrollToBottom();
  }
}

function stopGeneration() {
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  // O `finally` de sendMessage também encerra; aqui garantimos resposta imediata
  // ao clique, sem esperar o próximo tick de rede.
  setStreamingUI(false);
  state.streaming = false;
}

/* -------------------------------- memória -------------------------------- */

async function openMemory() {
  els.memoryModal.showModal();
  els.memoryError.hidden = true;
  await loadMemory();
}

async function loadMemory() {
  try {
    const data = await api('/api/memory');
    const items = data.items || [];
    els.memoryCount.textContent = String(items.length);
    els.memoryList.innerHTML = '';
    if (!items.length) {
      els.memoryList.appendChild(el('li', { class: 'empty-hint', text: 'Nada guardado ainda.' }));
      return;
    }
    for (const item of items) {
      els.memoryList.appendChild(
        el(
          'li',
          { class: 'memory-item' },
          el(
            'div',
            { style: 'min-width:0' },
            el('div', { class: 'key', text: item.key }),
            el('div', { class: 'value', text: item.value }),
          ),
          el('button', {
            type: 'button',
            title: 'Apagar',
            'aria-label': `Apagar ${item.key}`,
            html: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
            onclick: async () => {
              await api(`/api/memory/${item.id}`, { method: 'DELETE' });
              await loadMemory();
            },
          }),
        ),
      );
    }
  } catch (error) {
    toast(`Não foi possível carregar a memória: ${error.message}`);
  }
}

/* --------------------------------- status -------------------------------- */

async function loadStatus() {
  try {
    const status = await api('/api/status');
    const gateway = status.gateway || {};
    if (!gateway.configured) {
      els.statusDot.className = 'dot warn';
      els.statusText.textContent = 'Gateway sem chave configurada';
    } else if (gateway.reachable) {
      els.statusDot.className = 'dot ok';
      els.statusText.textContent = 'Gateway conectado';
    } else {
      els.statusDot.className = 'dot err';
      els.statusText.textContent = 'Gateway inacessível';
    }
    const model = status.model || {};
    els.modelPill.textContent = model.active || '—';
    els.modelPill.title = model.note || `Modelo ativo: ${model.active}. Fallback: ${model.fallback}`;
    state.models.active = model.active;
  } catch {
    els.statusDot.className = 'dot err';
    els.statusText.textContent = 'Backend indisponível';
  }
}

async function loadTools() {
  try {
    const data = await api('/api/tools');
    state.tools = data.tools || [];
    els.toolList.innerHTML = '';
    for (const tool of state.tools) {
      els.toolList.appendChild(
        el(
          'li',
          {},
          el('span', { class: `kind ${tool.kind}`, text: tool.kind === 'write' ? 'escrita' : 'leitura' }),
          el('span', { text: tool.title }),
        ),
      );
    }
  } catch {
    /* silencioso */
  }
}

async function loadConfig() {
  try {
    state.config = await api('/api/config');
    if (state.config.requiresAccessToken && !state.token) {
      const token = window.prompt('Esta instalação exige um token de acesso local (KIRANA_ACCESS_TOKEN):');
      if (token) {
        state.token = token.trim();
        sessionStorage.setItem('kirana.token', state.token);
      }
    }
  } catch {
    /* silencioso */
  }
}

/* ------------------------------- interação ------------------------------- */

function autogrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 168)}px`;
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  els.scrim.hidden = true;
}

function openSidebar() {
  document.body.classList.add('sidebar-open');
  els.scrim.hidden = false;
}

function bindEvents() {
  els.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage(els.input.value);
  });

  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage(els.input.value);
    }
  });
  els.input.addEventListener('input', autogrow);

  els.stop.addEventListener('click', stopGeneration);
  els.newChat.addEventListener('click', () => startNewSession());
  els.sidebarOpen.addEventListener('click', openSidebar);
  els.sidebarClose.addEventListener('click', closeSidebar);
  els.scrim.addEventListener('click', closeSidebar);
  els.refreshStatus.addEventListener('click', () => {
    loadStatus();
    toast('Status atualizado.');
  });

  els.suggestions.addEventListener('click', (event) => {
    const button = event.target.closest('.chip');
    if (button) sendMessage(button.textContent);
  });

  els.memoryBtn.addEventListener('click', openMemory);
  els.memoryClose.addEventListener('click', () => els.memoryModal.close());
  els.memoryModal.addEventListener('click', (event) => {
    if (event.target === els.memoryModal) els.memoryModal.close();
  });

  els.memoryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(els.memoryForm);
    els.memoryError.hidden = true;
    try {
      await api('/api/memory', {
        method: 'POST',
        body: JSON.stringify({
          key: form.get('key'),
          value: form.get('value'),
          consent: form.get('consent') === 'on',
          category: 'contexto',
        }),
      });
      els.memoryForm.reset();
      await loadMemory();
      toast('Informação guardada com sua autorização.');
    } catch (error) {
      els.memoryError.textContent = error.message;
      els.memoryError.hidden = false;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSidebar();
  });
}

/* ---------------------------------- voz ---------------------------------- */

/**
 * Liga o botão de voz ao MESMO `sendMessage()` do texto. Nenhuma sessão
 * paralela é criada: o que o visitante fala vira uma mensagem normal na
 * conversa atual, com o mesmo histórico e as mesmas ferramentas.
 */
const VOICE_LABEL = {
  inativo: { text: '', label: 'Conversar por voz com a Kirana', title: 'Falar com a Kirana' },
  'pedindo-microfone': { text: 'Permita o microfone no navegador para conversar.', label: 'Aguardando permissão do microfone', title: 'Permita o microfone' },
  ouvindo: { text: 'Estou ouvindo… fale normalmente.', label: 'Kirana está ouvindo', title: 'Ouvindo — toque para parar' },
  'fala-detectada': { text: 'Registrando o que você disse…', label: 'Captando sua fala', title: 'Captando sua fala' },
  processando: { text: 'Pensando na resposta…', label: 'Kirana está pensando', title: 'Pensando — toque para cancelar' },
  falando: { text: 'Falando… toque no botão para interromper.', label: 'Kirana está falando', title: 'Falando — toque para interromper' },
  interrompido: { text: 'Interrompido.', label: 'Fala interrompida', title: 'Interrompido' },
  erro: { text: 'A voz encontrou um problema.', label: 'Erro na voz', title: 'Erro na voz' },
};

let voice = null;

function setupVoice() {
  if (!els.voiceBtn) return;

  // O controlador é sempre criado: quando o navegador não tem
  // SpeechRecognition ele mesmo avisa (sem quebrar o chat por texto).
  const sttSupported = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  if (!sttSupported) {
    els.voiceBtn.title = 'Voz indisponível neste navegador — use o texto';
    els.voiceBtn.setAttribute('aria-label', 'Voz indisponível: use o texto');
  }

  voice = createVoiceController({
    send: async (text) => {
      // Se ainda houver resposta em andamento, falar interrompe (barge-in).
      if (state.streaming) stopGeneration();
      await sendMessage(text);
    },
    stop: () => stopGeneration(),
    getSessionId: () => state.sessionId,
    headers: () => apiHeaders(),
  });

  // Superfície de depuração/teste (não é API pública da Kirana).
  window.kiranaVoice = voice;

  /**
   * Diagnóstico da voz no console do navegador:
   *
   *   await window.kiranaVoiceReport()   // tabela: turno, segmento, texto, tempos
   *
   * Compara o que o navegador pediu para falar com o que o servidor realmente
   * enviou ao motor (já limpo). Se os textos diferirem, a limpeza alterou algo;
   * se aparecer palavra que não existe no chat, o problema está no motor.
   * Nada aqui é enviado para fora: fica na memória do navegador e do servidor.
   */
  window.kiranaVoiceReport = async () => {
    const report = await voice.report();
    const linhas = report.server.map((entry) => ({
      turno: entry.turnId,
      segmento: entry.segmentId,
      recebido: entry.receivedChars,
      enviado_ao_motor: entry.text_sent_to_tts,
      descartados: entry.droppedChars.join(' ') || '',
      '1o_byte_ms': entry.firstByteMs,
      total_ms: entry.totalMs,
      bytes: entry.bytes,
      resultado: entry.outcome,
    }));
    console.table(linhas);
    console.log('motor:', report.settings?.engine, '· voz:', report.settings?.voice?.name, '· taxa:', report.settings?.rate);
    console.log('estados:', report.states.map((s) => (s.reason ? `${s.to}(${s.reason})` : s.to)).join(' → '));
    console.log('navegador:', report.browser);
    // v0.4.4 — interrupções por voz: latência medida do comando até o áudio parar.
    if (report.bargeIns?.length) {
      console.table(report.bargeIns.map((b) => ({
        turno: b.turnId,
        palavra: b.keyword,
        tipo: b.kind,
        motor: b.engine,
        antes: b.stateBefore,
        'latencia_ms': b.latencyMs,
      })));
    } else {
      console.log('interrupções por voz:', 'nenhuma nesta sessão');
    }
    console.log('proteção de eco:', report.echoGuard);
    return report;
  };

  voiceBridge.delta = (text) => voice?.appendDelta(text);
  voiceBridge.done = (info) => voice?.endTurn(info);

  voice.subscribe((next, detail) => {
    const view = VOICE_LABEL[next] || VOICE_LABEL.inativo;
    els.voiceBtn.dataset.state = next;
    els.voiceBtn.setAttribute('aria-pressed', String(next !== 'inativo'));
    els.voiceBtn.setAttribute('aria-label', view.label);
    els.voiceBtn.title = view.title;
    if (next === 'inativo') {
      els.voiceStatus.hidden = true;
      els.voiceStatus.textContent = '';
      els.voiceStatus.classList.remove('is-error');
    } else {
      // No erro, a mensagem específica ("microfone negado", "motor falhou")
      // vale mais que o rótulo genérico do estado.
      const message = next === 'erro' ? detail?.message || voice.notice || view.text : view.text;
      // Não apaga um aviso importante (erro/confirmação) que acabou de aparecer.
      if (next === 'erro' || Date.now() >= voiceNoticeUntil) showVoiceStatus(message, next === 'erro');
    }
  });

  setupVoiceSettings();

  els.voiceBtn.addEventListener('click', () => {
    voice?.toggle().catch(() => {});
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && voice?.active) voice.stop();
  });

  window.addEventListener('kirana:voice-notice', (event) => {
    if (!event.detail?.message) return;
    // Aviso de confirmação pendente fica na tela até a ação ser resolvida.
    showVoiceStatus(event.detail.message, true, event.detail.sticky ? Number.MAX_SAFE_INTEGER : 6000);
  });
}

/* --------------------- painel de voz e velocidade (v0.4.2) --------------- */

/**
 * Monta o seletor de motor/voz/velocidade.
 *
 * A lista é montada a partir do catálogo real: vozes do navegador (que é o
 * caminho rápido, sem servidor) e vozes do servidor (edge-tts). A escolha é
 * salva pelo próprio controlador (`localStorage`), então sobrevive ao recarregar.
 */
function setupVoiceSettings() {
  const { voiceConfigBtn, voiceSettings, voiceEngine, voiceSelect, voiceRate, voicePreview, voiceSettingsHint } = els;
  if (!voice || !voiceConfigBtn || !voiceSettings) return;

  const fecharPainel = () => {
    voiceSettings.hidden = true;
    voiceConfigBtn.setAttribute('aria-expanded', 'false');
  };

  voiceConfigBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = voiceSettings.hidden;
    voiceSettings.hidden = !open;
    voiceConfigBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      // O catálogo do servidor custa processo Python + rede: busca ao abrir.
      voice.refreshVoices({ includeServer: true, force: true }).then(renderVoiceSettings).catch(() => {});
    }
  });

  // Popover fecha ao clicar fora e com Esc (antes ficava aberto ocupando a tela).
  voiceSettings.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => {
    if (!voiceSettings.hidden) fecharPainel();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !voiceSettings.hidden) fecharPainel();
  });

  const settings = voice.settings;
  if (voiceEngine) voiceEngine.value = settings.engine === 'edge' || settings.engine === 'browser' ? settings.engine : 'auto';
  if (voiceRate) voiceRate.value = settings.rate || '+0%';

  voiceEngine?.addEventListener('change', () => {
    voice.setEngine(voiceEngine.value);
    renderVoiceSettings();
  });

  voiceSelect?.addEventListener('change', () => {
    if (!voiceSelect.value) return;
    voice.setVoice(voiceSelect.value);
    renderVoiceSettings();
  });

  voiceRate?.addEventListener('change', () => {
    voice.setRate(voiceRate.value);
    renderVoiceSettings();
  });

  voicePreview?.addEventListener('click', async () => {
    voicePreview.disabled = true;
    const original = voicePreview.textContent;
    voicePreview.textContent = 'Falando…';
    try {
      const result = await voice.previewVoice();
      if (result?.error) showVoiceStatus(result.error.message, true, 6000);
    } catch (error) {
      showVoiceStatus(error?.message || 'Não foi possível tocar a prévia.', true, 6000);
    } finally {
      voicePreview.disabled = false;
      voicePreview.textContent = original;
    }
  });

  window.addEventListener('kirana:voice-voices', (event) => {
    renderVoiceSettings(event.detail?.voices);
  });

  renderVoiceSettings();
}

/** Redesenha as opções agrupadas por motor, mantendo a voz escolhida. */
function renderVoiceSettings(catalog = null) {
  const { voiceSelect, voiceSettingsHint } = els;
  if (!voice || !voiceSelect) return;
  const voices = catalog ?? voice.voices;
  const settings = voice.settings;

  const grupo = (titulo, lista) => {
    if (!lista.length) return null;
    const group = document.createElement('optgroup');
    group.label = titulo;
    for (const item of lista) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.label || item.name;
      option.selected = item.id === settings.voice?.id;
      group.append(option);
    }
    return group;
  };

  const anterior = voiceSelect.value;
  voiceSelect.replaceChildren();
  const navegador = grupo('Neste navegador (mais rápido)', voices.browser ?? []);
  const servidor = grupo('No servidor (edge-tts)', voices.edge ?? []);
  if (navegador) voiceSelect.append(navegador);
  if (servidor) voiceSelect.append(servidor);
  if (!navegador && !servidor) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Nenhuma voz disponível agora';
    voiceSelect.append(option);
  }
  const desejada = settings.voice?.id || anterior;
  if (desejada) voiceSelect.value = desejada;

  if (voiceSettingsHint) {
    const doNavegador = voices.browser?.length ?? 0;
    const doServidor = voices.edge?.length ?? 0;
    const motor = settings.engine === 'browser' ? 'navegador' : settings.engine === 'edge' ? 'servidor' : 'automático';
    const voz = settings.voice?.name ? ` — ${settings.voice.name}` : '';
    if (doNavegador || doServidor) {
      voiceSettingsHint.textContent = `Falando pelo ${motor}${voz}. ${doNavegador} voz(es) no navegador, ${doServidor} no servidor.`;
    } else if (settings.engine === 'edge') {
      // Distingue "ainda buscando" de "o servidor respondeu sem vozes": antes as
      // duas situações mostravam a mesma frase e pareciam defeito da interface.
      voiceSettingsHint.textContent = voices.serverResponded
        ? 'O servidor respondeu sem vozes pt-BR. Confira Python e edge-tts com o diagnostico.bat (a conversa por texto continua).'
        : 'Buscando as vozes do servidor…';
    } else {
      voiceSettingsHint.textContent = 'Este navegador não oferece voz própria; a Kirana fala pelo servidor. Toque em “Ouvir prévia” para testar.';
    }
  }
}

let voiceNoticeUntil = 0;

/**
 * Escreve o status da voz. `holdMs` mantém o aviso na tela por alguns
 * segundos, para que a próxima mudança de estado não o apague na hora (era o
 * que acontecia com "confirme na tela" e com mensagens de erro).
 */
function showVoiceStatus(message, isError = false, holdMs = 0) {
  if (!els.voiceStatus) return;
  if (holdMs) voiceNoticeUntil = Date.now() + holdMs;
  els.voiceStatus.textContent = message;
  els.voiceStatus.classList.toggle('is-error', Boolean(isError));
  els.voiceStatus.hidden = !message;
}

/* --------------------------------- início -------------------------------- */

async function boot() {
  bindEvents();
  setupVoice();
  await loadConfig();
  await Promise.all([loadStatus(), loadTools(), loadMemory().catch(() => {})]);
  await refreshHistory();

  const lastSession = localStorage.getItem('kirana.session');
  if (lastSession) {
    const exists = state.sessions.some((session) => session.id === lastSession);
    if (exists) {
      await loadSession(lastSession);
      return;
    }
  }
  await startNewSession({ silent: true });
  els.input.focus();
}

boot();
