/**
 * Ferramentas de frontend da Kirana no site.
 *
 * Cada `useCopilotAction` corresponde a uma ação REAL implementada em
 * `public/demo/site.js` (window.KiranaSite.actions). Nada aqui é decorativo:
 * se a ação do site não existir, registramos a ferramenta como indisponível e
 * a Kirana não a anuncia ao modelo.
 *
 * UI generativa: só componentes registrados neste arquivo são renderizados.
 * O modelo nunca injeta HTML/JS — no máximo escolhe uma ação e seus parâmetros,
 * que passam por validação no backend e no schema da ação.
 */
import React from 'react';
import { useCopilotAction, useCopilotReadable } from '@copilotkit/react-core';

const SERVICE_LABELS = {
  agentes: 'Agentes de IA personalizados',
  atendimento: 'Atendimento digital e WhatsApp',
  crm: 'CRM e automação de vendas',
  workflows: 'Workflows e automação',
  relatorios: 'Relatórios inteligentes',
  'voz-android': 'Agentes de voz e Android',
};

const card = {
  border: '1px solid #e3e8ee',
  borderRadius: 12,
  padding: '12px 14px',
  margin: '10px 0',
  background: '#fff',
  fontSize: 13.5,
  lineHeight: 1.5,
};

const buttonBase = {
  border: 0,
  borderRadius: 8,
  padding: '9px 14px',
  font: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
  fontSize: 13,
};

function ActionCard({ title, children, tone = '#1f6feb' }) {
  return (
    <div style={{ ...card, borderColor: `${tone}33`, background: `${tone}0d` }}>
      <strong style={{ display: 'block', marginBottom: 6, color: tone }}>{title}</strong>
      {children}
    </div>
  );
}

