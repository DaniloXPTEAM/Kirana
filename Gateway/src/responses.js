import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
const API = 'https://api.openai.com/v1';
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

export class UpstreamError extends Error {
  constructor(status, code, message, retryable = false) { super(message); this.status = status; this.code = code; this.retryable = retryable; }
}

export class ResponsesClient {
  constructor({ auth, fetchImpl = fetch, now = Date.now }) { this.auth = auth; this.fetch = fetchImpl; this.now = now; this.modelCache = null; }

  async listModels(signal) {
    const token = await this.auth.accessToken(signal);
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    let response;
    try { response = await this.fetch(`${API}/models`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: requestSignal, redirect: 'error' }); }
    catch { if (signal?.aborted) throw new UpstreamError(499, 'cancelled', 'The client cancelled the request.'); if (requestSignal.aborted) throw new UpstreamError(504, 'upstream_timeout', 'Model discovery exceeded the 30-second timeout.', true); throw new UpstreamError(502, 'upstream_connection_error', 'Could not connect to the model catalog.', true); }
    const data = await readJson(response);
    if (!response.ok) throw upstreamError(response.status, data);
    const rows = Array.isArray(data.models) ? data.models : [];
    const models = rows.filter((m) => m && m.visibility === 'list' && typeof m.slug === 'string').map((m) => ({ id: m.slug, object: 'model', created: 0, owned_by: 'openai', name: typeof m.display_name === 'string' ? m.display_name : m.slug }));
    this.modelCache = { at: this.now(), models };
    return models;
  }

  async availableModels(signal) {
    if (this.modelCache && this.now() - this.modelCache.at < 5 * 60_000) return this.modelCache.models;
    return this.listModels(signal);
  }

  async chatCompletion(request, res, signal) {
    validateChatRequest(request);
    const models = await this.availableModels(signal);
    if (!models.some((m) => m.id === request.model)) throw new UpstreamError(400, 'model_not_available', 'Requested model is not in this account’s current ChatGPT plan model list.');
    const input = toResponsesInput(request.messages);
    const tools = toNamespacedTools(request.tools);
    const payload = {
      model: request.model,
      input,
      store: false,
      stream: true,
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(tools.length ? { tools } : {}),
      ...(request.tool_choice ? { tool_choice: toToolChoice(request.tool_choice) } : {}),
      ...(request.parallel_tool_calls === false ? { parallel_tool_calls: false } : {}),
    };
    const token = await this.auth.accessToken(signal);
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
    let upstream;
    try {
      upstream = await this.fetch(`${API}/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(payload), signal: requestSignal, redirect: 'error' });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (requestSignal.aborted) throw new UpstreamError(504, 'upstream_timeout', 'Responses request exceeded the 180-second timeout.', true);
      throw new UpstreamError(502, 'upstream_connection_error', 'Could not connect to the Responses API.', true);
    }
    if (!upstream.ok) {
      const data = await readJson(upstream);
      throw upstreamError(upstream.status, data);
    }
    const type = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!upstream.body || (type && type !== 'text/event-stream')) throw new UpstreamError(502, 'invalid_upstream_stream', 'Responses API did not return an SSE stream.');
    res.statusCode = 200;
    res.setHeader('content-type', request.stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    const id = `chatcmpl-${cryptoRandomId()}`;
    const created = Math.floor(this.now() / 1000);
    let text = '';
    const calls = new Map();
    let usage = null;
    let completed = false;
    let reportedModel = null; // o que o provedor DISSE ter usado
    let upstreamId = null; // id da resposta no provedor (rastreável)
    let reportedStatus = null;
    let firstUsefulAt = null;
    const startAt = this.now();
    try {
      for await (const evt of parseSse(upstream.body)) {
        requestSignal.throwIfAborted();
        const typeName = evt.type || evt.event;
        if (typeName === 'response.output_text.delta' && typeof evt.delta === 'string') {
          text += evt.delta;
          if (text.length > MAX_OUTPUT_CHARS) throw new UpstreamError(502, 'response_too_large', 'Model response exceeded the gateway output limit.');
          firstUsefulAt ??= this.now();
          emitChunk(res, request.stream, { id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: { content: evt.delta }, finish_reason: null }] });
        } else if (typeName === 'response.output_item.added' && evt.item?.type === 'function_call') {
          const item = evt.item;
          const call = { id: item.call_id || item.id || `call_${calls.size}`, name: displayToolName(item.namespace, item.name), arguments: '', index: Number.isInteger(evt.output_index) ? evt.output_index : calls.size };
          calls.set(call.index, call);
          firstUsefulAt ??= this.now();
          emitChunk(res, request.stream, { id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: { tool_calls: [{ index: call.index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }, finish_reason: null }] });
        } else if (typeName === 'response.function_call_arguments.delta' && typeof evt.delta === 'string') {
          const call = calls.get(evt.output_index);
          if (call) {
            call.arguments += evt.delta;
            emitChunk(res, request.stream, { id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: { tool_calls: [{ index: call.index, function: { arguments: evt.delta } }] }, finish_reason: null }] });
          }
        } else if (typeName === 'response.output_item.done' && evt.item?.type === 'function_call') {
          const item = evt.item; const index = Number.isInteger(evt.output_index) ? evt.output_index : calls.size;
          let call = calls.get(index);
          if (!call) { call = { id: item.call_id || item.id || `call_${index}`, name: displayToolName(item.namespace, item.name), arguments: '', index }; calls.set(index, call); }
          if (typeof item.arguments === 'string' && item.arguments !== call.arguments) {
            const suffix = item.arguments.startsWith(call.arguments) ? item.arguments.slice(call.arguments.length) : item.arguments;
            call.arguments = item.arguments;
            if (suffix) emitChunk(res, request.stream, { id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: suffix } }] }, finish_reason: null }] });
          }
        } else if (typeName === 'response.completed') {
          completed = true;
          const response = evt.response || {};
          // IDENTIFICAÇÃO REAL: o provedor declara o modelo que executou.
          // O v0.4.0 lia `usage` e descartava `response.model` — por isso era
          // impossível distinguir o nome PEDIDO do nome EXECUTADO.
          reportedModel = typeof response.model === 'string' && response.model ? response.model : null;
          upstreamId = typeof response.id === 'string' && response.id ? response.id : null;
          reportedStatus = typeof response.status === 'string' ? response.status : null;
          usage = response.usage ? { prompt_tokens: response.usage.input_tokens || 0, completion_tokens: response.usage.output_tokens || 0, total_tokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0) } : null;
          break;
        } else if (typeName === 'response.failed' || typeName === 'error' || evt.error) {
          const detail = evt.response?.error || evt.error || {};
          throw new UpstreamError(502, safeCode(detail.code), 'The Responses API reported a generation error.', false);
        } else if (typeName === 'response.incomplete') {
          throw new UpstreamError(502, 'response_incomplete', 'The model stopped before completing the response.');
        }
      }
      if (!completed) {
        // Chegou texto e o provedor fechou o stream sem o evento terminal.
        // O código continua o mesmo; o detalhe ajuda a distinguir "provedor
        // cortou" de "parser perdeu o frame" no log e no /v1/runs.
        throw new UpstreamError(
          502,
          'stream_interrupted',
          `O stream do provedor terminou sem response.completed (${text.length} caracteres recebidos).`,
          true,
        );
      }
      if (request.stream) {
        const finish = calls.size ? 'tool_calls' : 'stop';
        emitChunk(res, true, { id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
        if (usage && request.stream_options?.include_usage) emitChunk(res, true, { id, object: 'chat.completion.chunk', created, model: request.model, choices: [], usage });
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        const message = { role: 'assistant', content: text || null };
        if (calls.size) message.tool_calls = [...calls.values()].sort((a,b) => a.index-b.index).map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
        const output = { id, object: 'chat.completion', created, model: request.model, choices: [{ index: 0, message, finish_reason: calls.size ? 'tool_calls' : 'stop' }] };
        if (usage) output.usage = usage;
        res.end(JSON.stringify(output));
      }
      return {
        firstUsefulMs: firstUsefulAt === null ? null : firstUsefulAt - startAt,
        totalMs: this.now() - startAt,
        toolCalls: calls.size,
        // Identidade observada — separada do `model` ecoado ao cliente, que
        // continua sendo o nome pedido por compatibilidade do contrato.
        modelRequested: request.model,
        modelReported: reportedModel,
        identityVerified: Boolean(reportedModel) && reportedModel === request.model,
        upstreamId,
        upstreamStatus: reportedStatus,
        usage,
      };
    } catch (caught) {
      const error = requestSignal.aborted && !signal?.aborted ? new UpstreamError(504, 'upstream_timeout', 'Responses request exceeded the 180-second timeout.', true) : caught;
      if (request.stream && !res.writableEnded && !res.destroyed) {
        const apiError = normalizeError(error);
        res.write(`data: ${JSON.stringify({ error: { message: apiError.message, type: 'gateway_error', code: apiError.code } })}\n\n`);
        res.end();
      }
      throw error;
    }
  }

  /**
   * `lastIdentity` — última identidade observada do provedor. Existe para o
   * endpoint `/v1/engine` poder mostrar o motor REAL mesmo quando o cliente não
   * consulta o histórico de execução.
   */
  async analyzeImages({ model, prompt, images }, signal) {
    if (typeof model !== 'string' || !model || typeof prompt !== 'string' || !prompt.trim()) throw new UpstreamError(400, 'invalid_image_request', 'A model and non-empty prompt are required.');
    if (!Array.isArray(images) || images.length < 1 || images.length > 10) throw new UpstreamError(400, 'invalid_image_request', 'Provide between 1 and 10 images.');
    const totalBytes = images.reduce((sum, image) => sum + (Buffer.isBuffer(image?.buffer) ? image.buffer.length : 0), 0);
    if (totalBytes > 10 * 1024 * 1024 || images.some((image) => !['image/png','image/jpeg','image/webp','image/gif'].includes(image?.mimeType) || !Buffer.isBuffer(image.buffer) || !hasImageSignature(image.mimeType,image.buffer))) throw new UpstreamError(400, 'invalid_image_request', 'Images must be signature-validated PNG/JPEG/WebP/GIF files and total no more than 10 MiB.');
    const models = await this.availableModels(signal);
    if (!models.some((item) => item.id === model)) throw new UpstreamError(400, 'model_not_available', 'Requested model is not in this account’s current ChatGPT plan model list.');
    const content = [{ type: 'input_text', text: prompt }, ...images.map((image) => ({ type: 'input_image', image_url: `data:${image.mimeType};base64,${image.buffer.toString('base64')}`, detail: 'auto' }))];
    const payload = { model, input: [{ role: 'user', content }], store: false, stream: true };
    const token = await this.auth.accessToken(signal);
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
    let upstream;
    try {
      upstream = await this.fetch(`${API}/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(payload), signal: requestSignal, redirect: 'error' });
    } catch {
      if (signal?.aborted) throw new UpstreamError(499, 'cancelled', 'The client cancelled the image-analysis request.');
      if (requestSignal.aborted) throw new UpstreamError(504, 'upstream_timeout', 'Image analysis exceeded the 180-second timeout.', true);
      throw new UpstreamError(502, 'upstream_connection_error', 'Could not connect to the Responses API.', true);
    }
    if (!upstream.ok) throw upstreamError(upstream.status, await readJson(upstream));
    const type = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!upstream.body || (type && type !== 'text/event-stream')) throw new UpstreamError(502, 'invalid_upstream_stream', 'Responses API did not return an SSE stream.');
    let text = ''; let usage = null; let completed = false;
    for await (const event of parseSse(upstream.body)) {
      requestSignal.throwIfAborted();
      const eventType = event.type || event.event;
      if (eventType === 'response.output_text.delta' && typeof event.delta === 'string') {
        text += event.delta;
        if (text.length > MAX_OUTPUT_CHARS) throw new UpstreamError(502, 'response_too_large', 'Image analysis response exceeded the gateway output limit.');
      } else if (eventType === 'response.completed') {
        completed = true; const response = event.response || {};
        usage = response.usage ? { input_tokens: response.usage.input_tokens || 0, output_tokens: response.usage.output_tokens || 0 } : null;
        break;
      } else if (eventType === 'response.failed' || eventType === 'error' || event.error) {
        const detail = event.response?.error || event.error || {};
        throw new UpstreamError(502, safeCode(detail.code), 'The Responses API rejected image analysis.');
      } else if (eventType === 'response.incomplete') throw new UpstreamError(502, 'response_incomplete', 'Image analysis ended before completion.');
    }
    if (!completed) throw new UpstreamError(502, 'stream_interrupted', 'Responses stream ended without response.completed.', true);
    return { text, usage, model, live: true };
  }
}

