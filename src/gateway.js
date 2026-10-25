/**
 * Cliente HTTP do gateway ChatGPT já existente (Kirana-ChatGPT-Gateway v0.2.0).
 *
 * Contrato usado (formato OpenAI):
 *   GET  /health
 *   GET  /v1/models
 *   POST /v1/chat/completions      (Authorization: Bearer <GATEWAY_API_KEY>)
 *
 * Compatibilidade (correção de 24/10/2026)
 * ----------------------------------------
 * O gateway v0.2.0 rejeita campos fora do subconjunto "ChatGPT-plan-compatible"
 * com HTTP 400 `unsupported_parameter` — por exemplo `temperature`:
 *
 *   "Unsupported request field: temperature. This gateway only forwards
 *    validated ChatGPT-plan-compatible fields."
 *
 * Por isso o payload agora é montado por `src/payload.js` (allowlist, campos
 * opcionais apenas sob opt-in) e, como defesa extra, este cliente remove
 * automaticamente o campo reclamado e repete a requisição UMA vez — sempre
 * antes de qualquer token ter sido emitido, portanto sem risco de duplicar
 * texto ou ferramentas.
 *
 * O gateway não é modificado por este projeto. A chave nunca sai do backend.
 */
import { readSseStream } from './sse.js';
import { buildChatPayload, extractUnsupportedField, stripField, GATEWAY_ALLOWED_FIELDS } from './payload.js';
import { validateGatewayPayload } from './contract.js';

export class GatewayError extends Error {
  constructor(message, { code = 'gateway_error', status = 0, retryable = false, details, unsupportedField = null } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
    this.unsupportedField = unsupportedField;
  }
}

/** Quantas vezes o cliente tenta remover um campo rejeitado antes de desistir. */
const MAX_FIELD_STRIPS = 2;

