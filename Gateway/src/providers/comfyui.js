import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { basename } from 'node:path';

const OUTPUT_MIME = new Map([['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.webp','image/webp'],['.gif','image/gif'],['.mp4','video/mp4'],['.mov','video/quicktime'],['.webm','video/webm']]);
const WORKFLOW_ENV = Object.freeze({
  image_generate: 'COMFYUI_IMAGE_GENERATE_WORKFLOW',
  image_edit: 'COMFYUI_IMAGE_EDIT_WORKFLOW',
  video_generate: 'COMFYUI_VIDEO_GENERATE_WORKFLOW',
});
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' }));
  const timer = setTimeout(resolve, ms); timer.unref?.();
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' })); }, { once: true });
});

export class ComfyUIProvider {
  constructor({ baseUrl, workflows = {}, files, fetchImpl = fetch, pollIntervalMs = 1500, maxJobMs = 20 * 60_000 } = {}) {
    this.baseUrl = validateLocalBase(baseUrl);
    this.workflows = workflows;
    this.files = files;
    this.fetch = fetchImpl;
    this.pollIntervalMs = pollIntervalMs;
    this.maxJobMs = maxJobMs;
  }

  async configured(operation) {
    const path = this.workflows[operation] || (WORKFLOW_ENV[operation] ? process.env[WORKFLOW_ENV[operation]] : null);
    if (!this.baseUrl || !path || !isAbsolute(path)) return false;
    try {
      const spec = await readWorkflow(path);
      const required = operation === 'image_edit' ? ['prompt','input_image'] : operation === 'video_generate' ? ['prompt','duration'] : ['prompt'];
      return required.every((name) => validBindings(spec.workflow, spec.bindings?.[name]));
    } catch { return false; }
  }

  async health(signal) {
    if (!this.baseUrl) return { ready: false, reason: 'ComfyUI local URL is not configured.' };
    try {
      const response = await this.request('/system_stats', { signal, timeoutMs: 3000 });
      if (!response.ok) return { ready: false, reason: 'ComfyUI health route did not return success.' };
      const data = await response.json();
      return { ready: true, devices: (data.devices || []).map((device) => ({ name: device.name, vram_total: device.vram_total })) };
    } catch { return { ready: false, reason: 'ComfyUI is not reachable on the configured loopback address.' }; }
  }

