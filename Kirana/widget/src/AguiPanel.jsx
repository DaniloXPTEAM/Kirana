/**
 * Painel de chat da Kirana falando AG-UI direto com o backend.
 *
 * Por que AG-UI e não os hooks do `@copilotkit/react-core`: o bundle do
 * react-core v1 não compila neste ambiente (esgotamento de memória do
 * sandbox — ver docs/COMPATIBILIDADE.md). O protocolo usado aqui é o MESMO
 * AG-UI que o CopilotKit consome no navegador, servido por
 * `/api/agui` (adaptador) e também pelo runtime oficial em `/api/copilot`.
 *
 * A UI, as ferramentas, o estado compartilhado e a confirmação humana são os
 * mesmos do widget CopilotKit em `widget/src/main.jsx` (build alternativo).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const SERVICE_LABELS = {
  agentes: 'Agentes de IA personalizados',
  atendimento: 'Atendimento digital e WhatsApp',
  crm: 'CRM e automação de vendas',
  workflows: 'Workflows e automação',
  relatorios: 'Relatórios inteligentes',
  'voz-android': 'Agentes de voz e Android',
};

const SUGGESTIONS = [
  'Quero conhecer as soluções de inteligência artificial para atendimento de clientes',
  'Vocês publicam preços?',
];

/** Ferramentas declaradas ao backend (o servidor cruza com o kit do site). */
export const FRONTEND_TOOLS = [
  {
    name: 'navigateToPage',
    description: 'Navega para uma página do site. Páginas: inicio, solucoes, labs, contato.',
    parameters: { type: 'object', properties: { page: { type: 'string', enum: ['inicio', 'solucoes', 'labs', 'contato'] } }, required: ['page'] },
  },
  { name: 'openContactForm', description: 'Abre o formulário de contato.', parameters: { type: 'object', properties: {} } },
  {
    name: 'selectService',
    description: 'Destaca um serviço na página de soluções.',
    parameters: { type: 'object', properties: { serviceId: { type: 'string', enum: Object.keys(SERVICE_LABELS) } }, required: ['serviceId'] },
  },
  { name: 'showPricing', description: 'Mostra o aviso de preços.', parameters: { type: 'object', properties: {} } },
  {
    name: 'fillContactForm',
    description: 'Preenche o formulário de contato. Não envia nada.',
    parameters: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        email: { type: 'string' },
        whatsapp: { type: 'string' },
        empresa: { type: 'string' },
        interesse: { type: 'string' },
        mensagem: { type: 'string' },
      },
      required: ['nome', 'email', 'interesse', 'mensagem'],
    },
  },
  {
    name: 'submitContactRequest',
    description: 'Envia o formulário. Exige confirmação do visitante.',
    parameters: { type: 'object', properties: {} },
  },
];

/** Ferramentas que exigem confirmação explícita antes de executar. */
const SENSITIVE = new Set(['submitContactRequest']);

const card = { border: '1px solid #e3e8ee', borderRadius: 12, padding: '12px 14px', margin: '10px 0', background: '#fff', fontSize: 13.5, lineHeight: 1.5 };
const btn = { border: 0, borderRadius: 8, padding: '9px 14px', font: 'inherit', fontWeight: 600, cursor: 'pointer', fontSize: 13 };

async function* streamAgui({ url, body, signal, headers, envelope }) {
  const payload = envelope
    ? { method: 'agent/run', params: { agentId: envelope.agentId || 'kirana' }, body }
    : body;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Falha no AG-UI (HTTP ${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            yield JSON.parse(payload);
          } catch {
            /* linha malformada: ignora */
          }
        }
        index = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* já fechado */
    }
  }
}

