/**
 * Kirana — cliente da interface.
 *
 * Toda a comunicação passa por /api/* neste mesmo host. Nenhuma chave do
 * gateway existe no navegador; só um token opcional de acesso local.
 */

import { createStreamState, applyEvent, finalize, composerView } from './stream-state.js';

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
    el('div', { class: 'msg-avatar', 'aria-hidden': 'true', text: 'K' }),
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
    el('div', { class: 'msg-avatar', 'aria-hidden': 'true', text: 'Você' }),
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

function addToolPill(meta, { name, title, ok, pending }) {
  const label = (title || name).replace(/^Consultar /i, '').replace(/^Registrar /i, 'Registrar ');
  const cls = pending ? 'pill tool-warn' : ok === false ? 'pill tool-warn' : 'pill tool-ok';
  meta.appendChild(el('span', { class: cls, text: pending ? `${label} · aguardando` : `${label} · ok` }));
  scrollToBottom();
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
      body: JSON.stringify({ sessionId: state.sessionId, message: clean }),
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
          break;
        case 'tool_result':
          shell.bubble.classList.remove('cursor');
          addToolPill(shell.meta, { name: event.name, title: event.title, ok: event.ok, pending: event.errorCode === 'confirmation_required' });
          break;
        case 'confirmation':
          pendingActionFromTurn = event.action;
          break;
        case 'done':
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
        addToolPill(shell.meta, { name: event.name, title: event.title, ok: event.ok });
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

/* --------------------------------- início -------------------------------- */

async function boot() {
  bindEvents();
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
