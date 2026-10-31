import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class JobManager {
  constructor({ directory, maxConcurrent = 1, maxQueued = 10, maxRecords = 200, retentionMs = 24 * 60 * 60_000, now = Date.now } = {}) {
    this.directory = resolve(directory || '.local-state/jobs');
    this.filePath = join(this.directory, 'jobs.json');
    this.maxConcurrent = maxConcurrent; this.maxQueued = maxQueued; this.maxRecords = maxRecords; this.retentionMs = retentionMs; this.now = now;
    this.jobs = new Map(); this.queue = []; this.runners = new Map(); this.controllers = new Map(); this.tasks = new Set(); this.running = 0; this.closing = false;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.load();
  }

  load() {
    let items = [];
    try { items = JSON.parse(readFileSync(this.filePath, 'utf8')).jobs; } catch { items = []; }
    if (!Array.isArray(items)) return;
    for (const item of items.slice(-this.maxRecords)) {
      if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{32}$/.test(item.id) || typeof item.type !== 'string') continue;
      const job = sanitizePersisted(item);
      if (['queued','running','cancel_requested'].includes(job.status)) { job.status = 'interrupted'; job.stage = 'process_restarted'; job.error_code = 'process_restarted'; job.updated_at = new Date(this.now()).toISOString(); }
      this.jobs.set(job.id, job);
    }
    this.persist();
  }

  submit({ type, inputFileIds = [], execute, cancel }) {
    if (this.closing) throw Object.assign(new Error('Gateway is shutting down.'), { status: 503, code: 'gateway_shutting_down' });
    if (typeof type !== 'string' || !/^[a-z][a-z0-9_.-]{1,63}$/.test(type) || typeof execute !== 'function') throw Object.assign(new Error('Job type and executor are required.'), { status: 400, code: 'invalid_job_request' });
    if (this.queue.length >= this.maxQueued) throw Object.assign(new Error('Local job queue is full.'), { status: 429, code: 'job_queue_full' });
    this.prune();
    const id = randomBytes(16).toString('hex'); const now = this.now();
    const job = {
      id, type, status: 'queued', progress: 0, stage: 'queued', created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
      input_file_ids: inputFileIds.filter((value) => typeof value === 'string').slice(0,20), output_files: [], result_file: null,
      provider: null, provider_job_id: null, error_code: null, live_verified: false,
    };
    this.jobs.set(id, job); this.runners.set(id, { execute, cancel }); this.queue.push(id); this.persist();
    queueMicrotask(() => this.pump());
    return this.snapshot(job);
  }

  get(id) { const job = this.jobs.get(id); return job ? this.snapshot(job) : null; }
  list({ limit = 50 } = {}) { return [...this.jobs.values()].slice(-Math.min(Math.max(limit,1),100)).reverse().map((job) => this.snapshot(job)); }

  async cancel(id) {
    const job = this.jobs.get(id); if (!job) return null;
    if (['succeeded','failed','cancelled','interrupted'].includes(job.status)) return this.snapshot(job);
    if (job.status === 'queued') {
      this.queue = this.queue.filter((queued) => queued !== id);
      job.status = 'cancelled'; job.stage = 'cancelled'; job.updated_at = new Date(this.now()).toISOString();
      this.runners.delete(id); this.persist(); return this.snapshot(job);
    }
    job.status = 'cancel_requested'; job.stage = 'cancelling'; job.updated_at = new Date(this.now()).toISOString(); this.persist();
    this.controllers.get(id)?.abort();
    return this.snapshot(job);
  }

  async close() {
    this.closing = true;
    for (const id of [...this.queue]) await this.cancel(id);
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.tasks]);
  }

  pump() {
    while (!this.closing && this.running < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift(); const job = this.jobs.get(id); const runner = this.runners.get(id);
      if (!job || job.status !== 'queued' || !runner) continue;
      this.running++;
      const task=this.execute(id,job,runner); this.tasks.add(task);
      task.finally(()=>{this.tasks.delete(task);this.running--;this.pump();});
    }
  }

  async execute(id, job, runner) {
    const controller = new AbortController(); this.controllers.set(id, controller);
    job.status = 'running'; job.stage = 'starting'; job.progress = 1; job.updated_at = new Date(this.now()).toISOString(); this.persist();
    const progress = (value, stage) => {
      if (job.status !== 'running' && job.status !== 'cancel_requested') return;
      if (Number.isFinite(value)) job.progress = Math.max(job.progress, Math.min(99, Math.floor(value)));
      if (typeof stage === 'string') job.stage = stage.slice(0,64);
      job.updated_at = new Date(this.now()).toISOString(); this.persist();
    };
    try {
      const result = await runner.execute({ signal: controller.signal, progress, setProviderJobId: (backendId) => {
        if (typeof backendId === 'string' && backendId.length <= 128) { job.provider_job_id = backendId; job.updated_at = new Date(this.now()).toISOString(); this.persist(); }
      } });
      if (controller.signal.aborted || job.status === 'cancel_requested') {
        job.status = 'cancelled'; job.stage = 'cancelled'; job.progress = 0; job.error_code = 'cancelled';
      } else {
        job.status = 'succeeded'; job.stage = 'completed'; job.progress = 100; job.error_code = null;
        job.output_files = (result?.output_files || []).map(publicFileMetadata).filter(Boolean);
        job.result_file = result?.result_file ? publicFileMetadata(result.result_file) : null;
        job.provider = typeof result?.provider === 'string' ? result.provider : null;
        job.live_verified = result?.live === true;
      }
    } catch (error) {
      job.status = controller.signal.aborted || job.status === 'cancel_requested' || error?.code === 'cancelled' ? 'cancelled' : 'failed';
      job.stage = job.status; job.error_code = safeErrorCode(error?.code); if (job.status === 'cancelled') job.progress = 0;
    } finally {
      job.updated_at = new Date(this.now()).toISOString(); this.controllers.delete(id); this.runners.delete(id); this.persist();
    }
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, job] of this.jobs) if (this.jobs.size >= this.maxRecords && Date.parse(job.updated_at) < cutoff && !['queued','running','cancel_requested'].includes(job.status)) this.jobs.delete(id);
    while (this.jobs.size >= this.maxRecords) {
      const candidate = [...this.jobs.values()].find((job) => !['queued','running','cancel_requested'].includes(job.status));
      if (!candidate) break;
      this.jobs.delete(candidate.id);
    }
  }

  persist() {
    const temporary = `${this.filePath}.${randomBytes(6).toString('hex')}.tmp`;
    try { writeFileSync(temporary, JSON.stringify({ version: 1, jobs: [...this.jobs.values()].map(sanitizePersisted) }), { encoding:'utf8', mode:0o600 }); renameSync(temporary, this.filePath); }
    catch { try { rmSync(temporary,{force:true}); } catch {} throw Object.assign(new Error('Could not persist media job state.'),{status:500,code:'job_storage_error'}); }
  }

  snapshot(job) {
    return {
      id: job.id, type: job.type, status: job.status, progress: job.progress, stage: job.stage,
      created_at: job.created_at, updated_at: job.updated_at, input_file_ids: [...job.input_file_ids],
      output_files: job.output_files.map((file) => ({ ...file, download_path: `/v1/files/${file.id}` })),
      result_file: job.result_file ? { ...job.result_file, download_path: `/v1/files/${job.result_file.id}` } : null,
      provider: job.provider, provider_job_id: job.provider_job_id, error_code: job.error_code, live_verified: job.live_verified,
    };
  }
}