export function AguiPanel({ siteConfig = {}, transport = {} }) {
  const aguiUrl = transport.url || transport.aguiUrl || '/api/copilot';
  const siteId = siteConfig.siteId || 'demo-opportunity';

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [statusNote, setStatusNote] = useState('');
  const [pending, setPending] = useState(null); // HITL pendente
  const [siteState, setSiteState] = useState(() => (typeof window !== 'undefined' ? window.KiranaSite?.getState?.() ?? {} : {}));
  const [threadId] = useState(() => `thread_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  /** toolCallId -> {name, args} durante o streaming. */
  const pendingCalls = useRef(new Map());

  const site = typeof window !== 'undefined' ? window.KiranaSite : null;

  useEffect(() => {
    if (!site?.onStateChange) return undefined;
    const unsubscribe = site.onStateChange((next) => setSiteState(next));
    setSiteState(site.getState());
    return unsubscribe;
  }, [site]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open, pending]);

  const runAction = useCallback(
    async (name, args) => {
      const actions = site?.actions || {};
      try {
        const result = await actions[name]?.(args ?? {});
        if (!result) return { ok: false, error: 'acao_indisponivel' };
        setStatusNote(`${name}${result.ok ? ' ✓' : ' ✗'}${result.protocolo ? ` · protocolo ${result.protocolo}` : ''}`);
        return result;
      } catch (error) {
        setStatusNote(`${name} ✗ · ${error.message}`);
        return { ok: false, error: 'acao_falhou', message: error.message };
      }
    },
    [site],
  );

  const send = useCallback(
    async (text) => {
      const clean = String(text ?? '').trim();
      if (!clean || loading) return;
      setInput('');
      setLoading(true);
      setStatusNote('');
      setPending(null);

      const userMessage = { id: `u_${Date.now()}`, role: 'user', content: clean };
      const assistantId = `a_${Date.now()}`;
      setMessages((previous) => [...previous, userMessage, { id: assistantId, role: 'assistant', content: '' }]);

      const controller = new AbortController();
      abortRef.current = controller;
      const body = {
        threadId,
        runId: `run_${Date.now()}`,
        messages: [...messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ id: m.id, role: m.role, content: m.content })), userMessage],
        tools: FRONTEND_TOOLS,
        state: site?.getState?.() ?? {},
        forwardedProps: { siteId },
      };

      try {
        for await (const event of streamAgui({ url: aguiUrl, body, signal: controller.signal, headers: { 'x-kirana-site': siteId }, envelope: transport.envelope })) {
          if (event.type === 'TEXT_MESSAGE_CONTENT') {
            setMessages((previous) =>
              previous.map((m) => (m.id === assistantId ? { ...m, content: m.content + event.delta } : m)),
            );
          } else if (event.type === 'TOOL_CALL_END') {
            // A chamada chegou completa: executa a ação real do site.
            const call = pendingCalls.current.get(event.toolCallId);
            pendingCalls.current.delete(event.toolCallId);
            if (call) {
              if (SENSITIVE.has(call.name)) {
                setPending(call); // exige clique do visitante
              } else {
                await runAction(call.name, call.args);
              }
            }
          } else if (event.type === 'TOOL_CALL_START') {
            pendingCalls.current.set(event.toolCallId, { name: event.toolCallName, args: {} });
          } else if (event.type === 'TOOL_CALL_ARGS') {
            const entry = pendingCalls.current.get(event.toolCallId);
            if (entry) {
              try {
                entry.args = JSON.parse(event.delta || '{}');
              } catch {
                entry.args = {};
              }
            }
          } else if (event.type === 'RUN_ERROR') {
            setStatusNote(`erro: ${event.message}`);
            setMessages((previous) => previous.map((m) => (m.id === assistantId && !m.content ? { ...m, content: `Não consegui concluir: ${event.message}` } : m)));
          }
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          setMessages((previous) => previous.map((m) => (m.id === assistantId && !m.content ? { ...m, content: `Não consegui concluir: ${error.message}` } : m)));
        }
      } finally {
        abortRef.current = null;
        setLoading(false);
      }
    },
    [aguiUrl, loading, messages, runAction, site, siteId, threadId],
  );

  const confirmPending = useCallback(
    async (approved) => {
      const call = pending;
      setPending(null);
      if (!approved) {
        setStatusNote('Envio cancelado pelo visitante. Nada foi enviado.');
        return;
      }
      await runAction(call.name, call.args);
    },
    [pending, runAction],
  );

  const visible = useMemo(() => messages.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content)), [messages]);
  const formData = site?.readForm?.() ?? {};

  return (
    <div style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 2147483000, fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif' }}>
      {open && (
        <div
          data-kirana-panel="true"
          style={{ width: 380, height: 560, maxHeight: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #e3e8ee', borderRadius: 16, boxShadow: '0 18px 48px rgba(13,17,23,.18)', overflow: 'hidden', marginBottom: 12 }}
        >
          <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid #e3e8ee' }}>
            <div style={{ width: 28, height: 28, borderRadius: 9, background: '#1f6feb', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13 }}>K</div>
            <div style={{ lineHeight: 1.2 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Kirana</div>
              <div style={{ fontSize: 11.5, color: '#5b6672' }}>{siteConfig.name || 'Opportunity AI'}</div>
            </div>
            <button type="button" aria-label="Fechar" onClick={() => setOpen(false)} style={{ marginLeft: 'auto', border: 0, background: 'transparent', fontSize: 18, cursor: 'pointer', color: '#5b6672' }}>×</button>
          </header>

          <div ref={scrollRef} data-kirana-messages="true" style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
            {visible.length === 0 && (
              <div style={{ color: '#5b6672', fontSize: 13, lineHeight: 1.55 }}>
                <p style={{ margin: '0 0 10px' }}>{siteConfig.greeting || 'Como posso ajudar?'}</p>
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => send(suggestion)} style={{ display: 'block', width: '100%', textAlign: 'left', margin: '6px 0', padding: '8px 10px', border: '1px solid #e3e8ee', borderRadius: 10, background: '#fbfcfe', fontSize: 12.5, cursor: 'pointer', color: '#0d1117' }}>
                    {suggestion}
                  </button>
                ))}
              </div>
            )}

            {visible.map((message) => (
              <div key={message.id} data-kirana-message={message.role} style={{ display: 'flex', justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start', margin: '6px 0' }}>
                <div style={{ maxWidth: '86%', whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.5, padding: '9px 12px', borderRadius: 12, background: message.role === 'user' ? '#1f6feb' : '#f1f4f8', color: message.role === 'user' ? '#fff' : '#0d1117' }}>
                  {message.content}
                </div>
              </div>
            ))}

            {pending && (
              <div data-kirana-confirmation="true" style={{ ...card, borderColor: '#0f766e44', background: '#0f766e0d' }}>
                <strong style={{ display: 'block', marginBottom: 6, color: '#0f766e' }}>Confirme o envio destes dados</strong>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <tbody>
                    {[['Nome', formData.nome], ['E-mail', formData.email], ['WhatsApp', formData.whatsapp], ['Empresa', formData.empresa], ['Interesse', formData.interesse], ['Mensagem', formData.mensagem]].map(([label, value]) => (
                      <tr key={label}>
                        <td style={{ padding: '3px 8px 3px 0', color: '#5b6672', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{label}</td>
                        <td style={{ padding: '3px 0', wordBreak: 'break-word' }}>{value || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button type="button" data-kirana-confirm="true" onClick={() => confirmPending(true)} style={{ ...btn, background: '#0f766e', color: '#fff' }}>Confirmar e enviar</button>
                  <button type="button" data-kirana-cancel="true" onClick={() => confirmPending(false)} style={{ ...btn, background: '#eef1f5', color: '#0d1117' }}>Cancelar</button>
                </div>
              </div>
            )}

            {loading && (
              <div data-kirana-typing="true" style={{ fontSize: 12, color: '#5b6672', padding: '4px 2px' }}>Kirana está escrevendo…</div>
            )}
          </div>

          {statusNote && (
            <div data-kirana-status="true" style={{ padding: '4px 14px', fontSize: 11, color: '#5b6672' }}>{statusNote}</div>
          )}

          <form
            data-kirana-form="true"
            onSubmit={(event) => {
              event.preventDefault();
              send(input);
            }}
            style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid #e3e8ee' }}
          >
            <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Escreva para a Kirana…" aria-label="Mensagem para a Kirana" style={{ flex: 1, padding: '10px 12px', border: '1px solid #e3e8ee', borderRadius: 10, fontSize: 13.5, font: 'inherit' }} />
            {loading ? (
              <button type="button" data-kirana-stop="true" onClick={() => abortRef.current?.abort()} style={{ ...btn, background: '#eef1f5', color: '#0d1117' }}>Parar</button>
            ) : (
              <button type="submit" data-kirana-send="true" style={{ ...btn, background: '#1f6feb', color: '#fff' }}>Enviar</button>
            )}
          </form>
        </div>
      )}

      <button
        type="button"
        data-kirana-toggle="true"
        onClick={() => setOpen((value) => !value)}
        style={{ border: 0, borderRadius: 999, padding: '13px 18px', background: '#1f6feb', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', boxShadow: '0 10px 28px rgba(31,111,235,.35)' }}
      >
        {open ? 'Fechar' : 'Falar com a Kirana'}
      </button>
    </div>
  );
}
