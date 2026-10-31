/**
 * Contrato do payload do Gateway v0.2.0.
 *
 * O gateway v0.2.0 valida a requisição e responde HTTP 400 para qualquer coisa
 * fora do subconjunto "ChatGPT-plan-compatible" — foi assim que `temperature`
 * derrubou todas as mensagens em 24/10/2026.
 *
 * `validateGatewayPayload()` verifica o payload ANTES de sair do backend,
 * mensagem por mensagem, no nível de detalhe que o gateway usa. Divergências
 * aparecem como erro local claro (`gateway_contract_error`) em vez de um 400
 * genérico vindo da rede.
 *
 * Este módulo é usado em três lugares:
 *   1. `src/gateway.js` — bloqueia o envio de payload inválido;
 *   2. `scripts/audit-contract.mjs` — sonda manual de fim a fim;
 *   3. `test/contract.test.js` — regressão permanente.
 */

/** Campos de topo aceitos. */
export const TOP_LEVEL_ALLOWED = Object.freeze(['model', 'messages', 'stream', 'tools', 'tool_choice', 'temperature', 'max_tokens']);

/** Campos opt-in: só entram se explicitamente habilitados. */
export const STRICT_OPT_IN = Object.freeze(['temperature', 'max_tokens', 'tool_choice']);

/** Chaves aceitas em cada papel de mensagem. */
export const MESSAGE_KEYS = Object.freeze({
  system: ['role', 'content', 'name'],
  user: ['role', 'content', 'name'],
  assistant: ['role', 'content', 'name', 'tool_calls', 'refusal'],
  tool: ['role', 'content', 'tool_call_id'],
});

const TOOL_FUNCTION_KEYS = ['name', 'description', 'parameters', 'strict'];

/**
 * Emparelhamento entre chamadas e resultados de ferramenta.
 *
 * O Gateway v0.4.0 converte `assistant.tool_calls` em itens `function_call` e
 * mensagens `tool` em `function_call_output` (Responses API), que exige o
 * `call_id` de cada output casando com um `function_call` anterior. Um
 * `function_call` sem output faz a Responses API responder
 * `400 invalid_request_error` — foi a causa do defeito de 27/10/2026
 * (resultados de chamadas paralelas descartados em buildContextMessages).
 *
 * Esta checagem é a barreira do lado da Kirana: roda sobre as mensagens que
 * serão ENVIADAS (já reparadas por buildContextMessages), então detecta
 * regressão antes da rede, com erro local claro.
 *
 * Estados intermediários legítimos: uma chamada ainda em execução é declarada
 * em `pendingToolCallIds` e não é cobrada — é o caso de ferramenta de frontend
 * entregue ao navegador ou de turno interrompido no meio do grupo de
 * ferramentas. A chamada continua sendo exigida em qualquer outro caso.
 *
 * @param {Array<object>} messages mensagens já no formato do Gateway
 * @param {{ pendingToolCallIds?: string[] }} [options]
 * @returns {Array<{path: string, message: string}>}
 */
export function validateToolCallPairing(messages, { pendingToolCallIds = [] } = {}) {
  const errors = [];
  if (!Array.isArray(messages)) return errors;

  const pending = new Set(
    (Array.isArray(pendingToolCallIds) ? pendingToolCallIds : []).filter((id) => typeof id === 'string' && id),
  );

  // Dono de cada índice: `tool` cujo id não pertence ao `assistant` mais
  // recente é resultado órfão (id errado, duplicado fora de ordem ou colado
  // depois de outro turno).
  const owners = new Map(); // tool_call_id -> índice do assistant dono (o último que declarou)
  const results = new Map(); // tool_call_id -> índices das mensagens tool

  messages.forEach((message, index) => {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (typeof call?.id === 'string' && call.id) owners.set(call.id, index);
      }
      return;
    }
    if (message?.role !== 'tool') return;
    const id = message.tool_call_id;
    if (typeof id !== 'string' || !id) return; // já reportado pela validação de forma
    const list = results.get(id) || [];
    list.push(index);
    results.set(id, list);
  });

  messages.forEach((message, index) => {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = typeof call?.id === 'string' ? call.id : '';
        if (!id || pending.has(id)) continue;
        const at = results.get(id) || [];
        if (!at.some((resultIndex) => resultIndex > index)) {
          errors.push({
            path: `messages[${index}]`,
            message: `chamada de ferramenta sem resultado correspondente: "${id}"`,
          });
        }
      }
      return;
    }
    if (message?.role !== 'tool') return;
    const id = message.tool_call_id;
    if (typeof id !== 'string' || !id) return;
    const at = results.get(id) || [];
    if (at.length > 1 && at[0] !== index) {
      errors.push({ path: `messages[${index}]`, message: `resultado duplicado para a chamada "${id}"` });
      return;
    }
    const ownerIndex = owners.get(id);
    if (ownerIndex === undefined || ownerIndex > index) {
      errors.push({ path: `messages[${index}]`, message: `resultado sem chamada correspondente antes dele: "${id}"` });
    }
  });

  return errors;
}

