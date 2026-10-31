/**
 * Widget Kirana — React + CopilotKit.
 *
 * Monta um painel flutuante no site hospedeiro. O CopilotKit fala com
 * /api/copilot (runtime oficial) que, por sua vez, executa o agente Kirana
 * (LangGraph -> gateway -> ferramentas).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CopilotKit, useCopilotAction, useCopilotChat, useCopilotReadable } from '@copilotkit/react-core';

const SERVICE_LABELS = {
  agentes: 'Agentes de IA personalizados',
  atendimento: 'Atendimento digital e WhatsApp',
  crm: 'CRM e automação de vendas',
  workflows: 'Workflows e automação',
  relatorios: 'Relatórios inteligentes',
  'voz-android': 'Agentes de voz e Android',
};

const cardStyle = { border: '1px solid #e3e8ee', borderRadius: 12, padding: '10px 12px', margin: '8px 0', background: '#fff', fontSize: 13 };

function KiranaPanel({ site }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [pageState, setPageState] = useState(() => site?.getState?.() ?? {});
  const [status, setStatus] = useState('');
  const listRef = useRef(null);
  const { visibleMessages = [], appendMessage, isLoading, stopGeneration } = useCopilotChat();

  // Estado compartilhado (contexto da página) — sem dados pessoais.
  useCopilotReadable({
    description: 'Estado atual do site: página, seção, serviço destacado, etapa do formulário e última ação.',
    value: pageState,
  });

  useEffect(() => {
    if (!site?.onStateChange) return undefined;
    const off = site.onStateChange(setPageState);
    setPageState(site.getState());
    return off;
  }, [site]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [visibleMessages, open]);

  const act = useCallback(
    async (name, args) => {
      const result = await site?.actions?.[name]?.(args ?? {});
      setStatus(`${name} ${result?.ok === false ? '✗' : '✓'}${result?.protocolo ? ` · protocolo ${result.protocolo}` : ''}`);
      return result ?? { ok: false, error: 'acao_indisponivel' };
    },
    [site],
  );

  useCopilotAction({
    name: 'navigateToPage',
    description: 'Navega para uma página do site: inicio, solucoes, labs, contato.',
    parameters: [{ name: 'page', type: 'string', description: 'inicio | solucoes | labs | contato', required: true }],
    handler: ({ page }) => act('navigateToPage', { page }),
  });

  useCopilotAction({
    name: 'openContactForm',
    description: 'Abre o formulário de contato e foca o primeiro campo.',
    parameters: [],
    handler: () => act('openContactForm'),
  });

  useCopilotAction({
    name: 'selectService',
    description: 'Destaca um serviço na página de soluções.',
    parameters: [{ name: 'serviceId', type: 'string', description: 'id do serviço', required: true }],
    render: ({ status: st, args }) =>
      st === 'complete' ? <div style={cardStyle}>Serviço destacado: {SERVICE_LABELS[args.serviceId] || args.serviceId}</div> : <div style={cardStyle}>Destacando serviço…</div>,
    handler: ({ serviceId }) => act('selectService', { serviceId }),
  });

  useCopilotAction({
    name: 'showPricing',
    description: 'Mostra o aviso de preços publicados.',
    parameters: [],
    render: () => <div style={cardStyle}>A Opportunity AI não publica tabela de preços. Valor <b>não informado</b>.</div>,
    handler: () => act('showPricing'),
  });

  useCopilotAction({
    name: 'fillContactForm',
    description: 'Preenche o formulário de contato (nome, e-mail, whatsapp, empresa, interesse, mensagem). Não envia.',
    parameters: [
      { name: 'nome', type: 'string', description: 'nome', required: true },
      { name: 'email', type: 'string', description: 'e-mail', required: true },
      { name: 'whatsapp', type: 'string', description: 'whatsapp', required: false },
      { name: 'empresa', type: 'string', description: 'empresa', required: false },
      { name: 'interesse', type: 'string', description: 'interesse', required: true },
      { name: 'mensagem', type: 'string', description: 'mensagem', required: true },
    ],
    render: ({ status: st }) => (st === 'complete' ? <div style={cardStyle}>Formulário preenchido. Nada foi enviado.</div> : <div style={cardStyle}>Preenchendo o formulário…</div>),
    handler: (args) => act('fillContactForm', args),
  });

  // Human-in-the-loop: mostra os dados e espera o clique do visitante.
  useCopilotAction({
    name: 'submitContactRequest',
    description: 'Envia o formulário de contato. Sempre exige confirmação do visitante.',
    parameters: [],
    renderAndWaitForResponse: ({ status: st, respond }) => {
      if (st === 'executing') return <div style={cardStyle}>Enviando…</div>;
      const values = site?.readForm?.() ?? {};
      return (
        <div style={{ ...cardStyle, borderColor: '#0f766e', background: '#0f766e0d' }} data-kirana-confirm-card="true">
          <strong style={{ display: 'block', marginBottom: 6 }}>Confirme o envio destes dados</strong>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <tbody>
              {[
                ['Nome', values.nome],
                ['E-mail', values.email],
                ['WhatsApp', values.whatsapp || '—'],
                ['Empresa', values.empresa || '—'],
                ['Interesse', values.interesse],
                ['Mensagem', values.mensagem],
              ].map(([label, value]) => (
                <tr key={label}>
                  <td style={{ color: '#5b6672', paddingRight: 8, verticalAlign: 'top', whiteSpace: 'nowrap' }}>{label}</td>
                  <td style={{ wordBreak: 'break-word' }}>{value || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              type="button"
              data-kirana-confirm="true"
              style={{ background: '#0f766e', color: '#fff', border: 0, borderRadius: 8, padding: '8px 12px', fontWeight: 600, cursor: 'pointer' }}
              onClick={() => respond('O visitante confirmou o envio destes dados.')}
            >
              Confirmar e enviar
            </button>
            <button
              type="button"
              data-kirana-cancel="true"
              style={{ background: '#eef1f5', color: '#0d1117', border: 0, borderRadius: 8, padding: '8px 12px', fontWeight: 600, cursor: 'pointer' }}
              onClick={() => respond('O visitante cancelou o envio. Não envie nada.')}
            >
              Cancelar
            </button>
          </div>
        </div>
      );
    },
    handler: () => act('submitContactRequest'),
  });

  const messages = useMemo(() => visibleMessages.filter((m) => m.role === 'user' || m.role === 'assistant'), [visibleMessages]);

  const send = useCallback(
    async (text) => {
      const clean = String(text ?? '').trim();
      if (!clean || isLoading) return;
      setInput('');
      setStatus('');
      await appendMessage({ id: `u_${Date.now()}`, role: 'user', content: clean });
    },
    [appendMessage, isLoading],
  );

  return (
    <div style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 2147483000, fontFamily: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif' }}>
      {open && (
        <div data-kirana-panel="true" style={{ width: 380, height: 560, maxHeight: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #e3e8ee', borderRadius: 16, boxShadow: '0 18px 48px rgba(13,17,23,.18)', overflow: 'hidden', marginBottom: 12 }}>
          <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid #e3e8ee' }}>
            <div style={{ width: 28, height: 28, borderRadius: 9, background: '#1f6feb', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13 }}>K</div>
            <div style={{ lineHeight: 1.2 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Kirana</div>
              <div style={{ fontSize: 11.5, color: '#5b6672' }}>{site?.config?.name || 'Opportunity AI'}</div>
            </div>
            <button type="button" aria-label="Fechar" onClick={() => setOpen(false)} style={{ marginLeft: 'auto', border: 0, background: 'transparent', fontSize: 18, cursor: 'pointer', color: '#5b6672' }}>×</button>
          </header>

          <div ref={listRef} data-kirana-messages="true" style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
            {messages.length === 0 && (
              <div style={{ color: '#5b6672', fontSize: 13, lineHeight: 1.55 }}>
                <p style={{ margin: '0 0 10px' }}>{site?.config?.greeting || 'Como posso ajudar?'}</p>
                {[
                  'Quero conhecer as soluções de inteligência artificial para atendimento de clientes',
                  'Abra a página de contato',
                ].map((s) => (
                  <button key={s} type="button" onClick={() => send(s)} style={{ display: 'block', width: '100%', textAlign: 'left', margin: '6px 0', padding: '8px 10px', border: '1px solid #e3e8ee', borderRadius: 10, background: '#fbfcfe', fontSize: 12.5, cursor: 'pointer', color: '#0d1117' }}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m) => {
              const text = typeof m.content === 'string' ? m.content : '';
              if (!text) return null;
              return (
                <div key={m.id} data-kirana-message={m.role} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '6px 0' }}>
                  <div style={{ maxWidth: '86%', whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.5, padding: '9px 12px', borderRadius: 12, background: m.role === 'user' ? '#1f6feb' : '#f1f4f8', color: m.role === 'user' ? '#fff' : '#0d1117' }}>{text}</div>
                </div>
              );
            })}
            {isLoading && <div data-kirana-typing="true" style={{ fontSize: 12, color: '#5b6672', padding: '4px 2px' }}>Kirana está escrevendo…</div>}
          </div>

          {status && <div data-kirana-status="true" style={{ padding: '4px 14px', fontSize: 11, color: '#5b6672' }}>{status}</div>}

          <form
            data-kirana-form="true"
            onSubmit={(event) => { event.preventDefault(); send(input); }}
            style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid #e3e8ee' }}
          >
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Escreva para a Kirana…" aria-label="Mensagem para a Kirana" style={{ flex: 1, padding: '10px 12px', border: '1px solid #e3e8ee', borderRadius: 10, fontSize: 13.5, font: 'inherit' }} />
            {isLoading ? (
              <button type="button" data-kirana-stop="true" onClick={() => stopGeneration?.()} style={{ border: 0, borderRadius: 10, padding: '0 14px', background: '#eef1f5', fontWeight: 600, cursor: 'pointer' }}>Parar</button>
            ) : (
              <button type="submit" data-kirana-send="true" style={{ border: 0, borderRadius: 10, padding: '0 16px', background: '#1f6feb', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>Enviar</button>
            )}
          </form>
        </div>
      )}
      <button type="button" data-kirana-toggle="true" onClick={() => setOpen((v) => !v)} style={{ border: 0, borderRadius: 999, padding: '13px 18px', background: '#1f6feb', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', boxShadow: '0 10px 28px rgba(31,111,235,.35)' }}>
        {open ? 'Fechar' : 'Falar com a Kirana'}
      </button>
    </div>
  );
}

function mount() {
  const config = window.KIRANA_WIDGET_CONFIG || {};
  const site = window.KiranaSite;
  if (!site) {
    console.warn('[kirana] window.KiranaSite não encontrado: widget não montado.');
    return;
  }
  if (document.getElementById('kirana-widget-root')) return;

  const host = document.createElement('div');
  host.id = 'kirana-widget-root';
  document.body.appendChild(host);
  createRoot(host).render(
    <CopilotKit runtimeUrl={config.runtimeUrl || '/api/copilot'} agent={config.agent || 'kirana'} showDevConsole={false}>
      <KiranaPanel site={site} />
    </CopilotKit>,
  );
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
