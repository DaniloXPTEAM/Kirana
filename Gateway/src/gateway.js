import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { SiwcAuth } from './auth.js';
import { ResponsesClient, normalizeError } from './responses.js';
import { CapabilityRegistry } from './capabilities.js';
import { TemporaryFileStore, safeDownloadHeaders } from './files.js';
import { JobManager } from './jobs.js';
import { createMediaProviders } from './providers/index.js';
import { COST, CapabilityCatalog, CircuitBreaker, ENGINE_DEFAULTS, RunLog, isFallbackEligible, selectChain } from './engine.js';

const BODY_LIMIT = 1024 * 1024;
const MULTIMODAL_CHAT_BODY_LIMIT = 15 * 1024 * 1024;
const FILE_REQUEST_BODY_LIMIT = 15 * 1024 * 1024;
const GATEWAY_VERSION = '0.4.1';

export function createGateway({ apiKey, appName = 'Kirana Personal Gateway', stateDir = '.local-state', port = 1455, host = '127.0.0.1', fetchImpl = fetch, now = Date.now, verifyIdToken, authClient: suppliedAuth, responseClient: suppliedResponses, fileStore: suppliedFileStore, capabilityRegistry: suppliedCapabilityRegistry, mediaProviders: suppliedMediaProviders, jobManager: suppliedJobManager, providerPreferences = {}, fileOptions = {}, engineOptions = {} }) {
  if (typeof apiKey !== 'string' || apiKey.length < 32) throw new Error('GATEWAY_API_KEY must be at least 32 characters. Run npm run keygen.');
  if (host !== '127.0.0.1') throw new Error('This POC is private-local only and refuses non-loopback bind addresses.');
  const auth = suppliedAuth || new SiwcAuth({ appName, stateDir, port, fetchImpl, now, verifyIdToken });

  /* ------------------------------ motor ---------------------------------- */
  /**
   * Camada de identificação/roteamento (src/engine.js). Nasce DESLIGADA:
   * `routing.enabled=false` e `fallback=null` reproduzem exatamente o v0.4.0.
   * Só o modelo pedido é executado, e nenhuma troca automática acontece.
   */
  const engine = {
    catalog: new CapabilityCatalog(),
    breaker: new CircuitBreaker(engineOptions.breaker || {}),
    runs: new RunLog({ limit: engineOptions.runLogLimit ?? 200, now }),
    primaryModel: engineOptions.primaryModel || null,
    fallbackModel: engineOptions.fallbackModel || null,
    specialized: engineOptions.specialized || {},
    costPolicy: engineOptions.costPolicy || 'plan-only',
    routingEnabled: Boolean(engineOptions.routing),
    // Timeout EFETIVO: o padrão do motor, para o retrato dizer a verdade em vez de `null`.
    timeoutMs: Number(engineOptions.timeoutMs) > 0 ? Number(engineOptions.timeoutMs) : ENGINE_DEFAULTS.timeouts.attemptMs,
    attemptsPerModel: Number(engineOptions.attemptsPerModel) > 0 ? Number(engineOptions.attemptsPerModel) : 1,
    lastIdentity: null,
  };
  for (const entry of engineOptions.models || []) {
    engine.catalog.declare(entry.model, { provider: entry.provider, cost: entry.cost, capabilities: entry.capabilities, notes: entry.notes });
    for (const [capability, outcome] of Object.entries(entry.tested || {})) {
      engine.catalog.recordTest(entry.model, capability, { ok: Boolean(outcome.ok), detail: outcome.detail || null, source: outcome.source || 'configuracao' });
    }
  }
  const responses = suppliedResponses || new ResponsesClient({ auth, fetchImpl, now });
  const files = suppliedFileStore || new TemporaryFileStore({ directory: join(resolve(stateDir), 'files'), now, ...fileOptions });
  const capabilities = suppliedCapabilityRegistry || new CapabilityRegistry({ configuredProviders: providerPreferences });
  const mediaProviders = suppliedMediaProviders || createMediaProviders({ files, responses, auth, stateDir, fetchImpl });
  const jobs = suppliedJobManager || new JobManager({ directory: join(resolve(stateDir), 'jobs'), now });
  const limits = new Map();

  const server = createServer(async (req, res) => {
    const started = now();
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const url = new URL(req.url || '/', `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { status: 'ok', authenticated: auth.status().authenticated, gateway: 'private-local', version: GATEWAY_VERSION });
      }
      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        await auth.handleCallback(url);
        return sendHtml(res, 200, `<!doctype html><meta charset="utf-8"><title>Connected</title><main style="font:16px system-ui;max-width:40rem;margin:10vh auto"><h1>ChatGPT connected</h1><p>Plan-use permission was verified. Tokens remain in this local process memory. You may close this tab and return to the terminal.</p></main>`);
      }
      if (req.method === 'GET' && url.pathname === '/auth/start') {
        const { url: authorizationUrl } = auth.createAuthorization();
        res.statusCode = 200; res.setHeader('content-type', 'text/html; charset=utf-8');
        return res.end(`<!doctype html><meta charset="utf-8"><title>Connect ChatGPT</title><main style="font:16px system-ui;max-width:42rem;margin:10vh auto"><h1>Connect your ChatGPT account</h1><p>This local app will request identity and ChatGPT plan-use permission for <strong>${escapeHtml(appName)}</strong>. Continue only if you agree. No password or cookie is requested by this gateway.</p><p><a href="${escapeHtml(authorizationUrl)}" rel="noreferrer">Continue with ChatGPT</a></p></main>`);
      }
      if (!bearerIsValid(req.headers.authorization, apiKey)) return sendJson(res, 401, { error: { message: 'Missing or invalid gateway bearer key.', type: 'authentication_error', code: 'invalid_api_key' } });
      const rateError = consumeLimit(limits, 'single-local-client', now());
      if (rateError) return sendJson(res, 429, { error: { message: 'Local gateway request limit reached.', type: 'rate_limit_error', code: 'gateway_rate_limit' } });
      if (req.method === 'GET' && url.pathname === '/auth/status') return sendJson(res, 200, auth.status());
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
        await mediaProviders.refreshCapabilities(capabilities);
        const data = capabilities.list().map((entry) => ({ ...entry, requires_authentication: entry.name === 'text.chat' || entry.name === 'images.analyze' || entry.name === 'video.analyze', ready: entry.name === 'text.chat' ? auth.status().authenticated : entry.ready }));
        return sendJson(res, 200, { object: 'list', data, files: { formats: files.formats, upload_mime_types: files.uploadMimeTypes, max_file_bytes: files.maxFileBytes, max_total_bytes: files.maxTotalBytes, max_files: files.maxFiles, ttl_seconds: files.ttlSeconds } });
      }
      if (req.method === 'GET' && url.pathname === '/v1/files/formats') {
        return sendJson(res, 200, { object: 'list', data: files.formats, upload_mime_types: files.uploadMimeTypes, max_file_bytes: files.maxFileBytes, max_total_bytes: files.maxTotalBytes, max_files: files.maxFiles, ttl_seconds: files.ttlSeconds });
      }
      const requestedJob = url.pathname.match(/^\/v1\/(?:jobs|images\/jobs|videos\/jobs)\/([a-f0-9]{32})$/);
      if (requestedJob && req.method === 'GET') {
        const job = jobs.get(requestedJob[1]);
        if (!job || url.pathname.startsWith('/v1/images/') && !job.type.startsWith('image.') || url.pathname.startsWith('/v1/videos/') && !job.type.startsWith('video.')) return sendJson(res, 404, { error: { message:'Job not found.', type:'invalid_request_error', code:'job_not_found' } });
        return sendJson(res, 200, { object:'media.job', ...job });
      }
      if (requestedJob && req.method === 'DELETE') {
        const job = jobs.get(requestedJob[1]);
        if (!job || url.pathname.startsWith('/v1/images/') && !job.type.startsWith('image.') || url.pathname.startsWith('/v1/videos/') && !job.type.startsWith('video.')) return sendJson(res, 404, { error: { message:'Job not found.', type:'invalid_request_error', code:'job_not_found' } });
        const cancelled = await jobs.cancel(requestedJob[1]);
        return sendJson(res, 200, { object:'media.job', ...cancelled });
      }
      if (req.method === 'POST' && url.pathname === '/v1/images/generate') {
        const body = parseJson(await readBody(req, 64 * 1024));
        validatePrompt(body, ['prompt']);
        if (!await mediaProviders.comfy.configured('image_generate')) throw Object.assign(new Error('Image generation needs a local ComfyUI API workflow configured for image_generate.'), { status:503, code:'provider_not_configured' });
        const job = jobs.submit({ type:'image.generate', execute:async ({signal,progress,setProviderJobId}) => {
          const result = await mediaProviders.comfy.run({ operation:'image_generate', prompt:body.prompt, signal, onProgress:progress, onBackendJobId:setProviderJobId });
          if (result.live === true) capabilities.markAvailable('images.generate','comfyui-local');
          return { output_files:result.output_files, provider:result.provider, live:result.live };
        } });
        return sendJson(res, 202, { object:'media.job', ...job, poll_path:`/v1/images/jobs/${job.id}` });
      }
      if (req.method === 'POST' && url.pathname === '/v1/images/edit') {
        const body = parseJson(await readBody(req, 64 * 1024));
        validatePrompt(body, ['prompt','file_id']);
        const input = await requireStoredFile(files, body?.file_id, 'image/', 10 * 1024 * 1024);
        if (!await mediaProviders.comfy.configured('image_edit')) throw Object.assign(new Error('Image editing needs a local ComfyUI API workflow configured for image_edit.'), { status:503, code:'provider_not_configured' });
        const job = jobs.submit({ type:'image.edit', inputFileIds:[body.file_id], execute:async ({signal,progress,setProviderJobId}) => {
          const result = await mediaProviders.comfy.run({ operation:'image_edit', prompt:body.prompt, inputFile:{filename:input.metadata.filename,mimeType:input.metadata.mime_type,buffer:input.buffer}, signal, onProgress:progress, onBackendJobId:setProviderJobId });
          if (result.live === true) capabilities.markAvailable('images.edit','comfyui-local');
          return { output_files:result.output_files, provider:result.provider, live:result.live };
        } });
        return sendJson(res, 202, { object:'media.job', ...job, poll_path:`/v1/images/jobs/${job.id}` });
      }
      if (req.method === 'POST' && url.pathname === '/v1/videos/analyze') {
        const body = parseJson(await readBody(req, 64 * 1024));
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key)=>!['file_id','model','prompt','frame_interval_seconds','max_frames'].includes(key)) || typeof body.model!=='string' || !body.model.trim() || body.model.length>200 || typeof body.prompt!=='string' || !body.prompt.trim() || body.prompt.length>10_000 || body.frame_interval_seconds!==undefined&&(!Number.isInteger(body.frame_interval_seconds)||body.frame_interval_seconds<1||body.frame_interval_seconds>30) || body.max_frames!==undefined&&(!Number.isInteger(body.max_frames)||body.max_frames<1||body.max_frames>12)) throw Object.assign(new Error('Video analysis requires file_id, model, and prompt.'), { status:400, code:'invalid_video_request' });
        if (!auth.status().authenticated) throw Object.assign(new Error('Sign in to ChatGPT before starting video analysis.'),{status:401,code:'sign_in_required'});
        const input = await requireStoredFile(files,body.file_id,'video/',files.maxFileBytes);
        if (!await mediaProviders.videoAnalysis.configured()) throw Object.assign(new Error('Configure a local FFmpeg executable to analyze video.'), { status:503, code:'provider_not_configured' });
        const job = jobs.submit({ type:'video.analyze',inputFileIds:[body.file_id],execute:async ({signal,progress})=>{
          const result = await mediaProviders.videoAnalysis.analyze({buffer:input.buffer,mimeType:input.metadata.mime_type,model:body.model,prompt:body.prompt,frameIntervalSeconds:body.frame_interval_seconds,maxFrames:body.max_frames},{signal,onProgress:progress});
          const file = await files.create({format:'json',filename:`video-analysis-${Date.now()}.json`,data:result.result});
          if(result.live) capabilities.markAvailable('video.analyze','ffmpeg-keyframes+siwc+whisper.cpp');
          return {result_file:file,provider:'ffmpeg-keyframes+siwc',live:result.live};
        }});
        return sendJson(res,202,{object:'media.job',...job,poll_path:`/v1/videos/jobs/${job.id}`});
      }
      if (req.method === 'POST' && url.pathname === '/v1/videos/generate') {
        const body=parseJson(await readBody(req,64*1024)); validatePrompt(body,['prompt','duration_seconds']);
        const duration=body.duration_seconds ?? 5;
        if (!Number.isFinite(duration)||duration<1||duration>30) throw Object.assign(new Error('duration_seconds must be between 1 and 30.'),{status:400,code:'invalid_video_request'});
        if (!await mediaProviders.comfy.configured('video_generate')) throw Object.assign(new Error('Video generation needs a local ComfyUI API workflow configured for video_generate.'),{status:503,code:'provider_not_configured'});
        const job=jobs.submit({type:'video.generate',execute:async ({signal,progress,setProviderJobId})=>{
          const result=await mediaProviders.comfy.run({operation:'video_generate',prompt:body.prompt,durationSeconds:duration,signal,onProgress:progress,onBackendJobId:setProviderJobId});
          if(result.live===true) capabilities.markAvailable('video.generate','comfyui-local');
          return {output_files:result.output_files,provider:result.provider,live:result.live};
        }});
        return sendJson(res,202,{object:'media.job',...job,poll_path:`/v1/videos/jobs/${job.id}`});
      }
      if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
        const body=parseJson(await readBody(req,64*1024));
        if (!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some((key)=>!['file_id','language'].includes(key))||body.language!==undefined&&(typeof body.language!=='string'||!(/^(auto|pt-BR|[a-z]{2,3})$/i.test(body.language)))) throw Object.assign(new Error('Transcription requires file_id and optional language (auto, pt-BR, or a language code).'),{status:400,code:'invalid_transcription_request'});
        const input=await requireStoredFile(files,body?.file_id,'audio/',files.maxFileBytes);
        if (!await mediaProviders.whisper.configured()) throw Object.assign(new Error('Configure Whisper.cpp, its multilingual model, and FFmpeg for local transcription.'),{status:503,code:'provider_not_configured'});
        const language=body.language??'pt';
        const job=jobs.submit({type:'audio.transcribe',inputFileIds:[body.file_id],execute:async ({signal,progress})=>{
          const result=await mediaProviders.whisper.transcribe({buffer:input.buffer,mimeType:input.metadata.mime_type,language},{signal,onProgress:progress});
          const file=await files.create({format:'txt',filename:'transcription.txt',content:result.text});
          capabilities.markAvailable('audio.transcribe','whisper.cpp-local');
          return {output_files:[file],provider:'whisper.cpp-local',live:true};
        }});
        return sendJson(res,202,{object:'media.job',...job,poll_path:`/v1/jobs/${job.id}`});
      }
      if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
        const body=parseJson(await readBody(req,128*1024));
        if (!body||typeof body!=='object'||typeof body.input!=='string'||!body.input.trim()||body.input.length>100000||Object.keys(body).some((key)=>!['input','voice','response_format'].includes(key))||body.voice!==undefined&&(typeof body.voice!=='string'||body.voice.length>120)||body.response_format&&body.response_format!=='wav') throw Object.assign(new Error('Speech request requires input (up to 100000 characters); response_format must be wav.'),{status:400,code:'invalid_speech_request'});
        const result=await mediaProviders.piper.synthesize({text:body.input,voice:body.voice},{signal:controller.signal});
        const file=await files.upload({filename:'speech.wav',mimeType:'audio/wav',buffer:result.buffer});
        capabilities.markAvailable('audio.synthesize','piper-local');
        return sendJson(res,200,{object:'audio.speech',...file,provider:'piper-local',voice:result.voice,language:result.language,download_path:`/v1/files/${file.id}`});
      }
      if (req.method === 'POST' && url.pathname === '/v1/images/analyze') {
        if (!capabilities.get('images.analyze')?.implemented) throw Object.assign(new Error('Image analysis adapter is not implemented.'), { status: 503, code: 'capability_unavailable' });
        const body = parseJson(await readBody(req, 64 * 1024));
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['model','prompt','file_ids'].includes(key)) || typeof body.model !== 'string' || !body.model.trim() || body.model.length>200 || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length>10_000 || !Array.isArray(body.file_ids) || body.file_ids.length < 1 || body.file_ids.length > 10) throw Object.assign(new Error('Image analysis requires model, prompt, and 1–10 file_ids.'), { status: 400, code: 'invalid_image_request' });
        const images = []; let totalBytes = 0;
        for (const id of body.file_ids) {
          if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(id)) throw Object.assign(new Error('Every file_id must be a valid gateway file ID.'), { status: 400, code: 'invalid_image_request' });
          const found = await files.get(id);
          if (!found) throw Object.assign(new Error('An image file was not found or has expired.'), { status: 404, code: 'file_not_found' });
          if (!found.metadata.mime_type.startsWith('image/')) throw Object.assign(new Error('Only stored image files can be analyzed.'), { status: 415, code: 'unsupported_media_type' });
          totalBytes += found.buffer.length;
          if (totalBytes > 10 * 1024 * 1024) throw Object.assign(new Error('Combined image input exceeds 10 MiB.'), { status: 413, code: 'image_input_too_large' });
          images.push({ mimeType: found.metadata.mime_type, buffer: found.buffer });
        }
        const result = await responses.analyzeImages({ model: body.model, prompt: body.prompt, images }, controller.signal);
        if (result.live === true) capabilities.markAvailable('images.analyze', 'siwc-responses');
        return sendJson(res, 200, { object: 'image.analysis', model: result.model, text: result.text, usage: result.usage });
      }
      if (req.method === 'POST' && url.pathname === '/v1/files') {
        if (!capabilities.supports('files.create')) throw Object.assign(new Error('Local file creation capability is unavailable.'), { status: 503, code: 'capability_unavailable' });
        const body = parseJson(await readBody(req, FILE_REQUEST_BODY_LIMIT));
        const metadata = await files.create(body);
        return sendJson(res, 201, { object: 'file', ...metadata, download_path: `/v1/files/${metadata.id}` });
      }
      if (req.method === 'POST' && url.pathname === '/v1/files/upload') {
        if (!capabilities.supports('files.upload')) throw Object.assign(new Error('File upload capability is unavailable.'), { status: 503, code: 'capability_unavailable' });
        const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        let filename, mimeType, buffer;
        if (contentType === 'application/json') {
          const body = parseJson(await readBody(req, FILE_REQUEST_BODY_LIMIT));
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['filename', 'mime_type', 'content_base64'].includes(key)) || typeof body.filename !== 'string' || typeof body.mime_type !== 'string' || typeof body.content_base64 !== 'string') throw Object.assign(new Error('JSON upload requires filename, mime_type, and content_base64.'), { status: 400, code: 'invalid_upload' });
          if (body.content_base64.length > Math.ceil(files.maxFileBytes / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content_base64)) throw Object.assign(new Error('Upload must contain valid base64 data within the file-size limit.'), { status: 400, code: 'invalid_base64' });
          buffer = Buffer.from(body.content_base64, 'base64');
          if (buffer.toString('base64') !== body.content_base64) throw Object.assign(new Error('Upload base64 encoding is not canonical.'), { status: 400, code: 'invalid_base64' });
          filename = body.filename; mimeType = body.mime_type;
        } else {
          const rawUrl = new URL(req.url || '/', `http://${host}`);
          filename = rawUrl.searchParams.get('filename'); mimeType = contentType;
          if (!filename || !mimeType) throw Object.assign(new Error('Binary upload requires Content-Type and a filename query parameter.'), { status:400, code:'invalid_upload' });
          buffer = await readBufferBody(req,files.maxFileBytes);
        }
        const metadata = await files.upload({ filename, mimeType, buffer });
        return sendJson(res, 201, { object: 'file', ...metadata, download_path: `/v1/files/${metadata.id}` });
      }
      const fileRoute = url.pathname.match(/^\/v1\/files\/([A-Za-z0-9_-]{32})$/);
      if (fileRoute && req.method === 'GET') {
        if (!capabilities.supports('files.download')) throw Object.assign(new Error('File download capability is unavailable.'), { status: 503, code: 'capability_unavailable' });
        const found = await files.get(fileRoute[1]);
        if (!found) return sendJson(res, 404, { error: { message: 'File not found or expired.', type: 'invalid_request_error', code: 'file_not_found' } });
        res.writeHead(200, safeDownloadHeaders(found.metadata.filename, found.metadata.mime_type, found.buffer.length));
        return res.end(found.buffer);
      }
      if (fileRoute && req.method === 'DELETE') {
        if (!capabilities.supports('files.download')) throw Object.assign(new Error('File deletion capability is unavailable.'), { status: 503, code: 'capability_unavailable' });
        const deleted = await files.delete(fileRoute[1]);
        return deleted ? sendJson(res, 200, { id: fileRoute[1], deleted: true }) : sendJson(res, 404, { error: { message: 'File not found or expired.', type: 'invalid_request_error', code: 'file_not_found' } });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const models = await responses.listModels(controller.signal);
        return sendJson(res, 200, { object: 'list', data: models.map(({ id, object, created, owned_by }) => ({ id, object, created, owned_by })) });
      }
      if (req.method === 'GET' && url.pathname === '/v1/engine') {
        // Identidade do motor: configurado vs. observado, catálogo por capacidade
        // e estado do circuit breaker. NUNCA inventa: `identity_verified` só é
        // true quando o provedor declarou o modelo na resposta.
        return sendJson(res, 200, {
          object: 'engine',
          gateway: { version: GATEWAY_VERSION, app: appName, provider: 'siwc-responses', upstream: 'https://api.openai.com/v1', authenticated: auth.status().authenticated },
          policy: {
            routing_enabled: engine.routingEnabled,
            primary_model: engine.primaryModel,
            fallback_model: engine.fallbackModel,
            cost_policy: engine.costPolicy,
            timeout_ms: engine.timeoutMs ?? null,
            attempts_per_model: engine.attemptsPerModel,
            specialized: engine.specialized,
          },
          identity: engine.lastIdentity,
          models: engine.catalog.list(),
          breakers: engine.catalog.list().map((entry) => engine.breaker.status(entry.model)),
          runs_recorded: engine.runs.size,
        });
      }
      if (req.method === 'GET' && url.pathname === '/v1/runs') {
        const limit = Number(url.searchParams.get('limit') || 50);
        return sendJson(res, 200, { object: 'list', data: engine.runs.list({ limit }) });
      }
      const runRoute = url.pathname.match(/^\/v1\/runs\/(run_[0-9]{6})$/);
      if (runRoute && req.method === 'GET') {
        const run = engine.runs.get(runRoute[1]);
        return run ? sendJson(res, 200, run) : sendJson(res, 404, { error: { message: 'Run not found.', type: 'invalid_request_error', code: 'run_not_found' } });
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readBody(req, MULTIMODAL_CHAT_BODY_LIMIT);
        const parsed = parseJson(body);
        if (Buffer.byteLength(body, 'utf8') > BODY_LIMIT && !hasImageContent(parsed)) throw Object.assign(new Error('Text-only Chat Completions requests are limited to 1 MiB.'), { status: 413, code: 'request_too_large' });
        const startedRun = now();

        /* Decisão de modelo: só entra em cena quando o roteamento está ligado. */
        let chain = [parsed.model];
        let decision = { reason: 'roteamento_desligado', selected_model: parsed.model };
        if (engine.routingEnabled) {
          const chosen = selectChain({
            capability: 'text.chat',
            primary: engine.primaryModel || parsed.model,
            fallback: engine.fallbackModel,
            requestedModel: parsed.model || null,
            explicit: Boolean(engine.primaryModel) && Boolean(parsed.model) && parsed.model !== engine.primaryModel,
            specialized: engine.specialized,
            catalog: engine.catalog,
            costPolicy: engine.costPolicy,
            breaker: engine.breaker,
          });
          decision = chosen.decision;
          if (!chosen.chain.length) {
            const blockedError = decision.blocked || { code: 'no_candidate_available', message: 'Nenhum modelo pode ser usado com a política atual.' };
            engine.runs.record({
              kind: 'text.chat', status: 'blocked', model_requested: parsed.model || engine.primaryModel || null,
              code: blockedError.code, reason: decision.reason, decision, total_ms: now() - startedRun,
            });
            return sendJson(res, Number(blockedError.code === 'cost_blocked') ? 402 : 503, {
              error: { message: blockedError.message, type: 'gateway_error', code: blockedError.code, retryable: false },
            });
          }
          chain = chosen.chain;
        }

        /* Execução com fallback limitado — só ANTES do primeiro byte. */
        let timing = null;
        let lastError = null;
        const attempts = [];
        for (const model of chain) {
          if (!engine.breaker.allow(model)) {
            attempts.push({ model, outcome: 'skipped', code: 'circuit_open' });
            continue;
          }
          const attemptStart = now();
          try {
            timing = await responses.chatCompletion({ ...parsed, model }, res, controller.signal);
            engine.breaker.record(model, true);
            attempts.push({ model, outcome: 'ok', duration_ms: now() - attemptStart });
            break;
          } catch (error) {
            lastError = error;
            const eligible = isFallbackEligible(error);
            engine.breaker.record(model, !eligible);
            attempts.push({ model, outcome: 'failed', code: error?.code || 'attempt_failed', eligible_for_fallback: eligible, duration_ms: now() - attemptStart });
            // Se algo já foi escrito, não há como trocar de modelo sem corromper o stream.
            if (res.headersSent || !eligible) break;
          }
        }
        if (!timing) throw lastError || Object.assign(new Error('No model executed the request.'), { status: 503, code: 'all_candidates_failed' });

        const identity = {
          model_requested: timing.modelRequested ?? parsed.model ?? null,
          model_used: attempts.find((a) => a.outcome === 'ok')?.model ?? null,
          model_reported: timing.modelReported ?? null,
          identity_verified: Boolean(timing.identityVerified),
          provider: 'siwc-responses',
          upstream_id: timing.upstreamId ?? null,
          fallback_used: attempts.filter((a) => a.outcome === 'ok').length > 1 || attempts.some((a) => a.outcome === 'failed'),
        };
        engine.lastIdentity = { ...identity, at: new Date(now()).toISOString() };
        engine.runs.record({
          kind: 'text.chat',
          status: 'completed',
          ...identity,
          decision,
          attempts,
          latency: { first_useful_ms: timing.firstUsefulMs, total_ms: timing.totalMs },
          usage: timing.usage,
          tool_calls: timing.toolCalls,
        });
        if (timing) console.info(JSON.stringify({ event: 'chat_completion', model: parsed.model, model_reported: timing.modelReported, model_used: identity.model_used, identity_verified: identity.identityVerified, status: 'completed', first_useful_ms: timing.firstUsefulMs, total_ms: timing.totalMs, tool_calls: timing.toolCalls }));
        return;
      }
      if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/auth/')) return sendJson(res, 404, { error: { message: 'Unknown local gateway route.', type: 'invalid_request_error', code: 'not_found' } });
      sendJson(res, 404, { error: { message: 'Not found.', type: 'invalid_request_error', code: 'not_found' } });
    } catch (error) {
      const safe = normalizeError(error);
      const status = Number.isInteger(error.status) ? error.status : (error.code?.includes('auth') || error.code?.includes('sign_in') || error.code?.includes('sharing') ? 401 : 502);
      console.warn(JSON.stringify({ event: 'gateway_error', route: req.url?.split('?')[0], code: safe.code || error.code || 'request_failed', status, elapsed_ms: now() - started }));
      if (res.writableEnded) return;
      if (res.headersSent) {
        if (res.getHeader('content-type')?.toString().includes('text/event-stream')) {
          res.write(`data: ${JSON.stringify({ error: { message: safe.message, type: 'gateway_error', code: safe.code } })}\n\n`);
          res.end();
        } else res.destroy();
      } else sendJson(res, status, { error: { message: safe.message, type: status === 401 ? 'authentication_error' : 'gateway_error', code: safe.code || error.code || 'request_failed', retryable: Boolean(error.retryable) } });
    }
  });

  return { server, auth, responses, async listen() {
    await auth.initialize();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
    const address = server.address();
    if (address && typeof address === 'object' && address.port !== auth.port) throw new Error(`Configured callback port ${auth.port} differs from listening port ${address.port}.`);
    return address;
  }, async close() { auth.clear(); files.close(); await jobs.close(); return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }, jobs, mediaProviders, capabilities, files };
}