function toResponsesInput(messages) {
  const input = [];
  const instructions = [];
  for (const m of messages) {
    if (m.role === 'system') { instructions.push(contentText(m.content)); continue; }
    if (m.role === 'tool') { input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: contentText(m.content) }); continue; }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const text = contentText(m.content || '');
      if (text) input.push({ role: 'assistant', content: text });
      for (const c of m.tool_calls) {
        if (c.type !== 'function' || !c.function?.name) throw new UpstreamError(400, 'invalid_tool_call', 'Assistant tool call is malformed.');
        const [namespace, name] = splitToolName(c.function.name);
        input.push({ type: 'function_call', call_id: c.id, name, arguments: c.function.arguments || '{}', namespace });
      }
      continue;
    }
    input.push({ role: m.role, content: toResponsesContent(m.content) });
  }
  return Object.assign(input, { instructions: instructions.join('\n\n') });
}

function toResponsesContent(content) {
  if (!Array.isArray(content)) return contentText(content);
  return content.map((part) => {
    if (part.type === 'text') return { type: 'input_text', text: part.text };
    return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail || 'auto' };
  });
}

function toNamespacedTools(tools) {
  if (tools === undefined) return [];
  if (!Array.isArray(tools) || tools.length > 32) throw new UpstreamError(400, 'invalid_tools', 'tools must be an array of at most 32 function tools.');
  const functions = tools.map((t) => {
    if (t?.type !== 'function' || !t.function || !/^[A-Za-z0-9_-]{1,64}$/.test(t.function.name || '') || !t.function.parameters || typeof t.function.parameters !== 'object') throw new UpstreamError(400, 'invalid_tools', 'Only valid Chat Completions function tools are supported.');
    return { type: 'function', name: t.function.name, description: String(t.function.description || ''), parameters: t.function.parameters, strict: t.function.strict ?? false };
  });
  return functions.length ? [{ type: 'namespace', name: 'gateway', description: 'Functions supplied by the local gateway client.', tools: functions }] : [];
}

