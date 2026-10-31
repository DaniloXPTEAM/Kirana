/**
 * Painel de chat da Kirana (widget).
 *
 * Usa o CopilotKit como transporte (runtime + AG-UI) e desenha a interface
 * aqui, sem depender de CSS externo. Montado dentro de um Shadow DOM para
 * não colidir com o CSS do site hospedeiro.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCopilotChat } from '@copilotkit/react-core';

import { useSiteActions } from './site-actions.jsx';

const SUGGESTIONS = [
  'Quero conhecer as soluções de inteligência artificial para atendimento de clientes',
  'Abra a página de contato e preencha meu interesse',
  'Vocês publicam preços?',
];

function MessageBubble({ message }) {
  const isUser = message.role === 'user';
  const content = typeof message.content === 'string' ? message.content : '';
  if (!content) return null;
  return (
    <div
      data-kirana-message={message.role}
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        margin: '6px 0',
      }}
    >
      <div
        style={{
          maxWidth: '86%',
          whiteSpace: 'pre-wrap',
          fontSize: 13.5,
          lineHeight: 1.5,
          padding: '9px 12px',
          borderRadius: 12,
          background: isUser ? '#1f6feb' : '#f1f4f8',
          color: isUser ? '#fff' : '#0d1117',
        }}
      >
        {content}
      </div>
    </div>
  );
}

export function KiranaPanel({ siteConfig, onAction }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [siteState, setSiteState] = useState(() => (typeof window !== 'undefined' ? window.KiranaSite?.getState?.() ?? {} : {}));
  const [statusNote, setStatusNote] = useState('');
  const scrollRef = useRef(null);

  const { visibleMessages = [], appendMessage, isLoading, stopGeneration } = useCopilotChat();

  useSiteActions({ state: siteState, onAction });

  // Mantém o estado compartilhado em sincronia com o site (navegação, form).
  useEffect(() => {
    const site = typeof window !== 'undefined' ? window.KiranaSite : null;
    if (!site?.onStateChange) return undefined;
    const unsubscribe = site.onStateChange((next) => setSiteState(next));
    setSiteState(site.getState());
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visibleMessages, open]);

  const handleAction = useCallback(
    (event) => {
      setStatusNote(`${event.name}${event.ok ? ' ✓' : ' ✗'}${event.detail ? ` · ${event.detail}` : ''}`);
      onAction?.(event);
    },
    [onAction],
  );

  const send = useCallback(
    async (text) => {
      const clean = String(text ?? '').trim();
      if (!clean || isLoading) return;
      setInput('');
      setStatusNote('');
      await appendMessage({ id: `u_${Date.now()}`, role: 'user', content: clean });
    },
    [appendMessage, isLoading],
  );

  const messages = useMemo(() => visibleMessages.filter((m) => m.role === 'user' || m.role === 'assistant'), [visibleMessages]);

  return (
    <div style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 2147483000, fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif' }}>
      {open && (
        <div
          data-kirana-panel="true"
          style={{
            width: 380,
            height: 560,
            maxHeight: 'calc(100vh - 120px)',
            display: 'flex',
            flexDirection: 'column',
            background: '#fff',
            border: '1px solid #e3e8ee',
            borderRadius: 16,
            boxShadow: '0 18px 48px rgba(13,17,23,.18)',
            overflow: 'hidden',
            marginBottom: 12,
          }}
        >
          <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid #e3e8ee' }}>
            <div style={{ width: 28, height: 28, borderRadius: 9, background: '#1f6feb', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13 }}>
              K
            </div>
            <div style={{ lineHeight: 1.2 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Kirana</div>
              <div style={{ fontSize: 11.5, color: '#5b6672' }}>{siteConfig?.name || 'Opportunity AI'}</div>
            </div>
            <button
              type="button"
              aria-label="Fechar"
              onClick={() => setOpen(false)}
              style={{ marginLeft: 'auto', border: 0, background: 'transparent', fontSize: 18, cursor: 'pointer', color: '#5b6672' }}
            >
              ×
            </button>
          </header>

          <div ref={scrollRef} data-kirana-messages="true" style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
            {messages.length === 0 ? (
              <div style={{ color: '#5b6672', fontSize: 13, lineHeight: 1.55 }}>
                <p style={{ margin: '0 0 10px' }}>{siteConfig?.greeting || 'Como posso ajudar?'}</p>
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => send(suggestion)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      margin: '6px 0',
                      padding: '8px 10px',
                      border: '1px solid #e3e8ee',
                      borderRadius: 10,
                      background: '#fbfcfe',
                      fontSize: 12.5,
                      cursor: 'pointer',
                      color: '#0d1117',
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : (
              messages.map((message) => <MessageBubble key={message.id} message={message} />)
            )}
            {isLoading && (
              <div data-kirana-typing="true" style={{ fontSize: 12, color: '#5b6672', padding: '4px 2px' }}>
                Kirana está escrevendo…
              </div>
            )}
          </div>

          {statusNote && (
            <div style={{ padding: '4px 14px 0', fontSize: 11, color: '#5b6672' }} data-kirana-status="true">
              {statusNote}
            </div>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              send(input);
            }}
            style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid #e3e8ee' }}
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Escreva para a Kirana…"
              aria-label="Mensagem para a Kirana"
              style={{ flex: 1, padding: '10px 12px', border: '1px solid #e3e8ee', borderRadius: 10, fontSize: 13.5, font: 'inherit' }}
            />
            {isLoading ? (
              <button
                type="button"
                onClick={() => stopGeneration?.()}
                style={{ border: 0, borderRadius: 10, padding: '0 14px', background: '#eef1f5', fontWeight: 600, cursor: 'pointer' }}
              >
                Parar
              </button>
            ) : (
              <button
                type="submit"
                style={{ border: 0, borderRadius: 10, padding: '0 16px', background: '#1f6feb', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
              >
                Enviar
              </button>
            )}
          </form>
        </div>
      )}

      <button
        type="button"
        data-kirana-toggle="true"
        onClick={() => setOpen((value) => !value)}
        style={{
          border: 0,
          borderRadius: 999,
          padding: '13px 18px',
          background: '#1f6feb',
          color: '#fff',
          fontWeight: 700,
          fontSize: 14,
          cursor: 'pointer',
          boxShadow: '0 10px 28px rgba(31,111,235,.35)',
        }}
      >
        {open ? 'Fechar' : 'Falar com a Kirana'}
      </button>
    </div>
  );
}