/**
 * @param {object} payload
 * @param {{ allowOptInFields?: boolean, requireSystemPrompt?: boolean, checkToolPairing?: boolean, pendingToolCallIds?: string[] }} [options]
 *   allowOptInFields=false (padrão) trata temperature/max_tokens/tool_choice
 *   como violação — é a configuração esperada com o Gateway v0.2.0.
 *   requireSystemPrompt=true exige a mensagem de sistema inicial — é uma
 *   invariante do AGENTE, verificada em src/agent.js, não uma exigência do
 *   gateway (que aceita conversas sem system).
 *   checkToolPairing=true liga a checagem de emparelhamento
 *   `assistant.tool_calls` ↔ `tool.tool_call_id` (validateToolCallPairing).
 *   Fica desligada por padrão para não mudar o contrato de FORMATO; a
 *   continuação do agente liga explicitamente em src/agent.js.
 * @returns {Array<{path: string, message: string}>}
 */
export function validateGatewayPayload(
  payload,
  { allowOptInFields = false, requireSystemPrompt = false, checkToolPairing = false, pendingToolCallIds = [] } = {},
) {
  const errors = [];
  const push = (path, message) => errors.push({ path, message });

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [{ path: 'payload', message: 'deve ser um objeto' }];
  }

  for (const key of Object.keys(payload)) {
    if (!TOP_LEVEL_ALLOWED.includes(key)) push('payload', `campo não previsto: "${key}"`);
  }
  if (!allowOptInFields) {
    for (const key of STRICT_OPT_IN) {
      if (key in payload) push('payload', `campo recusado pelo Gateway v0.2.0: "${key}"`);
    }
  }

  if (typeof payload.model !== 'string' || !payload.model.trim()) push('model', 'deve ser string não vazia');
  if (payload.stream !== true) push('stream', 'deve ser o booleano true');

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    push('messages', 'deve ser um array não vazio');
    return errors;
  }
  if (requireSystemPrompt && payload.messages[0]?.role !== 'system') {
    push('messages', 'a primeira mensagem deve ser de sistema');
  }

  payload.messages.forEach((message, index) => {
    const where = `messages[${index}]`;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      push(where, 'não é um objeto');
      return;
    }
    const allowed = MESSAGE_KEYS[message.role];
    if (!allowed) {
      push(where, `role inválido: "${message.role}"`);
      return;
    }
    for (const key of Object.keys(message)) {
      if (!allowed.includes(key)) push(where, `chave não permitida para role "${message.role}": "${key}"`);
    }

    if ('content' in message) {
      if (message.content === null) push(where, 'content não pode ser null');
      else if (typeof message.content !== 'string') push(where, `content deve ser string (recebido ${typeof message.content})`);
    } else if (!(message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length)) {
      push(where, 'content ausente');
    }

    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) push(where, 'tool_call_id obrigatório');
      if (typeof message.content !== 'string' || !message.content.trim()) push(where, 'resultado da ferramenta vazio');
    }

    if (message.role === 'assistant') {
      if ('tool_calls' in message) {
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) push(where, 'tool_calls deve ser array não vazio');
        (message.tool_calls || []).forEach((call, callIndex) => {
          const callWhere = `${where}.tool_calls[${callIndex}]`;
          if (typeof call?.id !== 'string' || !call.id) push(callWhere, 'id obrigatório');
          if (call?.type !== 'function') push(callWhere, 'type deve ser "function"');
          if (typeof call?.function?.name !== 'string' || !call.function.name) push(callWhere, 'function.name obrigatório');
          if (typeof call?.function?.arguments !== 'string') push(callWhere, 'function.arguments deve ser string JSON');
          else {
            try {
              JSON.parse(call.function.arguments);
            } catch {
              push(callWhere, 'function.arguments não é JSON válido');
            }
          }
        });
      }
      const emptyContent = !message.content || !String(message.content).trim();
      if (emptyContent && !(Array.isArray(message.tool_calls) && message.tool_calls.length)) {
        push(where, 'assistant com content vazio e sem tool_calls');
      }
    }
  });

  if ('tools' in payload) {
    if (!Array.isArray(payload.tools) || payload.tools.length === 0) push('tools', 'deve ser array não vazio');
    (payload.tools || []).forEach((tool, index) => {
      const where = `tools[${index}]`;
      if (tool?.type !== 'function') push(where, 'type deve ser "function"');
      const fn = tool?.function;
      if (!fn) {
        push(where, 'function ausente');
        return;
      }
      for (const key of Object.keys(fn)) {
        if (!TOOL_FUNCTION_KEYS.includes(key)) push(where, `chave não prevista em function: "${key}"`);
      }
      if (typeof fn.name !== 'string' || !fn.name) push(where, 'function.name obrigatório');
      if (typeof fn.description !== 'string' || !fn.description) push(where, 'function.description obrigatória');
      if (!fn.parameters || typeof fn.parameters !== 'object') push(where, 'function.parameters deve ser objeto');
      else if (fn.parameters.type !== 'object') push(where, 'function.parameters.type deve ser "object"');
    });
  }

  // Barreira adicional: chamada de ferramenta sem resultado faz a Responses API
  // responder 400 na continuação. Ligada explicitamente por quem monta a
  // continuação (src/agent.js).
  if (checkToolPairing) {
    errors.push(...validateToolCallPairing(payload.messages, { pendingToolCallIds }));
  }

  return errors;
}