function toToolChoice(choice) {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice === 'required' ? 'required' : choice;
  if (choice?.type === 'function' && choice.function?.name) {
    const [namespace, name] = splitToolName(choice.function.name);
    return { type: 'function', name, namespace };
  }
  throw new UpstreamError(400, 'invalid_tool_choice', 'Unsupported tool_choice format.');
}
function splitToolName(name) { const i = name.indexOf('.'); return i < 0 ? ['gateway', name] : [name.slice(0, i), name.slice(i + 1)]; }
function displayToolName(namespace, name) { return namespace ? `${namespace}.${name}` : name; }
function hasImageSignature(mime, buffer) {
  const starts = (...bytes) => buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);
  if (mime === 'image/png') return starts(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a);
  if (mime === 'image/jpeg') return starts(0xff,0xd8,0xff);
  if (mime === 'image/webp') return buffer.length >= 12 && buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP';
  if (mime === 'image/gif') return ['GIF87a','GIF89a'].includes(buffer.toString('ascii',0,6));
  return false;
}

function validateImageUrl(value) {
  if (typeof value !== 'string' || value.length > 16 * 1024) throw new UpstreamError(400, 'invalid_image_url', 'Image URL is missing or too long.');
  if (value.startsWith('data:')) {
    const match = value.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i);
    if (!match) throw new UpstreamError(400, 'invalid_image_data', 'Inline images must be base64 PNG, JPEG, WebP, or GIF data URLs.');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.toString('base64') !== match[2] || bytes.length > 10 * 1024 * 1024 || !hasImageSignature(`image/${match[1].toLowerCase()}`, bytes)) throw new UpstreamError(400, 'invalid_image_data', 'Inline image data has an invalid signature or exceeds 10 MiB.');
    return bytes.length;
  }
  let url;
  try { url = new URL(value); } catch { throw new UpstreamError(400, 'invalid_image_url', 'Image URL must be a valid HTTPS URL or supported data URL.'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateIPv4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || host === 'localhost' || host.endsWith('.localhost') || privateIPv4 || isIP(host) > 0 || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) throw new UpstreamError(400, 'invalid_image_url', 'Only public HTTPS image URLs are allowed.');
  return 0;
}

