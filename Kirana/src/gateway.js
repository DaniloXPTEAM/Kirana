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

/**
 * Codigos que o Gateway pode emitir num frame `error` de SSE e que a Kirana sabe
 * traduzir em mensagem específica (ver src/errors.js). Lista fechada: qualquer
 * outro codigo cai no genérico `gateway_stream_error`.
 */
export const CODIGOS_DE_ERRO_DO_GATEWAY = new Set([
  'stream_interrupted',
  'response_incomplete',
  'invalid_upstream_event',
  'model_not_available',
  'model_unavailable',
  'model_no_tools',
  'unauthorized',
  'gateway_unauthorized_upstream',
  'gateway_not_configured',
  'rate_limited',
  'gateway_http',
  'gateway_timeout',
  'request_timeout',
  'first_token_timeout',
  'aborted',
]);

/**
 * Codigos que o Gateway repassa crus do provedor (via safeCode) e o equivalente
 * canonico que a Kirana sabe explicar. Sem isso, "invalid_api_key" cairia no
 * generico justamente no caso em que a mensagem certa importa.
 */
export const ALIAS_DE_ERRO = new Map([
  ['invalid_api_key', 'gateway_unauthorized_upstream'],
  ['authentication_error', 'gateway_unauthorized_upstream'],
  ['sign_in_required', 'gateway_auth'],
  ['auth_required', 'gateway_auth'],
  ['sharing_disabled', 'gateway_auth'],
  ['invalid_model', 'model_not_available'],
  ['model_not_found', 'model_not_available'],
  ['insufficient_quota', 'rate_limited'],
  ['rate_limit_exceeded', 'rate_limited'],
  ['no_candidate_available', 'model_unavailable'],
  ['all_candidates_failed', 'model_unavailable'],
  ['circuit_open', 'model_unavailable'],
]);

/** Traduz o codigo recebido do Gateway para um codigo que a Kirana sabe explicar. */
export function codigoDeErroDoGateway(bruto) {
  const codigo = typeof bruto === 'string' ? bruto.trim() : '';
  if (!codigo) return 'gateway_stream_error';
  if (CODIGOS_DE_ERRO_DO_GATEWAY.has(codigo)) return codigo;
  if (ALIAS_DE_ERRO.has(codigo)) return ALIAS_DE_ERRO.get(codigo);
  return 'gateway_stream_error';
}

/**
 * Classifica uma resposta HTTP de erro do Gateway em um código que a Kirana sabe
 * explicar. Substitui o "401/403 -> gateway_auth" genérico, que mandava o usuário
 * autorizar a conta quando o problema era a chave LOCAL (ou vice-versa).
 *
 * O Gateway devolve 401 com códigos distintos:
 *   invalid_api_key          -> Bearer LOCAL inválido/ausente  => 'unauthorized'
 *   authentication_required  -> Bearer ok, falta SIWC da conta => 'gateway_auth'
 *
 * A `type` ("authentication_error") NÃO serve para separar os dois: o Gateway usa
 * o mesmo type nos dois casos. Só o `code` é confiável — e, quando ele falta ou é
 * desconhecido, devolvemos 'gateway_auth_unknown' (não conclusivo) em vez de
 * adivinhar uma das causas.
 */
const CODIGOS_CHAVE_LOCAL = new Set([
  'invalid_api_key',
  'invalid_bearer',
  'missing_api_key',
  'unauthorized_key',
  'gateway_key_invalid',
]);

const CODIGOS_SIWC = new Set([
  'authentication_required',
  'sign_in_required',
  'auth_required',
  'not_authenticated',
  'auth_in_progress',
  'sharing_disabled',
]);

export const CODIGOS_NAO_CONCLUSIVOS = Object.freeze(['gateway_auth_unknown']);

export function classificarErroHttp(status, payload) {
  const codigo = typeof payload?.error?.code === 'string' ? payload.error.code.trim().toLowerCase() : '';
  if (status === 401 || status === 403) {
    if (CODIGOS_CHAVE_LOCAL.has(codigo)) return { code: 'unauthorized', retryable: false, motivo: 'chave_local' };
    if (CODIGOS_SIWC.has(codigo)) return { code: 'gateway_auth', retryable: false, motivo: 'siwc' };
    return { code: 'gateway_auth_unknown', retryable: false, motivo: 'codigo_ausente_ou_desconhecido' };
  }
  if (status === 429) return { code: 'rate_limited', retryable: true, motivo: 'limite_local' };
  if (status >= 500) return { code: 'gateway_http', retryable: true, motivo: 'erro_do_gateway' };
  return { code: 'gateway_http', retryable: false, motivo: 'erro_http' };
}

/** Texto técnico curto: sem controle, sem HTML, tamanho limitado. Nunca exibido cru. */
function mensagemTecnica(error) {
  const bruto = typeof error?.message === 'string' ? error.message : '';
  const limpo = bruto
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return limpo.slice(0, 200) || 'O gateway reportou um erro durante o streaming.';
}

