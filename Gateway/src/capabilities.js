const BUILTIN_CAPABILITIES = new Set(['text.chat','files.create','files.upload','files.download']);
const CODED_MEDIA_CAPABILITIES = new Set(['images.analyze','images.generate','images.edit','video.analyze','video.generate','audio.transcribe','audio.synthesize']);
const KNOWN_CAPABILITIES = ['text.chat','images.analyze','images.generate','images.edit','video.analyze','video.generate','audio.transcribe','audio.synthesize','files.create','files.upload','files.download'];
const DEFAULT_PROVIDERS = {
  'images.analyze':'siwc-responses', 'images.generate':'comfyui-local', 'images.edit':'comfyui-local',
  'video.analyze':'ffmpeg-keyframes+siwc+whisper.cpp', 'video.generate':'comfyui-local',
  'audio.transcribe':'whisper.cpp-local', 'audio.synthesize':'piper-local',
};

/** Runtime catalog. Adapters are implemented in code; an engine is available only after a real successful operation. */
export class CapabilityRegistry {
  #entries = new Map();

  constructor({ textProvider = 'siwc-responses', fileProvider = 'local-files', configuredProviders = {} } = {}) {
    for (const name of KNOWN_CAPABILITIES) {
      const builtin = BUILTIN_CAPABILITIES.has(name);
      const provider = name === 'text.chat' ? textProvider : name.startsWith('files.') ? fileProvider : null;
      const configuredProvider = name === 'text.chat' || name.startsWith('files.') ? null : (DEFAULT_PROVIDERS[name] || null);
      const implemented = builtin || CODED_MEDIA_CAPABILITIES.has(name);
      const available = builtin;
      this.#entries.set(name, Object.freeze({
        name, implemented, configured: builtin, ready: available, available,
        provider: available ? provider : null, configured_provider: configuredProvider,
        provider_preference: typeof configuredProviders[name] === 'string' ? configuredProviders[name] : null,
        status: available ? 'implemented' : implemented ? 'pending_configuration' : 'not_implemented',
        reason: available ? null : implemented ? 'Adapter is implemented, but its runtime has not passed a real operation check.' : 'No adapter is implemented.',
        verified: builtin,
      }));
    }
  }

  register(name, entry) {
    if (!KNOWN_CAPABILITIES.includes(name)) throw new TypeError(`Unknown capability: ${name}`);
    if (!entry || typeof entry.available !== 'boolean') throw new TypeError('Capability entry requires an available boolean.');
    if (entry.available && (typeof entry.provider !== 'string' || !entry.provider.trim())) throw new TypeError('Available capabilities require a provider identifier.');
    const current = this.#entries.get(name);
    this.#entries.set(name, Object.freeze({
      name,
      implemented: entry.implemented ?? current?.implemented ?? entry.available,
      configured: entry.configured ?? current?.configured ?? entry.available,
      ready: entry.ready ?? current?.ready ?? entry.available,
      available: entry.available,
      provider: entry.available ? entry.provider : null,
      configured_provider: typeof entry.configured_provider === 'string' ? entry.configured_provider : current?.configured_provider ?? null,
      provider_preference: typeof entry.provider_preference === 'string' ? entry.provider_preference : current?.provider_preference ?? null,
      status: entry.status || (entry.available ? 'available' : 'not_configured'),
      reason: entry.available ? null : (entry.reason || 'No provider is configured.'),
      verified: entry.verified ?? current?.verified ?? entry.available,
    }));
  }

  setRuntimeState(name, { configured, ready, reason, provider } = {}) {
    const current = this.get(name);
    if (!current?.implemented) return;
    const isConfigured = Boolean(configured); const isReady = Boolean(ready);
    const available = current.verified && isReady;
    const status = !isConfigured ? 'pending_configuration' : !isReady ? 'configured_provider_unavailable' : available ? 'verified_after_successful_operation' : 'awaiting_real_success';
    const detail = !isConfigured ? (reason || 'Required engine/workflow configuration is missing.') : !isReady ? (reason || 'Configured provider is not ready.') : available ? null : 'Provider is ready, but no successful real operation has been recorded in this process.';
    this.#entries.set(name, Object.freeze({ ...current, configured:isConfigured, ready:isReady, available, provider:available ? (provider || current.configured_provider) : null, status, reason:detail }));
  }

  markAvailable(name, provider) {
    const current = this.get(name);
    if (!current?.implemented) throw new TypeError(`Capability ${name} has no implemented adapter.`);
    this.#entries.set(name, Object.freeze({ ...current, configured:true, ready:true, available:true, verified:true, provider, status:'verified_after_successful_operation', reason:null }));
  }

  get(name) { return this.#entries.get(name) || null; }
  supports(name) { return this.#entries.get(name)?.available === true; }
  list() { return [...this.#entries.values()]; }
}