function validateChatRequest(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new UpstreamError(400, 'invalid_request', 'Request body must be a JSON object.');
  const supported = new Set(['model', 'messages', 'stream', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream_options']);
  const unsupported = Object.keys(r).filter((key) => !supported.has(key));
  if (unsupported.length) throw new UpstreamError(400, 'unsupported_parameter', `Unsupported request field: ${unsupported[0]}. This gateway only forwards validated ChatGPT-plan-compatible fields.`);
  if (typeof r.model !== 'string' || !r.model || r.model.length > 128) throw new UpstreamError(400, 'invalid_model', 'Provide a model identifier from GET /v1/models.');
  if (!Array.isArray(r.messages) || r.messages.length < 1 || r.messages.length > 100) throw new UpstreamError(400, 'invalid_messages', 'messages must contain 1–100 messages.');
  let imageCount = 0; let inlineImageBytes = 0;
  for (const m of r.messages) {
    if (!m || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) throw new UpstreamError(400, 'invalid_messages', 'Message role is invalid.');
    if (Array.isArray(m.content)) {
      if (m.role !== 'user' || m.content.length < 1 || m.content.length > 24) throw new UpstreamError(400, 'invalid_messages', 'Only user messages may contain up to 24 text/image content parts.');
      for (const part of m.content) {
        if (part?.type === 'text' && typeof part.text === 'string') continue;
        if (part?.type === 'image_url' && part.image_url && typeof part.image_url === 'object') {
          imageCount++; inlineImageBytes += validateImageUrl(part.image_url.url);
          if (part.image_url.detail !== undefined && !['auto','low','high'].includes(part.image_url.detail)) throw new UpstreamError(400, 'invalid_image_detail', 'Image detail must be auto, low, or high.');
          continue;
        }
        throw new UpstreamError(400, 'invalid_messages', 'User image content must use text or image_url parts.');
      }
    } else if (typeof m.content !== 'string' && m.content !== null) throw new UpstreamError(400, 'invalid_messages', 'Message content must be text, null, or a user text/image array.');
    if (m.role === 'tool' && typeof m.tool_call_id !== 'string') throw new UpstreamError(400, 'invalid_messages', 'tool messages require tool_call_id.');
  }
  if (imageCount > 10 || inlineImageBytes > 10 * 1024 * 1024) throw new UpstreamError(400, 'image_input_limit', 'A request may include at most 10 images and 10 MiB of inline image bytes.');
  if (r.stream !== undefined && typeof r.stream !== 'boolean') throw new UpstreamError(400, 'invalid_stream', 'stream must be boolean.');
}
function contentText(content) { if (typeof content === 'string') return content; if (content === null) return ''; throw new UpstreamError(400, 'unsupported_content', 'Only text message content is implemented in this gateway.'); }
/**
 * Converte um bloco SSE (texto entre separadores) em objeto já desserializado.
 * Devolve null para comentário/keep-alive e para o marcador [DONE].
 */
function blocoSseParaObjeto(block) {
  let event = '';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const raw = data.join('\n');
  if (raw === '[DONE]') return null;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new UpstreamError(502, 'invalid_upstream_event', 'Responses stream contained invalid JSON.'); }
  if (!parsed.type && event) parsed.event = event;
  return parsed;
}

export async function* parseSse(body) {
  const reader = body.getReader();
  // UM decodificador para todo o stream: criar um por pedaço perde o estado e
  // corrompe caractere multi-byte partido entre dois chunks — em português isso
  // significa acento quebrado ("ç", "ã", "é") no meio da resposta.
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finalizado = false;
  const consumirBlocos = function* (flushFinal) {
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary).replace(/\r/g, '');
      buffer = buffer.slice(boundary + 2);
      const parsed = blocoSseParaObjeto(block);
      if (parsed) yield parsed;
    }
    // Resto sem terminador: só no fim do stream. Sem isto, um frame terminal que
    // chega sem a linha em branco final era DESCARTADO — e o gateway concluía
    // "ended without response.completed" depois de já ter entregue o texto todo.
    if (flushFinal && buffer.trim()) {
      const restante = buffer.replace(/\r/g, '');
      buffer = '';
      const parsed = blocoSseParaObjeto(restante);
      if (parsed) yield parsed;
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { finalizado = true; break; }
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      yield* consumirBlocos(false);
    }
    buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n');
    yield* consumirBlocos(true);
  } finally {
    // Se o consumidor parou antes do fim (achou response.completed e deu break),
    // cancelar o corpo fecha a conexão em vez de deixá-la aberta.
    if (!finalizado) { try { await reader.cancel(); } catch { /* ignore */ } }
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}
function emitChunk(res, streaming, chunk) { if (streaming) res.write(`data: ${JSON.stringify(chunk)}\n\n`); }
async function readJson(response) { try { return await response.json(); } catch { return {}; } }
function safeCode(s) { return typeof s === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(s) ? s : 'upstream_error'; }
function upstreamError(status, body) { const err = body?.error || {}; return new UpstreamError(status === 401 ? 401 : status === 429 ? 429 : status >= 500 ? 502 : status, safeCode(err.code || err.type), status === 401 ? 'ChatGPT authorization expired or was rejected.' : status === 429 ? 'ChatGPT plan usage limit or rate limit reached.' : 'Responses API rejected the request.', status === 429 || status >= 500); }
export function normalizeError(error) {
  if (error instanceof UpstreamError) return error;
  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    const code = /^[a-z0-9_.-]{1,80}$/i.test(error.code) ? error.code : 'request_failed';
    const message = error.message.length <= 240 ? error.message : 'Request failed.';
    const status = Number.isInteger(error.status) ? error.status : (code.includes('auth') || code.includes('sharing') || code.includes('sign_in') ? 401 : 502);
    return Object.assign(new Error(message), { status, code, retryable: Boolean(error.retryable) });
  }
  return Object.assign(new Error('Gateway request failed.'), { status: 502, code: 'gateway_error', retryable: false });
}
function cryptoRandomId() { return randomBytes(16).toString('hex'); }