  async run({ operation, prompt, inputFile = null, durationSeconds, signal, onProgress = () => {}, onBackendJobId = () => {} }) {
    if (!await this.configured(operation)) throw Object.assign(new Error(`Configure a valid ComfyUI workflow file for ${operation}.`), { status: 503, code: 'provider_not_configured' });
    const workflowPath = this.workflows[operation] || process.env[WORKFLOW_ENV[operation]];
    const spec = await readWorkflow(workflowPath);
    const workflow = structuredClone(spec.workflow);
    setBindings(workflow, spec.bindings?.prompt, prompt);
    setBindings(workflow, spec.bindings?.duration, durationSeconds);
    if (inputFile) {
      const upload = await this.uploadImage(inputFile, signal);
      setBindings(workflow, spec.bindings?.input_image, upload.name);
    }
    if (spec.bindings?.seed) setBindings(workflow, spec.bindings.seed, Math.floor(Math.random() * 2 ** 31));
    const clientId = randomUUID();
    onProgress(5, 'submitting_workflow');
    const queued = await this.json('/prompt', { method: 'POST', body: { prompt: workflow, client_id: clientId }, signal });
    if (!queued.prompt_id) throw Object.assign(new Error('ComfyUI did not return a workflow job ID.'), { code: 'provider_invalid_response' });
    onBackendJobId(queued.prompt_id);
    try {
      const deadline = Date.now() + this.maxJobMs;
      let lastProgress = 10;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' });
        await sleep(this.pollIntervalMs, signal);
        const history = await this.json(`/history/${encodeURIComponent(queued.prompt_id)}`, { signal });
        const record = history[queued.prompt_id] || history;
        const status = record?.status || {};
        if (status.status_str === 'error' || status.completed === false && status.messages?.some?.((entry) => entry[0] === 'execution_error')) throw Object.assign(new Error('ComfyUI workflow failed.'), { code: 'provider_workflow_failed' });
        const outputs = collectOutputs(record?.outputs, spec.output_nodes);
        if (status.completed === true || status.status_str === 'success') {
          if (!outputs.length) throw Object.assign(new Error('ComfyUI workflow completed without a downloadable output.'), { code: 'provider_no_output' });
          onProgress(90, 'downloading_outputs');
          const result = [];
          for (const output of outputs) {
            safeOutputName(output.filename);
            if (output.type !== 'output' || String(output.subfolder).split(/[\\\\/]/).includes('..')) throw Object.assign(new Error('ComfyUI output path is outside the output area.'), { code: 'provider_invalid_output' });
            const mimeType = OUTPUT_MIME.get(extensionOf(output.filename));
            if (!mimeType) continue;
            const url = new URL('/view', this.baseUrl);
            url.searchParams.set('filename', output.filename); url.searchParams.set('subfolder', output.subfolder || ''); url.searchParams.set('type', output.type || 'output');
            const response = await this.fetch(url, { signal, redirect: 'error' });
            if (!response.ok) throw Object.assign(new Error('Could not download a ComfyUI output.'), { code: 'provider_output_download_failed' });
            const declaredSize=Number(response.headers.get('content-length'));
            if(Number.isFinite(declaredSize)&&declaredSize>(this.files?.maxFileBytes||250*1024*1024)) throw Object.assign(new Error('ComfyUI output exceeds the gateway file-size limit.'),{status:413,code:'provider_output_too_large'});
            const buffer = Buffer.from(await response.arrayBuffer());
            if(buffer.length>(this.files?.maxFileBytes||250*1024*1024)) throw Object.assign(new Error('ComfyUI output exceeds the gateway file-size limit.'),{status:413,code:'provider_output_too_large'});
            const metadata = await this.files.upload({ filename: safeOutputName(output.filename), mimeType, buffer });
            result.push(metadata);
          }
          if (!result.length) throw Object.assign(new Error('ComfyUI returned no supported image/video output format.'), { code: 'provider_no_output' });
          onProgress(100, 'completed');
          return { output_files: result, provider: 'comfyui-local', backend_job_id: queued.prompt_id, live: true };
        }
        if (lastProgress < 45) { lastProgress += 5; onProgress(lastProgress, status.status_str === 'running' ? 'running_workflow' : 'queued'); }
      }
      throw Object.assign(new Error('ComfyUI workflow exceeded the configured time limit.'), { code: 'provider_timeout' });
    } catch (error) {
      if (signal?.aborted || error.code === 'cancelled') await this.cancel(queued.prompt_id).catch(() => {});
      throw error;
    }
  }

  async cancel(promptId) {
    if (!this.baseUrl || typeof promptId !== 'string') return { cancelled: false };
    const queue = await this.json('/queue', { signal: AbortSignal.timeout(5000) }).catch(() => null);
    const running = queue?.queue_running || [];
    const isRunning = running.some((entry) => Array.isArray(entry) ? entry[1] === promptId : entry?.prompt_id === promptId);
    if (isRunning) {
      await this.json('/interrupt', { method: 'POST', body: {}, signal: AbortSignal.timeout(5000) });
      return { cancelled: true, mode: 'interrupt_current' };
    }
    await this.json('/queue', { method: 'POST', body: { delete: [promptId] }, signal: AbortSignal.timeout(5000) });
    return { cancelled: true, mode: 'remove_queued' };
  }

  async uploadImage(file, signal) {
    const form = new FormData();
    form.append('image', new Blob([file.buffer], { type: file.mimeType }), safeOutputName(file.filename));
    form.append('type', 'input'); form.append('overwrite', 'true');
    const response = await this.fetch(new URL('/upload/image', this.baseUrl), { method: 'POST', body: form, signal, redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error('ComfyUI rejected the workflow image input.'), { code: 'provider_input_upload_failed' });
    const data = await response.json();
    if (typeof data.name !== 'string' || !data.name) throw Object.assign(new Error('ComfyUI image upload returned no filename.'), { code: 'provider_invalid_response' });
    return data;
  }

  async request(path, { method = 'GET', body, signal, timeoutMs = 15_000 } = {}) {
    const controller = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    return this.fetch(new URL(path, this.baseUrl), { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: controller, redirect: 'error' });
  }

  async json(path, options = {}) {
    const response = await this.request(path, options);
    let data = {};
    try { data = await response.json(); } catch { /* summarized error below */ }
    if (!response.ok) throw Object.assign(new Error('ComfyUI returned an unsuccessful response.'), { code: 'provider_http_error', status: response.status });
    if (!data || typeof data !== 'object') throw Object.assign(new Error('ComfyUI returned invalid JSON.'), { code: 'provider_invalid_response' });
    return data;
  }
}