/** UI generativa registrada: resumo do formulário antes do envio. */
export function ContactSummary({ values, status }) {
  const rows = [
    ['Nome', values.nome],
    ['E-mail', values.email],
    ['WhatsApp', values.whatsapp || '—'],
    ['Empresa', values.empresa || '—'],
    ['Interesse', values.interesse],
    ['Mensagem', values.mensagem],
  ];
  return (
    <ActionCard title={status || 'Dados que serão enviados'} tone="#0f766e">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td style={{ padding: '3px 8px 3px 0', color: '#5b6672', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{label}</td>
              <td style={{ padding: '3px 0', wordBreak: 'break-word' }}>{value || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ActionCard>
  );
}

/** UI generativa registrada: aviso de preços (nunca inventa valor). */
export function PricingNotice() {
  return (
    <ActionCard title="Preços" tone="#a16207">
      A Opportunity AI não publica tabela de preços. Valor <strong>não informado</strong> — depende do escopo do projeto.
    </ActionCard>
  );
}

/**
 * Registra estado compartilhado + ferramentas de frontend.
 *
 * @param {object} params
 * @param {object} params.state estado público do site (sem dados sensíveis)
 * @param {(event: {name: string, ok: boolean, detail?: string}) => void} params.onAction
 */
export function useSiteActions({ state, onAction }) {
  const site = typeof window !== 'undefined' ? window.KiranaSite : null;
  const actions = site?.actions ?? {};

  // ---------------- estado compartilhado (contexto da página) ----------------
  useCopilotReadable({
    description:
      'Estado atual do site: página aberta, seção, serviço destacado, etapa do formulário de contato e última ação executada. Sem dados pessoais.',
    value: state,
  });

  useCopilotReadable({
    description: 'Ações que o site realmente permite executar no navegador agora.',
    value: {
      site: site?.config?.siteId || 'demo-opportunity',
      acoes: {
        navigateToPage: ['inicio', 'solucoes', 'labs', 'contato'],
        openContactForm: 'abre o formulário de contato e foca o primeiro campo',
        selectService: Object.keys(SERVICE_LABELS),
        showPricing: 'mostra o aviso de preços (valores não publicados)',
        fillContactForm: 'preenche nome, e-mail, whatsapp, empresa, interesse e mensagem',
        submitContactRequest: 'envia o pedido — exige confirmação explícita do visitante',
      },
    },
  });

  // ----------------------------- ferramentas --------------------------------

  useCopilotAction({
    name: 'navigateToPage',
    description: 'Navega para uma página do site. Páginas: inicio, solucoes, labs, contato.',
    parameters: [{ name: 'page', type: 'string', description: 'inicio | solucoes | labs | contato', required: true }],
    handler: async ({ page }) => {
      const result = await actions.navigateToPage?.({ page });
      onAction?.({ name: 'navigateToPage', ok: Boolean(result?.ok), detail: `página: ${page}` });
      return result ?? { ok: false, error: 'acao_indisponivel' };
    },
  });

  useCopilotAction({
    name: 'openContactForm',
    description: 'Abre o formulário de contato e posiciona o foco no primeiro campo.',
    parameters: [],
    handler: async () => {
      const result = await actions.openContactForm?.();
      onAction?.({ name: 'openContactForm', ok: Boolean(result?.ok) });
      return result ?? { ok: false, error: 'acao_indisponivel' };
    },
  });

  useCopilotAction({
    name: 'selectService',
    description: 'Destaca um serviço na página de soluções.',
    parameters: [{ name: 'serviceId', type: 'string', description: 'id do serviço', required: true }],
    render: ({ status, args }) => {
      if (status !== 'complete') return <ActionCard title="Selecionando serviço…" />;
      return (
        <ActionCard title="Serviço destacado na página">
          {SERVICE_LABELS[args.serviceId] || args.serviceId}
        </ActionCard>
      );
    },
    handler: async ({ serviceId }) => {
      const result = await actions.selectService?.({ serviceId });
      onAction?.({ name: 'selectService', ok: Boolean(result?.ok), detail: serviceId });
      return result ?? { ok: false, error: 'acao_indisponivel' };
    },
  });

  useCopilotAction({
    name: 'showPricing',
    description: 'Mostra na tela a observação de preços da Opportunity AI.',
    parameters: [],
    render: () => <PricingNotice />,
    handler: async () => {
      const result = await actions.showPricing?.();
      onAction?.({ name: 'showPricing', ok: Boolean(result?.ok) });
      return result ?? { ok: false, error: 'acao_indisponivel' };
    },
  });

  useCopilotAction({
    name: 'fillContactForm',
    description: 'Preenche os campos do formulário de contato. Não envia nada.',
    parameters: [
      { name: 'nome', type: 'string', description: 'nome do visitante', required: true },
      { name: 'email', type: 'string', description: 'e-mail', required: true },
      { name: 'whatsapp', type: 'string', description: 'whatsapp', required: false },
      { name: 'empresa', type: 'string', description: 'empresa', required: false },
      { name: 'interesse', type: 'string', description: 'interesse', required: true },
      { name: 'mensagem', type: 'string', description: 'mensagem', required: true },
    ],
    render: ({ status, args }) => {
      if (status !== 'complete') return <ActionCard title="Preenchendo o formulário…" />;
      return <ContactSummary values={args} status="Dados preenchidos no formulário" />;
    },
    handler: async (args) => {
      const result = await actions.fillContactForm?.(args);
      onAction?.({ name: 'fillContactForm', ok: Boolean(result?.ok), detail: result?.missing?.join(',') || '' });
      return result ?? { ok: false, error: 'acao_indisponivel' };
    },
  });

  // Human-in-the-loop: a ação só executa depois de um clique explícito, com os
  // dados visíveis. Cancelar devolve uma negativa e nenhum envio acontece.
  useCopilotAction({
    name: 'submitContactRequest',
    description:
      'Envia o formulário de contato. Ação sensível: sempre exige confirmação do visitante com os dados visíveis antes de executar.',
    parameters: [],
    renderAndWaitForResponse: ({ status, respond }) => {
      const values = site?.readForm?.() ?? {};
      if (status === 'executing') return <ActionCard title="Enviando…" tone="#0f766e" />;
      return (
        <div>
          <ContactSummary values={values} status="Confirme o envio destes dados" />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              data-kirana-confirm="true"
              style={{ ...buttonBase, background: '#0f766e', color: '#fff' }}
              onClick={() => respond(`Confirmado pelo visitante. Envie o pedido exatamente com estes dados.`)}
            >
              Confirmar e enviar
            </button>
            <button
              type="button"
              data-kirana-cancel="true"
              style={{ ...buttonBase, background: '#eef1f5', color: '#0d1117' }}
              onClick={() => respond('O visitante cancelou o envio. Não envie nada.')}
            >
              Cancelar
            </button>
          </div>
        </div>
      );
    },
    handler: async () => {
      const result = await actions.submitContactRequest?.();
      onAction?.({ name: 'submitContactRequest', ok: Boolean(result?.ok), detail: result?.protocolo || result?.error || '' });
      return result ?? { ok: false, error: 'acao_indisponivel' };
    },
  });
}

export { SERVICE_LABELS };