export class GatewayError extends Error {
  constructor(message, { code = 'gateway_error', status = 0, retryable = false, details, detail = null, unsupportedField = null } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
    this.detail = detail;
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
        const classe = classificarErroHttp(response.status, payload);
        throw new GatewayError(`Gateway respondeu ${response.status} em ${pathname}.`, {
          code: classe.code,
          status: response.status,
          retryable: classe.retryable,
          detail: mensagemTecnica(payload?.error ?? {}),
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
    // Marcador terminal do contrato SSE. O Gateway v0.4.1 sempre fecha o stream
    // de sucesso com um chunk que traz `finish_reason` E, em seguida,
    // `data: [DONE]`. Antes desta correção o laço apenas fazia `break` no [DONE]
    // e, no fim, inventava `finishReason: 'stop'` — um stream cortado no meio
    // (texto parcial + EOF) era entregue como resposta concluída.
    let receivedDone = false;
    let caminho = 'json';
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
        const classe = classificarErroHttp(status, parsed);
        throw new GatewayError(
          parsed?.error?.message || `O gateway recusou a requisição (HTTP ${status}).`,
          {
            code: unsupportedField ? 'unsupported_parameter' : modelMissing ? 'model_unavailable' : classe.code,
            status,
            retryable: !unsupportedField && (modelMissing || classe.retryable),
            // `detail` é curto e sanitizado (vai para o log/diagnóstico);
            // `details` guarda o corpo completo para quem precisa depurar.
            detail: mensagemTecnica(parsed?.error ?? {}),
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
        caminho = 'sse';
        for await (const frame of readSseStream(response.body, { signal: controller.signal })) {
          if (frame.done) {
            receivedDone = true;
            break;
          }
          const chunk = frame.data;
          if (chunk?.error) {
            // O codigo que o Gateway mandou e o dado mais util do frame de erro:
            // e ele que separa "a conta nao esta autorizada" de "o modelo nao
            // existe" de "o stream foi cortado no meio". Antes, tudo virava
            // gateway_stream_error e a tela sempre mostrava a mesma frase.
            // So aceitamos codigos conhecidos: o resto vira o generico, para
            // que texto arbitrario do upstream nunca chegue a interface.
            const codigo = codigoDeErroDoGateway(chunk.error.code);
            throw new GatewayError(mensagemTecnica(chunk.error), {
              code: codigo,
              retryable: !emittedAnything,
              status: Number.isInteger(chunk.error.status) ? chunk.error.status : undefined,
              detail: mensagemTecnica(chunk.error),
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

      /* 2b. Terminou de ler: o stream SSE só é "concluído" se o marcador
         terminal chegou. Sem [DONE] e sem `finish_reason`, o que veio é um
         recorte: erro explícito, nunca `stop` inventado. */
      if (caminho === 'sse' && !receivedDone) {
        // Cancelamento pedido por quem chamou não é falha do stream.
        if (signal?.aborted || controller.signal.aborted) {
          throw normalizeAbort(signal?.reason ?? controller.signal.reason, base);
        }
        const detalhe =
          `Stream terminou sem o marcador [DONE]` +
          `${finishReason ? ` (finish_reason "${finishReason}" chegou, o marcador não)` : ' (sem finish_reason)'}` +
          ` após ${text.length} caracteres.`;
        throw new GatewayError(detalhe, {
          code: 'stream_interrupted',
          retryable: !emittedAnything && !finishReason,
          detail: detalhe,
          details: { recebeuDone: false, finishReason, caracteres: text.length },
        });
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
        // Em SSE o valor só pode ser "stop" por dedução quando o [DONE] chegou
        // sem `finish_reason` — o que o Gateway nunca faz. Em JSON é o que veio.
        finishReason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
        finishReasonDeclarado: Boolean(finishReason),
        terminalMarker: caminho === 'sse' ? 'done' : 'json',
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
      const lista = await this.modelsDetalhados();
      return lista.map((item) => item.id);
    },

    /**
     * Catálogo com metadados, quando o Gateway os enviar. O /v1/models da v0.4.1
     * devolve apenas id/object/created/owned_by; campos de capacidade
     * (`capabilities`, `supported_parameters`) são repassados se existirem em
     * versões futuras. A Kirana NÃO deduz capacidade a partir do nome.
     */
    async modelsDetalhados() {
      const payload = await fetchJson('/v1/models', { timeoutMs: 10_000 });
      const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
      return list
        .map((item) => {
          if (typeof item === 'string') return { id: item };
          if (!item || typeof item !== 'object') return null;
          const saida = { id: item.id };
          if (item.capabilities !== undefined) saida.capabilities = item.capabilities;
          if (item.capabilities_list !== undefined) saida.capabilities_list = item.capabilities_list;
          if (item.supported_parameters !== undefined) saida.supported_parameters = item.supported_parameters;
          return saida;
        })
        .filter((item) => item && item.id);
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