function validateLocalBase(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new TypeError('COMFYUI_BASE_URL must be a loopback URL.'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','::1'].includes(host) || url.username || url.password || url.search || url.hash) throw new TypeError('ComfyUI adapter only permits an unauthenticated HTTP loopback URL.');
  return url.origin;
}
async function readWorkflow(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Object.assign(new Error('Workflow paths must be absolute.'), { code: 'workflow_not_configured' });
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); } catch { throw Object.assign(new Error('ComfyUI workflow file is missing or invalid JSON.'), { code: 'workflow_not_configured' }); }
  const workflow = config.workflow || config;
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) || !Object.keys(workflow).length) throw Object.assign(new Error('Workflow must be a non-empty API-format node map.'), { code: 'workflow_invalid' });
  if (config.workflow && (!config.bindings || typeof config.bindings !== 'object')) throw Object.assign(new Error('Workflow wrapper requires a bindings map.'), { code: 'workflow_invalid' });
  return { workflow, bindings: config.bindings || {}, output_nodes: Array.isArray(config.output_nodes) ? config.output_nodes.map(String) : null };
}
function validBindings(workflow, bindings) {
  return Array.isArray(bindings) && bindings.length > 0 && bindings.every((binding) => binding && typeof binding.node === 'string' && typeof binding.field === 'string' && workflow[binding.node]?.inputs && Object.hasOwn(workflow[binding.node].inputs,binding.field));
}
function setBindings(workflow, bindings, value) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(bindings) || !bindings.length) throw Object.assign(new Error('Workflow is missing a binding for a required input.'), { code: 'workflow_binding_missing' });
  for (const binding of bindings) {
    if (!binding || typeof binding.node !== 'string' || typeof binding.field !== 'string' || !workflow[binding.node]?.inputs || !(binding.field in workflow[binding.node].inputs)) throw Object.assign(new Error('Workflow binding points to a missing node input.'), { code: 'workflow_binding_invalid' });
    workflow[binding.node].inputs[binding.field] = value;
  }
}
function collectOutputs(outputs, allowedNodes) {
  if (!outputs || typeof outputs !== 'object') return [];
  const found = [];
  for (const [nodeId, value] of Object.entries(outputs)) {
    if (allowedNodes?.length && !allowedNodes.includes(nodeId)) continue;
    if (!value || typeof value !== 'object') continue;
    for (const key of ['images','videos','gifs']) {
      if (!Array.isArray(value[key])) continue;
      for (const item of value[key]) if (item && typeof item.filename === 'string') found.push({ filename: item.filename, subfolder: item.subfolder || '', type: item.type || 'output' });
    }
  }
  return found;
}
function extensionOf(filename) { return filename.toLowerCase().slice(filename.lastIndexOf('.')); }
function safeOutputName(filename) {
  if (typeof filename !== 'string' || basename(filename) !== filename || filename.includes('..') || /[\\/\u0000-\u001f]/.test(filename)) throw Object.assign(new Error('Provider returned an unsafe filename.'), { code: 'provider_invalid_output' });
  return filename;
}
