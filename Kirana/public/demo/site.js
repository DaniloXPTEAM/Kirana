/**
 * Site de demonstração — ações reais de DOM.
 *
 * Este arquivo é o "lado site" da integração: a Kirana (via CopilotKit)
 * chama estas funções, e elas mexem no DOM de verdade (navegação, seleção de
 * serviço, preenchimento do formulário, envio).
 *
 * Nada aqui é simulação de UI: navegação troca a URL por hash e rola a
 * página; o preenchimento escreve nos inputs e dispara eventos `input`; o
 * envio faz POST para o backend da Kirana.
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

  /** Estado compartilhado com o widget (sem dados pessoais). */
  const state = {
    page: 'inicio',
    section: 'inicio',
    service: null,
    formStep: 'idle',
    lastAction: null,
  };

  const listeners = new Set();
  const emit = (action) => {
    state.lastAction = action;
    for (const listener of listeners) {
      try {
        listener(getState());
      } catch (error) {
        console.warn('[site] listener falhou', error);
      }
    }
    document.dispatchEvent(new CustomEvent('kirana:state', { detail: getState() }));
  };

  function getState() {
    return { ...state };
  }

  function setPage(page) {
    if (!PAGES.includes(page)) throw new Error(`página inválida: ${page}`);
    state.page = page;
    state.section = page;
    if (window.location.hash !== `#${page}`) {
      history.replaceState(null, '', `#${page}`);
    }
    const section = document.getElementById(page);
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    for (const link of document.querySelectorAll('#site-nav a')) {
      link.setAttribute('aria-current', link.dataset.page === page ? 'true' : 'false');
    }
    return section;
  }

  function navigateToPage({ page } = {}) {
    const section = setPage(page);
    emit(`navigateToPage:${page}`);
    return { ok: Boolean(section), page, url: `#${page}`, title: section?.querySelector('h1,h2')?.textContent || page };
  }

  function selectService({ serviceId } = {}) {
    if (!SERVICE_LABELS[serviceId]) return { ok: false, error: `serviço desconhecido: ${serviceId}` };
    if (state.page !== 'solucoes') setPage('solucoes');
    for (const card of document.querySelectorAll('[data-service]')) {
      card.dataset.selected = card.dataset.service === serviceId ? 'true' : 'false';
    }
    const card = document.querySelector(`[data-service="${serviceId}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    state.service = serviceId;
    emit(`selectService:${serviceId}`);
    return {
      ok: Boolean(card),
      serviceId,
      label: SERVICE_LABELS[serviceId],
      description: card?.querySelector('p')?.textContent || '',
    };
  }

  function showNotice(title, text) {
    let box = document.getElementById('kirana-notice');
    if (!box) {
      box = document.createElement('div');
      box.id = 'kirana-notice';
      document.getElementById('solucoes')?.appendChild(box);
    }
    box.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = title;
    const p = document.createElement('p');
    p.style.margin = '0';
    p.textContent = text;
    box.append(strong, p);
    box.style.display = 'block';
    return box;
  }

  function showPricing() {
    // Nenhum preço é publicado pela Opportunity AI: mostramos a informação
    // real ("não informado"), nunca um valor inventado.
    showNotice('Preços', 'A Opportunity AI não publica tabela de preços. O valor depende do escopo: não informado publicamente. O caminho é uma conversa inicial pelo formulário de contato.');
    emit('showPricing');
    return { ok: true, pricing: 'não informado', published: false, nextStep: 'formulário de contato' };
  }

  function contactField(id) {
    return document.getElementById(id);
  }

  function openContactForm() {
    setPage('contato');
    const first = contactField('f-nome');
    first?.focus({ preventScroll: true });
    state.formStep = 'open';
    emit('openContactForm');
    return { ok: Boolean(first), page: 'contato', focused: 'nome' };
  }

  function setField(id, value) {
    const field = contactField(id);
    if (!field || value === undefined || value === null) return null;
    field.value = String(value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dataset.filledBy = 'kirana';
    return field.getAttribute('name') || id;
  }

  function readForm() {
    return {
      nome: contactField('f-nome')?.value?.trim() || '',
      email: contactField('f-email')?.value?.trim() || '',
      whatsapp: contactField('f-whatsapp')?.value?.trim() || '',
      empresa: contactField('f-empresa')?.value?.trim() || '',
      interesse: contactField('f-interesse')?.value || '',
      mensagem: contactField('f-mensagem')?.value?.trim() || '',
    };
  }

  const REQUIRED = ['nome', 'email', 'interesse', 'mensagem'];

  function missingFields(values) {
    return REQUIRED.filter((key) => !values[key]);
  }

  /** Cópia local mínima da autorização pendente (nunca reaproveitada). */
  let pending = null;

  async function prepare(values) {
    const response = await fetch('/api/demo/contact/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'Falha ao preparar o envio.');
    return payload;
  }

  async function fillContactForm(data = {}) {
    if (state.page !== 'contato') setPage('contato');
    const filled = [];
    const map = { nome: 'f-nome', email: 'f-email', whatsapp: 'f-whatsapp', empresa: 'f-empresa', interesse: 'f-interesse', mensagem: 'f-mensagem' };
    for (const [key, id] of Object.entries(map)) {
      if (data[key] === undefined) continue;
      const name = setField(id, data[key]);
      if (name) filled.push(name);
    }
    const values = readForm();
    const missing = missingFields(values);
    state.formStep = missing.length ? 'partial' : 'ready';

    if (missing.length) {
      emit('fillContactForm:incomplete');
      return { ok: false, filled, missing, values: summarize(values), formStep: state.formStep };
    }

    const prepared = await prepare(values);
    pending = { token: prepared.token, values, expiresAt: prepared.expiresAt };
    emit('fillContactForm:ready');
    return {
      ok: true,
      filled,
      missing: [],
      formStep: state.formStep,
      summary: summarize(values),
      confirmationRequired: true,
      note: 'Nada foi enviado. A interface vai pedir confirmação com estes dados.',
    };
  }

  /** Resumo sem dados sensíveis para contexto do modelo. */
  function summarize(values) {
    return {
      nome: values.nome,
      email: values.email ? `${values.email.slice(0, 2)}***@${values.email.split('@')[1] || ''}` : '',
      interesse: values.interesse,
      temWhatsapp: Boolean(values.whatsapp),
      temEmpresa: Boolean(values.empresa),
      temMensagem: Boolean(values.mensagem),
    };
  }

  async function submitContactRequest() {
    const values = readForm();
    const missing = missingFields(values);
    if (missing.length) {
      return { ok: false, error: 'form_incomplete', missing };
    }
    if (!pending || pending.expiresAt < Date.now()) {
      // Sem autorização válida: pede preparação (e confirmação) de novo.
      await fillContactForm(values);
    }
    const token = pending.token;
    pending = null; // uso único: mesmo que o envio falhe, exige nova confirmação

    const response = await fetch('/api/demo/contact/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, values }),
    });
    const payload = await response.json().catch(() => ({}));

    const resultBox = document.getElementById('form-result');
    if (!response.ok) {
      state.formStep = 'error';
      emit('submitContactRequest:error');
      if (resultBox) {
        resultBox.className = 'result err';
        resultBox.textContent = payload.message || 'Não foi possível enviar o pedido.';
      }
      return { ok: false, error: payload.error || 'submit_failed', message: payload.message || '' };
    }

    state.formStep = 'sent';
    emit('submitContactRequest:ok');
    if (resultBox) {
      resultBox.className = 'result ok';
      resultBox.textContent = `Pedido registrado. Protocolo ${payload.protocolo}.`;
    }
    return { ok: true, protocolo: payload.protocolo, stored: payload.stored !== false, message: 'Pedido registrado localmente.' };
  }

  function onStateChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // Interações humanas também atualizam o estado (o widget fica em sincronia).
  for (const link of document.querySelectorAll('#site-nav a')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      navigateToPage({ page: link.dataset.page });
    });
  }
  document.getElementById('cta-contato')?.addEventListener('click', () => openContactForm());
  document.getElementById('contact-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = readForm();
    const missing = missingFields(values);
    const box = document.getElementById('form-result');
    if (missing.length) {
      if (box) {
        box.className = 'result err';
        box.textContent = `Preencha: ${missing.join(', ')}.`;
      }
      return;
    }
    // Envio manual humano: prepara e envia direto (a confirmação é o próprio clique).
    fillContactForm(values)
      .then(() => submitContactRequest())
      .then((result) => {
        if (result.ok && box) {
          box.className = 'result ok';
          box.textContent = `Pedido registrado. Protocolo ${result.protocolo}.`;
        }
      })
      .catch((error) => {
        if (box) {
          box.className = 'result err';
          box.textContent = error.message || 'Falha no envio.';
        }
      });
  });

  const initial = (window.location.hash || '#inicio').replace('#', '');
  if (PAGES.includes(initial)) setPage(initial);

  window.KiranaSite = {
    siteId: 'demo-opportunity',
    config: {
      siteId: 'demo-opportunity',
      name: 'Opportunity AI (demonstração)',
      origin: 'demo',
      features: { tools: true, sharedState: true, generativeUi: true, hitl: true },
      stateKeys: ['page', 'section', 'service', 'formStep', 'lastAction'],
      generativeComponents: ['serviceCard', 'contactSummary', 'pricingNotice'],
    },
    getState,
    onStateChange,
    readForm,
    actions: {
      navigateToPage,
      openContactForm,
      selectService,
      showPricing,
      fillContactForm,
      submitContactRequest,
    },
  };

  document.dispatchEvent(new CustomEvent('kirana:site-ready'));
})();
