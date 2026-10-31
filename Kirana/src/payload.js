/**
 * Construção e saneamento do payload enviado a POST /v1/chat/completions.
 *
 * Por que este módulo existe
 * --------------------------
 * O Kirana ChatGPT Gateway v0.2.0 aceita apenas um subconjunto "validado
 * ChatGPT-plan-compatible" de campos e responde HTTP 400 `unsupported_parameter`
 * para qualquer outro. Exemplo real observado no Windows (24/10/2026):
 *
 *   "Unsupported request field: temperature. This gateway only forwards
 *    validated ChatGPT-plan-compatible fields."
 *
 * Regra adotada: **allowlist**. Só entra no payload o que estiver em
 * `GATEWAY_ALLOWED_FIELDS`, e os campos opcionais entram apenas quando
 * explicitamente habilitados na configuração.
 *
 * Campos sempre presentes:
 *   model · messages · stream
 * Campos condicionais:
 *   tools              → quando há ferramentas na rodada
 *   tool_choice        → apenas se KIRANA_SEND_TOOL_CHOICE=true (padrão: omitido)
 * Campo desabilitado por padrão:
 *   temperature        → apenas se KIRANA_SEND_TEMPERATURE=true (padrão: NÃO enviado)
 * Campo nunca enviado:
 *   parallel_tool_calls, max_tokens (a menos que habilitado), top_p, presence_penalty,
 *   frequency_penalty, seed, stop, response_format, n, logprobs, etc.
 */

/** Campos que o gateway v0.2.0 comprovadamente aceita (ou que já funcionaram na Fase 1). */
export const GATEWAY_ALLOWED_FIELDS = Object.freeze(['model', 'messages', 'stream', 'tools', 'tool_choice', 'temperature', 'max_tokens']);

/** Campos que só entram quando ligados explicitamente na configuração. */
export const OPT_IN_FIELDS = Object.freeze({
  temperature: 'sendTemperature',
  max_tokens: 'sendMaxTokens',
  tool_choice: 'sendToolChoice',
});

/** Remove chaves com valor `undefined`, de forma rasa e previsível. */
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Normaliza uma mensagem para o formato mais compatível possível:
 * - descarta chaves internas da Kirana (id, at, model, ttftMs, usage, aborted…);
 * - garante `content` string (nunca `null`, que alguns gateways rejeitam);
 * - mantém `tool_calls` no formato OpenAI quando existirem;
 * - mantém `tool_call_id` nas mensagens de ferramenta.
 */
export function sanitizeMessage(message) {
  const role = message?.role;
  if (!role) return null;

  if (role === 'tool') {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    return compact({ role: 'tool', tool_call_id: message.toolCallId ?? message.tool_call_id, content });
  }

  if (role === 'assistant') {
    // Aceita tanto o formato OpenAI (`tool_calls`) quanto o interno da Kirana (`toolCalls`).
    const calls = message.tool_calls ?? message.toolCalls;
    const hasCalls = Array.isArray(calls) && calls.length > 0;
    const out = {
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : '',
    };
    if (hasCalls) {
      out.tool_calls = calls.map((call) => {
        // Os argumentos podem vir como string JSON (formato OpenAI) ou objeto
        // (formato interno). Nunca devem ser codificados duas vezes.
        const rawArgs = call.function?.arguments ?? call.arguments;
        return {
          id: call.id,
          type: 'function',
          function: {
            name: call.function?.name ?? call.name,
            arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {}),
          },
        };
      });
    }
    return out;
  }

  return { role, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') };
}

export function sanitizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(sanitizeMessage).filter(Boolean);
}

/**
 * Monta o payload final.
 *
 * @param {object} params
 * @param {string} params.model
 * @param {Array} params.messages
 * @param {Array} [params.tools]           schemas OpenAI de ferramentas
 * @param {string} [params.toolChoice]
 * @param {object} [params.flags]          { sendTemperature, sendMaxTokens, sendToolChoice }
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @returns {object} payload pronto para JSON.stringify
 */
export function buildChatPayload({ model, messages, tools, toolChoice, flags = {}, temperature, maxTokens } = {}) {
  const payload = {
    model,
    messages: sanitizeMessages(messages),
    stream: true,
  };

  if (Array.isArray(tools) && tools.length) {
    payload.tools = tools;
  }

  // Campos opt-in: nunca entram por acidente.
  if (flags.sendTemperature === true && Number.isFinite(temperature)) {
    payload.temperature = temperature;
  }
  if (flags.sendMaxTokens === true && Number.isFinite(maxTokens) && maxTokens > 0) {
    payload.max_tokens = maxTokens;
  }
  if (flags.sendToolChoice === true && payload.tools && toolChoice) {
    payload.tool_choice = toolChoice;
  }

  return assertAllowedFields(payload);
}

/** Falha cedo se algum campo fora da allowlist escapar (proteção contra regressão). */
export function assertAllowedFields(payload) {
  const allowed = new Set(GATEWAY_ALLOWED_FIELDS);
  const extra = Object.keys(payload).filter((key) => !allowed.has(key));
  if (extra.length) {
    throw new Error(`Payload contém campo(s) não permitido(s) pelo gateway v0.2.0: ${extra.join(', ')}`);
  }
  return payload;
}

/**
 * Remove um campo do payload (usado na recuperação automática quando o gateway
 * responde `unsupported_parameter`).
 */
export function stripField(payload, field) {
  if (!payload || !field) return { payload, removed: false };
  if (!Object.prototype.hasOwnProperty.call(payload, field)) return { payload, removed: false };
  const clone = { ...payload };
  delete clone[field];
  return { payload: clone, removed: true };
}

/**
 * Extrai o nome do campo rejeitado a partir de uma resposta 400 do gateway.
 * Aceita o formato em texto ("Unsupported request field: temperature.") e o
 * formato estruturado ({ error: { code: 'unsupported_parameter', param: 'x' } }).
 */
export function extractUnsupportedField(status, payloadOrText) {
  if (status !== 400 && status !== 422) return null;

  const asObject = payloadOrText && typeof payloadOrText === 'object' ? payloadOrText : null;
  const error = asObject?.error ?? asObject;
  const code = String(error?.code ?? error?.type ?? '').toLowerCase();
  const param = error?.param || error?.parameter;

  if (param && typeof param === 'string') return param;
  if (code === 'unsupported_parameter' && error?.field) return String(error.field);

  const text = typeof payloadOrText === 'string' ? payloadOrText : JSON.stringify(payloadOrText ?? '');
  const match = text.match(/Unsupported request field:\s*["'`]?([a-zA-Z0-9_]+)/i);
  if (match) return match[1];
  const codematch = code === 'unsupported_parameter' ? text.match(/"param"\s*:\s*"([a-zA-Z0-9_]+)"/) : null;
  return codematch ? codematch[1] : null;
}
