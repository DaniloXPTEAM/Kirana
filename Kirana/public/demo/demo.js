/**
 * Site de demonstração: ações REAIS de DOM.
 * A Kirana (via CopilotKit) chama estas funções; elas mexem na página.
 */
(function () {
  'use strict';

  const PAGES = ['inicio', 'solucoes', 'labs', 'contato'];
  const SERVICE_LABELS = {
    agentes: 'Agentes de IA personalizados',
    atendimento: 'Atendimento digital e WhatsApp',
    crm: 'CRM e automação de vendas',
    workflows: 'Workflows e automação',
    relatorios: 'Relatórios inteligentes',
    'voz-android': 'Agentes de voz e Android',
  };

  const state = { page: 'inicio', section: 'inicio', service: null, formStep: 'idle', lastAction: null };
  const listeners = new Set();
  let pending = null;

  const getState = () => ({ ...state });
  const emit = (action) => {
    state.lastAction = action;
    for (const fn of listeners) {
      try { fn(getState()); } catch (e) { console.warn('[demo] listener', e); }
    }
  };

  function setPage(page) {
    if (!PAGES.includes(page)) throw new Error(`página inválida: ${page}`);
    state.page = page;
    state.section = page;
    if (window.location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
    document.getElementById(page)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    for (const link of document.querySelectorAll('#site-nav a')) {
      link.setAttribute('aria-current', link.dataset.page === page ? 'true' : 'false');
    }
  }

  const field = (id) => document.getElementById(id);
  const readForm = () => ({
    nome: field('f-nome')?.value?.trim() || '',
    email: field('f-email')?.value?.trim() || '',
    whatsapp: field('f-whatsapp')?.value?.trim() || '',
    empresa: field('f-empresa')?.value?.trim() || '',
    interesse: field('f-interesse')?.value || '',
    mensagem: field('f-mensagem')?.value?.trim() || '',
  });
  const REQUIRED = ['nome', 'email', 'interesse', 'mensagem'];
  const missing = (v) => REQUIRED.filter((k) => !v[k]);

  function setField(id, value) {
    const el = field(id);
    if (!el || value === undefined || value === null) return null;
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dataset.filledBy = 'kirana';
    return el.name;
  }

  const actions = {
    navigateToPage({ page } = {}) {
      setPage(page);
      const section = document.getElementById(page);
      emit(`navigateToPage:${page}`);
      return { ok: Boolean(section), page, title: section?.querySelector('h1,h2')?.textContent || page };
    },

    openContactForm() {
      setPage('contato');
      field('f-nome')?.focus({ preventScroll: true });
      state.formStep = 'open';
      emit('openContactForm');
      return { ok: Boolean(field('f-nome')), page: 'contato', focused: 'nome' };
    },

    selectService({ serviceId } = {}) {
      if (!SERVICE_LABELS[serviceId]) return { ok: false, error: `serviço desconhecido: ${serviceId}` };
      if (state.page !== 'solucoes') setPage('solucoes');
      for (const card of document.querySelectorAll('[data-service]')) {
        card.dataset.selected = card.dataset.service === serviceId ? 'true' : 'false';
      }
      document.querySelector(`[data-service="${serviceId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      state.service = serviceId;
      emit(`selectService:${serviceId}`);
      return { ok: true, serviceId, label: SERVICE_LABELS[serviceId] };
    },

    showPricing() {
      const box = document.getElementById('kirana-notice');
      if (box) {
        box.style.display = 'block';
        box.textContent = 'Preços: a Opportunity AI não publica tabela de preços. Valor não informado — depende do escopo. O caminho é a conversa inicial pelo formulário.';
      }
      emit('showPricing');
      return { ok: true, pricing: 'não informado', published: false };
    },

    async fillContactForm(data = {}) {
      if (state.page !== 'contato') setPage('contato');
      const map = { nome: 'f-nome', email: 'f-email', whatsapp: 'f-whatsapp', empresa: 'f-empresa', interesse: 'f-interesse', mensagem: 'f-mensagem' };
      const filled = [];
      for (const [key, id] of Object.entries(map)) {
        if (data[key] === undefined) continue;
        const name = setField(id, data[key]);
        if (name) filled.push(name);
      }
      const values = readForm();
      const faltando = missing(values);
      state.formStep = faltando.length ? 'partial' : 'ready';
      emit('fillContactForm');
      if (faltando.length) return { ok: false, filled, missing: faltando };

      const response = await fetch('/api/demo/contact/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      const payload = await response.json();
      if (!response.ok) return { ok: false, error: payload.error || 'prepare_failed', message: payload.message };
      pending = { token: payload.token, expiresAt: payload.expiresAt, values };
      return { ok: true, filled, missing: [], confirmationRequired: true, note: 'Nada foi enviado ainda.' };
    },

    async submitContactRequest() {
      const values = readForm();
      if (missing(values).length) return { ok: false, error: 'form_incomplete', missing: missing(values) };
      if (!pending || pending.expiresAt < Date.now()) await actions.fillContactForm(values);

      const token = pending?.token;
      pending = null; // uso único: mesmo se falhar, exige nova confirmação
      const response = await fetch('/api/demo/contact/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, values }),
      });
      const payload = await response.json();
      const box = document.getElementById('form-result');
      if (!response.ok) {
        state.formStep = 'error';
        emit('submitContactRequest:error');
        if (box) { box.className = 'result err'; box.textContent = payload.message || 'Falha ao enviar.'; }
        return { ok: false, error: payload.error, message: payload.message };
      }
      state.formStep = 'sent';
      emit('submitContactRequest:ok');
      if (box) { box.className = 'result ok'; box.textContent = `Pedido registrado. Protocolo ${payload.protocolo}.`; }
      return { ok: true, protocolo: payload.protocolo, stored: payload.stored !== false };
    },
  };

  for (const link of document.querySelectorAll('#site-nav a')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      actions.navigateToPage({ page: link.dataset.page });
    });
  }
  document.getElementById('cta-contato')?.addEventListener('click', () => actions.openContactForm());
  document.getElementById('contact-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = readForm();
    const box = document.getElementById('form-result');
    if (missing(values).length) {
      if (box) { box.className = 'result err'; box.textContent = `Preencha: ${missing(values).join(', ')}.`; }
      return;
    }
    const prepared = await actions.fillContactForm(values);
    if (!prepared.ok) return;
    const result = await actions.submitContactRequest();
    if (result.ok && box) { box.className = 'result ok'; box.textContent = `Pedido registrado. Protocolo ${result.protocolo}.`; }
  });

  const initial = (window.location.hash || '#inicio').replace('#', '');
  if (PAGES.includes(initial)) setPage(initial);

  window.KiranaSite = {
    config: {
      siteId: 'demo-opportunity',
      name: 'Opportunity AI (demonstração)',
      greeting: 'Posso navegar pelo site, abrir o formulário e preencher com você.',
      stateKeys: ['page', 'section', 'service', 'formStep', 'lastAction'],
    },
    getState,
    onStateChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    readForm,
    actions,
  };
})();