function bearerIsValid(header, expected) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7)); const correct = Buffer.from(expected);
  return provided.length === correct.length && timingSafeEqual(provided, correct);
}
function consumeLimit(map, key, now) {
  const windowMs = 60_000; const max = 30; const item = map.get(key);
  if (!item || now >= item.resetAt) { map.set(key, { count: 1, resetAt: now + windowMs }); return false; }
  if (item.count >= max) return true;
  item.count++; return false;
}
function hasImageContent(request) { return Array.isArray(request?.messages) && request.messages.some((message) => Array.isArray(message?.content) && message.content.some((part) => part?.type === 'image_url')); }
async function readBody(req, limit = BODY_LIMIT) {
  return (await readBufferBody(req,limit)).toString('utf8');
}
async function readBufferBody(req, limit = BODY_LIMIT) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(`Request body exceeds ${limit} bytes.`), { status: 413, code: 'request_too_large' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function parseJson(text) {
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400, code: 'invalid_json' }); }
}
function sendJson(res, status, data) { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(data)); }
function sendHtml(res, status, html) { res.statusCode = status; res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(html); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function validatePrompt(body, allowedKeys=['prompt']) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 10_000 || Object.keys(body).some((key)=>!allowedKeys.includes(key))) throw Object.assign(new Error('Request requires prompt (1–10000 characters) and only documented fields.'), {status:400,code:'invalid_media_request'});
}
async function requireStoredFile(files, id, mimePrefix, maxBytes) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(id)) throw Object.assign(new Error('A valid gateway file_id is required.'), {status:400,code:'invalid_file_id'});
  const found=await files.get(id);
  if (!found) throw Object.assign(new Error('File not found or expired.'), {status:404,code:'file_not_found'});
  if (!found.metadata.mime_type.startsWith(mimePrefix)) throw Object.assign(new Error(`Expected a ${mimePrefix.slice(0,-1)} file.`), {status:415,code:'unsupported_media_type'});
  if (found.buffer.length>maxBytes) throw Object.assign(new Error('Input file exceeds the operation size limit.'),{status:413,code:'media_input_too_large'});
  return found;
}
