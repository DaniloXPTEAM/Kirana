import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = 'https://auth.openai.com';
const AUTH_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const SHARE_SCOPE = 'chatgpt.tokens.use.direct';
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SiwcAuth {
  constructor({ appName, stateDir, port = 1455, fetchImpl = fetch, now = Date.now, verifyIdToken = null }) {
    this.appName = appName;
    this.port = port;
    this.verifyIdToken = verifyIdToken;
    this.stateDir = resolve(stateDir);
    this.registrationFile = join(this.stateDir, 'registration.json');
    this.fetch = fetchImpl;
    this.now = now;
    this.tokens = null; // Access/refresh tokens intentionally remain memory-only.
    this.grantedScopes = []; // Scope names are non-secret metadata; never persist or log them with tokens.
    this.pending = null;
    this.refreshing = null;
    this.jwks = createRemoteJWKSet(new URL(JWKS_URL));
    this.registration = null;
  }

  async initialize() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700);
    try {
      const raw = JSON.parse(await readFile(this.registrationFile, 'utf8'));
      // clientId:null é o estado que este mesmo código grava antes do primeiro consentimento
      // (ver o catch abaixo). Exigir string aqui fazia a SEGUNDA partida recusar o próprio
      // arquivo e sugerir apagar o registro — o que trocaria o hostId e invalidaria o SIWC.
      if (raw.version !== 1 || typeof raw.hostId !== 'string' || (raw.clientId !== null && typeof raw.clientId !== 'string')) throw new Error('bad state');
      this.registration = raw;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Local registration state is invalid; remove or restore registration.json.');
      this.registration = { version: 1, hostId: `urn:uuid:${randomUUID()}`, clientId: null };
      await this.saveRegistration();
    }
  }

  async saveRegistration() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700);
    const tmp = `${this.registrationFile}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.registration, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(tmp, this.registrationFile);
  }

  createAuthorization() {
    if (this.pending) throw Object.assign(new Error('An authorization attempt is already pending.'), { code: 'auth_in_progress' });
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    this.pending = { state, nonce, verifier, createdAt: this.now() };
    const redirectUri = `http://127.0.0.1:${this.port}/auth/callback`;
    const params = new URLSearchParams({
      client_id: this.registration.clientId || 'dynamic_agent_client',
      ...(!this.registration.clientId ? { agent_name_hint: this.appName } : {}),
      ext_agent_host_id: this.registration.hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    return { url: `${AUTH_URL}?${params.toString()}`, redirectUri };
  }

  async handleCallback(url) {
    const callback = new URL(url, 'http://127.0.0.1');
    const attempt = this.pending;
    this.pending = null;
    if (!attempt || this.now() - attempt.createdAt > 15 * 60_000) throw authError('auth_state_expired', 'Sign-in attempt expired. Start again.');
    if (callback.searchParams.get('state') !== attempt.state) throw authError('invalid_state', 'OAuth state did not match. Sign-in was rejected.');
    const oauthError = callback.searchParams.get('error');
    if (oauthError) throw authError(oauthError === 'access_denied' ? 'consent_denied' : 'oauth_error', 'OpenAI sign-in was not completed.');
    const code = callback.searchParams.get('code');
    const issuedClientId = callback.searchParams.get('client_id');
    const clientId = this.registration.clientId || issuedClientId;
    if (!code || !clientId) throw authError('callback_incomplete', 'Callback did not contain an authorization code and issued client ID.');
    const redirectUri = `http://127.0.0.1:${this.port}/auth/callback`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code', client_id: clientId, code,
      code_verifier: attempt.verifier, redirect_uri: redirectUri, resource: RESOURCE,
    });
    const response = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!response.ok) throw authError('token_exchange_failed', `OpenAI token exchange failed (${response.status}).`);
    const token = await response.json();
    if (typeof token.access_token !== 'string' || typeof token.id_token !== 'string') throw authError('invalid_token_response', 'OpenAI token response omitted required tokens.');
    const granted = String(token.scope || '').split(/\s+/).filter(Boolean);
    if (!granted.includes(SHARE_SCOPE)) throw authError('sharing_scope_missing', 'Identity sign-in succeeded, but ChatGPT plan-use permission was not granted. Reconnect and explicitly enable plan usage.');
    const payload = this.verifyIdToken
      ? await this.verifyIdToken(token.id_token, { issuer: ISSUER, audience: clientId, nonce: attempt.nonce })
      : (await jwtVerify(token.id_token, this.jwks, { issuer: ISSUER, audience: clientId, nonce: attempt.nonce, clockTolerance: 5 })).payload;
    if (typeof payload.sub !== 'string' || !payload.sub) throw authError('invalid_identity', 'Verified ID token has no subject.');
    this.registration.clientId = clientId;
    await this.saveRegistration();
    this.tokens = { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: this.now() + Number(token.expires_in || 3600) * 1000, earliestRefreshAt: token.earliest_refresh_at };
    this.grantedScopes = [...granted];
    return { authenticated: true, sharing: true, subject: payload.sub, name: payload.name, email: payload.email, scopes: [...granted] };
  }

  status() { return { authenticated: Boolean(this.tokens), sharing: Boolean(this.tokens), tokenStorage: 'memory-only', registrationConfigured: Boolean(this.registration?.clientId), grantedScopes: [...this.grantedScopes] }; }

  async accessToken(signal) {
    if (!this.tokens) throw authError('authentication_required', 'Run the local Sign in with ChatGPT flow first.');
    if (this.tokens.expiresAt > this.now() + 60_000) return this.tokens.accessToken;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.#refresh(signal).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async #refresh(signal) {
    if (!this.tokens?.refreshToken) { this.tokens = null; throw authError('reauthentication_required', 'The session expired. Sign in again.'); }
    const refreshAt = this.tokens.earliestRefreshAt;
    const earliest = typeof refreshAt === 'number' ? refreshAt * 1000 : typeof refreshAt === 'string' ? (Date.parse(refreshAt) || 0) : 0;
    if (earliest > this.now()) throw authError('refresh_not_ready', 'OpenAI has not yet made this rotating refresh token eligible. Retry shortly.', true);
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: this.registration.clientId, refresh_token: this.tokens.refreshToken, resource: RESOURCE });
    let response;
    try { response = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), redirect: 'error' }); }
    catch { throw authError('refresh_network_error', 'Token refresh could not reach OpenAI.', true); }
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) this.tokens = null;
      throw authError('refresh_failed', `Token refresh failed (${response.status}); sign-in may be required.`, response.status >= 500 || response.status === 429);
    }
    const next = await response.json();
    if (typeof next.access_token !== 'string' || typeof next.refresh_token !== 'string') { this.tokens = null; throw authError('invalid_refresh_response', 'Refresh did not return rotated credentials. Sign in again.'); }
    const granted = String(next.scope || '').split(/\s+/).filter(Boolean);
    if (!granted.includes(SHARE_SCOPE)) { this.tokens = null; this.grantedScopes = []; throw authError('sharing_scope_missing', 'The refreshed grant no longer includes ChatGPT plan-use permission.'); }
    this.tokens = { accessToken: next.access_token, refreshToken: next.refresh_token, expiresAt: this.now() + Number(next.expires_in || 3600) * 1000, earliestRefreshAt: next.earliest_refresh_at };
    this.grantedScopes = [...granted];
    return this.tokens.accessToken;
  }

  clear() { this.tokens = null; this.grantedScopes = []; this.pending = null; }
}

function authError(code, message, retryable = false) {
  const status = code === 'refresh_not_ready' || code === 'refresh_network_error' ? 503 : ['invalid_state','callback_incomplete','consent_denied','oauth_error','auth_state_expired'].includes(code) ? 400 : ['authentication_required','reauthentication_required','sharing_scope_missing','refresh_failed','token_exchange_failed'].includes(code) ? 401 : undefined;
  return Object.assign(new Error(message), { code, retryable, ...(status ? { status } : {}) });
}
