/**
 * Máquina de estados do streaming — lado do cliente.
 *
 * Por que existe: o estado do compositor (spinner + "Kirana está escrevendo…" +
 * botão Interromper) precisa voltar a ocioso em TODOS os desfechos, inclusive
 * quando o stream termina sem um evento `done` (queda de rede, proxy, aba
 * fechando o corpo, erro inesperado). Antes, esse controle estava espalhado em
 * flags dentro de `app.js` e um caminho esquecido deixava a UI travada.
 *
 * Regra de ouro: `phase` só sai de `idle` quando há trabalho real, e qualquer
 * desfecho (`completed`, `error`, `aborted`, `unexpected-close`, `failed`)
 * obriga `phase = 'idle'`.
 *
 * Módulo puro (sem DOM), importado pelo navegador e pelos testes.
 */

export const PHASES = { IDLE: 'idle', WORKING: 'working' };

const LABELS = {
  thinking: 'Kirana está pensando…',
  writing: 'Kirana está escrevendo…',
  tool: 'Consultando…',
  organizing: 'Organizando a resposta…',
};

/** Estado inicial de um turno no cliente. */
export function createStreamState() {
  return {
    phase: PHASES.IDLE,
    label: '',
    sawStart: false,
    sawDelta: false,
    sawDone: false,
    sawError: false,
    sawTool: false,
    events: 0,
  };
}

const working = (state, label, patch = {}) => ({
  ...state,
  ...patch,
  phase: PHASES.WORKING,
  label,
  events: state.events + 1,
});

const idle = (state, patch = {}) => ({
  ...state,
  ...patch,
  phase: PHASES.IDLE,
  label: '',
  events: state.events + 1,
});

/**
 * Aplica um evento SSE ao estado.
 * @param {object} state
 * @param {{type: string, [key: string]: any}} event
 */
export function applyEvent(state, event) {
  const tipo = event?.type;

  switch (tipo) {
    case 'session':
      return { ...state, events: state.events + 1 };

    case 'start':
      return working(state, LABELS.thinking, { sawStart: true });

    case 'status':
      return working(state, event.label || LABELS.thinking);

    case 'delta':
      return working(state, LABELS.writing, { sawDelta: true });

    case 'tool_start':
      return working(state, event.title ? `Consultando ${String(event.title).toLowerCase()}…` : LABELS.tool, { sawTool: true });

    case 'tool_result':
      return working(state, LABELS.organizing, { sawTool: true });

    case 'confirmation':
      return working(state, LABELS.organizing);

    case 'done':
      // Importante: volta a ocioso AQUI, sem esperar o fechamento do stream.
      return idle(state, { sawDone: true, aborted: event.aborted === true });

    case 'error':
      return idle(state, { sawError: true });

    default:
      return { ...state, events: state.events + 1 };
  }
}

/**
 * Fecha o turno no cliente, qualquer que seja o desfecho.
 * @param {object} state
 * @param {{aborted?: boolean, error?: boolean, reason?: string}} [outcome]
 */
export function finalize(state, outcome = {}) {
  const already = state.phase === PHASES.IDLE;
  let reason = outcome.reason;

  if (!reason) {
    // `state.aborted` vem de `done.aborted` (backend encerrou por interrupção).
    if (outcome.aborted || state.aborted) reason = 'aborted';
    else if (state.sawError || outcome.error) reason = 'error';
    else if (state.sawDone) reason = 'completed';
    else reason = 'unexpected-close';
  }

  return {
    ...state,
    phase: PHASES.IDLE,
    label: '',
    reason,
    events: already ? state.events : state.events + 1,
  };
}

/** Visão para o compositor: o que mostrar e qual rótulo. */
export function composerView(state) {
  const busy = state.phase === PHASES.WORKING;
  return { busy, hidden: !busy, label: busy ? state.label : '' };
}

/** O turno terminou de forma normal? (usado em asserções e logs) */
export function isSuccessful(state) {
  return state.sawDone === true && state.sawError !== true && state.reason === 'completed';
}

/* ------------------------------------------------------------------------- */
/* Pílula de ferramenta — transporte x resultado                             */
/* ------------------------------------------------------------------------- */

/**
 * Rótulos curtos para o motivo real da falha.
 *
 * A pílula já foi o ponto onde a UI mentiu: mostrava "· ok" mesmo quando o
 * evento `tool_result` vinha com `ok: false` (o caso do `unknown_tool` com o
 * Gateway real). Aqui o rótulo depende do RESULTADO da ferramenta, não do fato
 * de o stream ter chegado ao fim.
 */
const TOOL_ERROR_LABELS = {
  unknown_tool: 'ferramenta não encontrada',
  invalid_args: 'argumentos inválidos',
  timeout: 'tempo esgotado',
  confirmation_required: 'aguardando confirmação',
  write_not_allowed: 'escrita bloqueada',
  request_closed: 'solicitação fechada',
  request_not_found: 'solicitação não encontrada',
  endpoint_nao_configurado: 'sem destino configurado',
  tool_error: 'falhou',
};

/**
 * Visão da pílula para um evento de ferramenta.
 *
 * @param {{name?:string,title?:string,ok?:boolean,pending?:boolean,errorCode?:string|null}} event
 * @returns {{label:string, tone:'ok'|'warn'|'fail'}}
 */
export function toolPillView({ name, title, ok, pending, errorCode } = {}) {
  const base = String(title || name || 'ferramenta')
    .replace(/^Consultar /i, '')
    .trim() || 'ferramenta';

  if (pending) return { label: `${base} · aguardando`, tone: 'warn' };
  if (ok === false) {
    const motivo = TOOL_ERROR_LABELS[errorCode] || 'falhou';
    return { label: `${base} · ${motivo}`, tone: 'fail' };
  }
  return { label: `${base} · ok`, tone: 'ok' };
}
