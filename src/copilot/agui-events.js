/**
 * Tradutor Kirana -> AG-UI.
 *
 * A Kirana já fala um protocolo interno de eventos (`delta`, `tool_start`,
 * `confirmation`, `done`...). O CopilotKit fala AG-UI. Este módulo é a ponte
 * pura (sem rede), testável isoladamente.
 *
 * Regra: nenhuma decisão de negócio aqui. Só tradução.
 */

export const AGUI = {
  TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
  TOOL_CALL_END: 'TOOL_CALL_END',
  TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
  STATE_SNAPSHOT: 'STATE_SNAPSHOT',
  CUSTOM: 'CUSTOM',
  RUN_ERROR: 'RUN_ERROR',
};

const KIRANA = {
  delta: 'delta',
  start: 'start',
  status: 'status',
  toolStart: 'tool_start',
  toolResult: 'tool_result',
  externalTool: 'external_tool',
  confirmation: 'confirmation',
  done: 'done',
  error: 'error',
  session: 'session',
};

/**
 * Tradutor com estado: mantém a mensagem de texto aberta e as tool calls
 * pendentes (o evento interno nem sempre traz ids).
 */
export function createAgUiTranslator({ runId, messageId = `m_${runId}` }) {
  let textOpen = false;
  let stepOpen = false;
  let finalized = false;
  let seq = 0;
  const openTools = new Map();

  const nextId = (p) => `${p}_${runId}_${seq++}`;

  function endText() {
    if (!textOpen) return [];
    textOpen = false;
    return [{ type: AGUI.TEXT_MESSAGE_END, messageId }];
  }

  function startText() {
    if (textOpen) return [];
    textOpen = true;
    return [{ type: AGUI.TEXT_MESSAGE_START, messageId, role: 'assistant' }];
  }

  function translate(event) {
    if (!event || typeof event !== 'object' || finalized) return [];

    switch (event.type) {
      case KIRANA.delta: {
        const delta = event.text ?? event.delta ?? '';
        if (!delta) return [];
        return [...startText(), { type: AGUI.TEXT_MESSAGE_CONTENT, messageId, delta }];
      }

      case KIRANA.start: {
        const opened = stepOpen ? [] : [{ type: 'STEP_STARTED', stepName: 'kirana.model' }];
        stepOpen = true;
        return opened;
      }

      // Ferramenta de frontend: quem executa é o navegador. A chamada precisa
      // sair completa (nome + argumentos) para o CopilotKit rodar a ação.
      case KIRANA.externalTool: {
        const toolCallId = event.callId || nextId('tc');
        openTools.set(event.name, toolCallId);
        return [
          { type: AGUI.TOOL_CALL_START, toolCallId, toolCallName: event.name, parentMessageId: messageId },
          { type: AGUI.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(event.args ?? {}) },
          { type: AGUI.TOOL_CALL_END, toolCallId },
        ];
      }

      // Ferramenta de servidor: a Kirana executa; só informamos a chamada.
      case KIRANA.toolStart:
        if (event.kind === 'frontend') return [];
        {
          const toolCallId = nextId('tc');
          openTools.set(event.name, toolCallId);
          return [{ type: AGUI.TOOL_CALL_START, toolCallId, toolCallName: event.name, parentMessageId: messageId }];
        }

      case KIRANA.toolResult: {
        if (event.external) return [];
        const toolCallId = openTools.get(event.name);
        if (!toolCallId) return [];
        openTools.delete(event.name);
        return [{ type: AGUI.TOOL_CALL_END, toolCallId }];
      }

      case KIRANA.confirmation:
        return [{ type: AGUI.CUSTOM, name: 'kirana.confirmation', value: { action: event.action ?? null } }];

      case KIRANA.session:
        return [{ type: AGUI.CUSTOM, name: 'kirana.session', value: { sessionId: event.id ?? event.sessionId ?? null } }];

      case KIRANA.status:
        return [{ type: AGUI.CUSTOM, name: 'kirana.status', value: { stage: event.stage ?? null, label: event.label ?? null } }];

      // RUN_STARTED/RUN_FINISHED são responsabilidade do BuiltInAgent do
      // CopilotKit (runFactory). Aqui só fechamos o texto.
      case KIRANA.done: {
        finalized = true;
        return [...endText(), { type: AGUI.CUSTOM, name: 'kirana.done', value: { responseMs: event.responseMs ?? null, aborted: Boolean(event.aborted) } }];
      }

      case KIRANA.error: {
        finalized = true;
        const message = event.error?.message || event.message || 'Falha ao executar o turno.';
        const code = event.error?.code || event.code || 'turn_error';
        return [...endText(), { type: AGUI.RUN_ERROR, message, code }];
      }

      default:
        return [];
    }
  }

  function close(reason = 'closed') {
    if (finalized) return [];
    finalized = true;
    return [...endText(), { type: AGUI.CUSTOM, name: 'kirana.closed', value: { reason } }];
  }

  return { translate, close, get finalized() { return finalized; } };
}

/** Última mensagem do usuário no formato AG-UI (string ou partes). */
export function lastUserText(input) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ').trim();
    }
    return '';
  }
  return '';
}

/** Resultados de ferramentas que voltaram do navegador (mensagens role=tool). */
export function toolResultsFromMessages(input, limit = 4) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  return messages
    .filter((m) => m.role === 'tool')
    .slice(-limit)
    .map((m) => ({ toolCallId: m.toolCallId, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
}

/** Estado da página -> nota de sistema (já sanitizado pelo chamador). */
export function describeSharedState(state) {
  if (!state || typeof state !== 'object') return '';
  const entries = Object.entries(state).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '';
  const lines = entries.map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`.slice(0, 300));
  return `Estado atual da página informado pelo widget do site:\n${lines.join('\n')}`;
}