function publicFileMetadata(file) {
  if (!file || typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(file.id)) return null;
  return { id: file.id, filename: String(file.filename || 'output'), mime_type: String(file.mime_type || 'application/octet-stream'), size_bytes: Number(file.size_bytes) || 0, expires_at: file.expires_at || null };
}
function safeErrorCode(code) { return typeof code === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(code) ? code : 'job_failed'; }
function sanitizePersisted(item) {
  const output_files = Array.isArray(item.output_files) ? item.output_files.map(publicFileMetadata).filter(Boolean) : [];
  return {
    id: item.id, type: item.type.slice(0,64), status: item.status, progress: Math.max(0,Math.min(100,Number(item.progress)||0)), stage: typeof item.stage==='string'?item.stage.slice(0,64):'unknown',
    created_at: typeof item.created_at==='string'?item.created_at:new Date().toISOString(), updated_at: typeof item.updated_at==='string'?item.updated_at:new Date().toISOString(),
    input_file_ids: Array.isArray(item.input_file_ids)?item.input_file_ids.filter((id)=>typeof id==='string'&&/^[A-Za-z0-9_-]{32}$/.test(id)).slice(0,20):[],
    output_files, result_file: item.result_file ? publicFileMetadata(item.result_file) : null,
    provider: typeof item.provider==='string'?item.provider.slice(0,64):null, provider_job_id: typeof item.provider_job_id==='string'&&item.provider_job_id.length<=128?item.provider_job_id:null,
    error_code: item.error_code ? safeErrorCode(item.error_code) : null, live_verified: item.live_verified===true,
  };
}
