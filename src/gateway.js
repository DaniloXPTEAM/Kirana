/**
 * Cliente HTTP do gateway ChatGPT já existente (Kirana-ChatGPT-Gateway v0.2.0).
 *
 * Contrato usado (formato OpenAI):
 *   GET  /health
 *   GET  /v1/models
 *   POST /v1/chat/completions      (Authorization: Bearer <GATEWAY_API_KEY>)
 *
 * O gateway não é modificado por este projeto. A chave nunca sai do backend.
 */
import { readSseStream } from './sse.js';

export class GatewayError extends Error {
  constructor(message, { code = 'gateway_error', status = 0, retryable = false, details } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export function createGatewayClient({ config, logger, fetchImpl = globalThis.fetch }) {
  const base = config.gateway.url.replace(/\/+$/, '');
  const apiKey = config.gateway.apiKey;
  const log = logger?.child?.('gateway') ?? logger;

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

  return {
    baseUrl: base,
    hasKey: Boolean(apiKey),

    async health() {
      return fetchJson('/health', { timeoutMs: 5_000 });
    },

    async models() {
      const payload = await fetchJson('/v1/models', { timeoutMs: 10_000 });
      const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
      return list.map((item) => (typeof item === 'string' ? item : item?.id)).filter(Boolean);
    },

    /**
     * Envia uma conversa e transmite a resposta.
     *
     * @returns {Promise<{text: string, toolCalls: Array, finishReason: string|null,
     *                    model: string, usage: object|null, ttftMs: number|null,
     *                    emittedAnything: boolean}>}
     */
    async chatStream({
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

      const body = {
        model,
        messages,
        stream: true,
        temperature: temperature ?? config.agent.temperature,
      };
      const effectiveMax = maxTokens ?? config.agent.maxTokens;
      if (effectiveMax > 0) body.max_tokens = effectiveMax;
      if (Array.isArray(tools) && tools.length) {
        body.tools = tools;
        body.tool_choice = toolChoice;
        body.parallel_tool_calls = false;
      }

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
        log?.debug?.('POST /v1/chat/completions', { model, messages: messages.length, tools: tools?.length ?? 0 });

        let response;
        try {
          response = await fetchImpl(requestUrl('/v1/chat/completions'), {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          throw normalizeFetchError(error, controller, base);
        }

        if (!response.ok) {
          const raw = await response.text().catch(() => '');
          let payload = null;
          try {
            payload = raw ? JSON.parse(raw) : null;
          } catch {
            payload = null;
          }
          const status = response.status;
          const modelMissing = status === 404 || (status === 400 && /model/i.test(raw));
          throw new GatewayError(
            payload?.error?.message || `O gateway recusou a requisição (HTTP ${status}).`,
            {
              code: status === 401 || status === 403 ? 'gateway_auth' : modelMissing ? 'model_unavailable' : 'gateway_http',
              status,
              retryable: modelMissing || status >= 500 || status === 429,
              details: payload?.error || raw.slice(0, 300),
            },
          );
        }

        const contentType = response.headers.get('content-type') || '';
        if (!response.body || contentType.includes('application/json')) {
          // O gateway pode responder JSON mesmo com stream: true.
          const payload = await response.json();
          const message = payload?.choices?.[0]?.message ?? {};
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
          finishReason = payload?.choices?.[0]?.finish_reason ?? 'stop';
          usage = payload?.usage ?? null;
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
    },
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