export function createGatewayClient({ config, logger, fetchImpl = globalThis.fetch }) {
  const base = config.gateway.url.replace(/\/+$/, '');
  const apiKey = config.gateway.apiKey;
  const log = logger?.child?.('gateway') ?? logger;

  const payloadFlags = {
    sendTemperature: Boolean(config.payload?.sendTemperature),
    sendMaxTokens: Boolean(config.payload?.sendMaxTokens),
    sendToolChoice: Boolean(config.payload?.sendToolChoice),
  };

  const authHeaders = () => {
    if (!apiKey) {
      throw new GatewayError(
        'A chave do gateway não está configurada. Preencha KIRANA_GATEWAY_API_KEY no arquivo .env.',
        { code: 'gateway_not_configured' },
      );
    }
    return { Authorization: `Bearer ${apiKey}` };
  };

  const requestUrl = (pathname) => new URL(`${base}${pathname}`).toString();

  async function fetchJson(pathname, { method = 'GET', timeoutMs = 15_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new GatewayError('Tempo esgotado ao falar com o gateway.', { code: 'gateway_timeout', retryable: true })), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetchImpl(requestUrl(pathname), {
        method,
        headers: { Accept: 'application/json', ...authHeaders() },
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        throw new GatewayError(`Gateway respondeu ${response.status} em ${pathname}.`, {
          code: response.status === 401 || response.status === 403 ? 'gateway_auth' : 'gateway_http',
          status: response.status,
          retryable: response.status >= 500,
          details: payload || text.slice(0, 300),
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (error?.name === 'AbortError') {
        throw new GatewayError('Tempo esgotado ao falar com o gateway.', { code: 'gateway_timeout', retryable: true });
      }
      throw new GatewayError(
        `Não foi possível alcançar o gateway em ${base}. Verifique se ele está rodando.`,
        { code: 'gateway_unreachable', retryable: true, details: error?.code || error?.message },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Envia a conversa e transmite a resposta.
   *
   * @returns {Promise<{text: string, toolCalls: Array, finishReason: string|null,
   *                    model: string, usage: object|null, ttftMs: number|null,
   *                    emittedAnything: boolean, payloadFields: string[],
   *                    strippedFields: string[]}>}
   */
  async function chatStream({
    messages,
    model,
    tools,
    toolChoice = 'auto',
    signal,
    onDelta,
    onFirstToken,
    temperature,
    maxTokens,
    firstTokenTimeoutMs = config.gateway.firstTokenTimeoutMs,
    requestTimeoutMs = config.gateway.requestTimeoutMs,
  }) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...authHeaders(),
    };

    let payload = buildChatPayload({
      model,
      messages,
      tools,
      toolChoice,
      flags: payloadFlags,
      temperature: temperature ?? config.agent.temperature,
      maxTokens: maxTokens ?? config.agent.maxTokens,
    });

    // Barreira local: um payload fora do contrato do Gateway v0.2.0 vira erro
    // claro aqui, em vez de HTTP 400 vindo da rede sem contexto.
    // allowOptInFields: os campos opt-in já foram filtrados por buildChatPayload;
    // a checagem aqui é de FORMATO do que efetivamente vai sair.
    const contractErrors = validateGatewayPayload(payload, { allowOptInFields: true });
    if (contractErrors.length) {
      const summary = contractErrors.map((e) => `${e.path}: ${e.message}`).join(' | ');
      log?.error?.('Payload fora do contrato do gateway', { erros: contractErrors.length, detalhe: summary });
      throw new GatewayError(`Payload incompatível com o gateway — ${summary}`, {
        code: 'gateway_contract_error',
        status: 0,
        retryable: false,
        details: contractErrors,
      });
    }

    const strippedFields = [];

    const controller = new AbortController();
    const abortFromParent = () => controller.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal) {
      if (signal.aborted) abortFromParent();
      else signal.addEventListener('abort', abortFromParent, { once: true });
    }

    const startedAt = Date.now();
    let firstTokenTimer = setTimeout(() => {
      controller.abort(new GatewayError('O gateway não enviou o primeiro token dentro do tempo limite.', { code: 'first_token_timeout', retryable: true }));
    }, firstTokenTimeoutMs);
    if (typeof firstTokenTimer.unref === 'function') firstTokenTimer.unref();

    const totalTimer = setTimeout(() => {
      controller.abort(new GatewayError('A resposta excedeu o tempo total permitido.', { code: 'request_timeout', retryable: false }));
    }, requestTimeoutMs);
    if (typeof totalTimer.unref === 'function') totalTimer.unref();

    let ttftMs = null;
    let text = '';
    let finishReason = null;
    let usage = null;
    let emittedAnything = false;
    const toolCallAcc = new Map();

    const clearFirstTokenTimer = () => {
      if (firstTokenTimer) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = null;
      }
    };

    try {
      /* ------------------------------------------------------------------ */
      /* 1. Envia a requisição, removendo campos rejeitados pelo gateway.     */
      /* ------------------------------------------------------------------ */
      let response;
      for (let attempt = 0; ; attempt += 1) {
        log?.debug?.('POST /v1/chat/completions', { model, messages: payload.messages.length, tools: payload.tools?.length ?? 0, fields: Object.keys(payload) });
        try {
          response = await fetchImpl(requestUrl('/v1/chat/completions'), {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } catch (error) {
          throw normalizeFetchError(error, controller, base);
        }

        if (response.ok) break;

        const raw = await response.text().catch(() => '');
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }

        const status = response.status;
        const unsupportedField = extractUnsupportedField(status, parsed ?? raw);

        // Recuperação automática: remove o campo e tenta de novo (nada foi
        // transmitido ao usuário ainda, então a repetição é segura).
        if (unsupportedField && attempt < MAX_FIELD_STRIPS) {
          const { payload: next, removed } = stripField(payload, unsupportedField);
          if (removed) {
            log?.warn?.('Gateway rejeitou campo; removendo e repetindo', { field: unsupportedField, attempt: attempt + 1 });
            strippedFields.push(unsupportedField);
            payload = next;
            continue;
          }
        }

        const modelMissing = status === 404 || (status === 400 && /model/i.test(raw) && !unsupportedField);
        throw new GatewayError(
          parsed?.error?.message || `O gateway recusou a requisição (HTTP ${status}).`,
          {
            code:
              status === 401 || status === 403
                ? 'gateway_auth'
                : unsupportedField
                  ? 'unsupported_parameter'
                  : modelMissing
                    ? 'model_unavailable'
                    : 'gateway_http',
            status,
            retryable: !unsupportedField && (modelMissing || status >= 500 || status === 429),
            details: parsed?.error || raw.slice(0, 300),
            unsupportedField,
          },
        );
      }

      /* ------------------------------------------------------------------ */
      /* 2. Lê a resposta (SSE ou JSON, conforme o gateway responder).        */
      /* ------------------------------------------------------------------ */
      const contentType = response.headers.get('content-type') || '';
      if (!response.body || contentType.includes('application/json')) {
        const body = await response.json();
        const message = body?.choices?.[0]?.message ?? {};
        text = typeof message.content === 'string' ? message.content : '';
        if (Array.isArray(message.tool_calls)) {
          message.tool_calls.forEach((call, index) => {
            toolCallAcc.set(index, {
              id: call.id || `call_${index}`,
              type: 'function',
              function: { name: call.function?.name || '', arguments: call.function?.arguments || '{}' },
            });
          });
        }
        finishReason = body?.choices?.[0]?.finish_reason ?? 'stop';
        usage = body?.usage ?? null;
        if (text) {
          ttftMs = Date.now() - startedAt;
          emittedAnything = true;
          clearFirstTokenTimer();
          onFirstToken?.();
          onDelta?.(text);
        }
      } else {
        for await (const frame of readSseStream(response.body, { signal: controller.signal })) {
          if (frame.done) break;
          const chunk = frame.data;
          if (chunk?.error) {
            throw new GatewayError(chunk.error.message || 'O gateway reportou um erro durante o streaming.', {
              code: 'gateway_stream_error',
              retryable: !emittedAnything,
              details: chunk.error,
            });
          }
          usage = chunk?.usage ?? usage;
          const choice = chunk?.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};

          if (Array.isArray(delta.tool_calls)) {
            for (const part of delta.tool_calls) {
              const index = Number.isInteger(part.index) ? part.index : toolCallAcc.size;
              const current =
                toolCallAcc.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (part.id) current.id = part.id;
              if (part.function?.name) current.function.name += part.function.name;
              if (part.function?.arguments) current.function.arguments += part.function.arguments;
              toolCallAcc.set(index, current);
              emittedAnything = true;
            }
            clearFirstTokenTimer();
          }

          if (typeof delta.content === 'string' && delta.content.length) {
            if (!emittedAnything) {
              ttftMs = Date.now() - startedAt;
              onFirstToken?.();
              clearFirstTokenTimer();
            }
            emittedAnything = true;
            text += delta.content;
            onDelta?.(delta.content);
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }

      const toolCalls = [...toolCallAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, call]) => ({
          id: call.id || `call_${index}`,
          type: 'function',
          function: {
            name: call.function.name,
            arguments: call.function.arguments || '{}',
          },
        }))
        .filter((call) => call.function.name);

      return {
        text,
        toolCalls,
        finishReason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
        model,
        usage,
        ttftMs,
        latencyMs: Date.now() - startedAt,
        emittedAnything,
        payloadFields: Object.keys(payload).filter((field) => GATEWAY_ALLOWED_FIELDS.includes(field)),
        strippedFields,
      };
    } catch (error) {
      const normalized = normalizeStreamError(error, controller, signal);
      normalized.partialText = text;
      normalized.emittedAnything = emittedAnything;
      throw normalized;
    } finally {
      clearFirstTokenTimer();
      clearTimeout(totalTimer);
      if (signal) signal.removeEventListener('abort', abortFromParent);
    }
  }

  return {
    baseUrl: base,
    hasKey: Boolean(apiKey),
    payloadFlags,
    health: () => fetchJson('/health', { timeoutMs: 5_000 }),
    async models() {
      const payload = await fetchJson('/v1/models', { timeoutMs: 10_000 });
      const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
      return list.map((item) => (typeof item === 'string' ? item : item?.id)).filter(Boolean);
    },
    chatStream,
  };
}

function normalizeFetchError(error, controller, base) {
  if (error instanceof GatewayError) return error;
  if (controller.signal.aborted) return normalizeAbort(controller.signal.reason, base);
  if (error?.name === 'AbortError') {
    return new GatewayError('Requisição cancelada.', { code: 'aborted' });
  }
  return new GatewayError(`Não foi possível alcançar o gateway em ${base}. Verifique se ele está rodando.`, {
    code: 'gateway_unreachable',
    retryable: true,
    details: error?.cause?.code || error?.code || error?.message,
  });
}

function normalizeAbort(reason, base) {
  if (reason instanceof GatewayError) return reason;
  if (reason?.name === 'AbortError') {
    return new GatewayError('Geração interrompida.', { code: 'aborted' });
  }
  return new GatewayError('Requisição cancelada.', { code: 'aborted', details: reason?.message });
}

function normalizeStreamError(error, controller, signal) {
  if (error instanceof GatewayError) return error;
  if (signal?.aborted && !controller.signal.aborted) {
    return new GatewayError('Geração interrompida.', { code: 'aborted' });
  }
  if (controller.signal.aborted) return normalizeAbort(controller.signal.reason, 'gateway');
  if (error?.name === 'AbortError') return new GatewayError('Geração interrompida.', { code: 'aborted' });
  return new GatewayError('Falha inesperada ao ler o streaming do gateway.', {
    code: 'gateway_stream_error',
    retryable: true,
    details: error?.message,
  });
}
