import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiwcAuth } from '../src/auth.js';

async function fixture(t, overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'siwc-gateway-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return new SiwcAuth({ appName: 'POC Test', stateDir, port: 1455, ...overrides });
}

test('creates the documented SIWC dynamic-client authorization request with PKCE, state, nonce and host id', async (t) => {
  const auth = await fixture(t); await auth.initialize();
  const { url, redirectUri } = auth.createAuthorization(); const u = new URL(url);
  assert.equal(u.origin, 'https://auth.openai.com'); assert.equal(u.pathname, '/api/accounts/authorize');
  assert.equal(u.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(u.searchParams.get('agent_name_hint'), 'POC Test');
  assert.match(u.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.equal(redirectUri, u.searchParams.get('redirect_uri'));
  assert.equal(u.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.deepEqual(new Set(u.searchParams.get('scope').split(' ')), new Set(['openid','profile','email','offline_access','resource.invoke','chatgpt.tokens.use.direct']));
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(u.searchParams.get('state')); assert.ok(u.searchParams.get('nonce')); assert.ok(u.searchParams.get('code_challenge'));
});

test('exchanges callback code only after state match, validates plan scope, keeps tokens memory-only and persists issued registration', async (t) => {
  let request;
  const auth = await fixture(t, {
    fetchImpl: async (url, init) => { request = { url: String(url), body: new URLSearchParams(init.body) }; return Response.json({ access_token: 'mock_access_secret', refresh_token: 'mock_refresh_secret', id_token: 'signed-id-token', expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' }); },
    verifyIdToken: async (_token, expected) => { assert.equal(expected.issuer, 'https://auth.openai.com'); assert.equal(expected.audience, 'issued-dynamic-id'); return { sub: 'subject-test', email: 'private@example.test', name: 'POC User' }; },
  });
  await auth.initialize(); const { url } = auth.createAuthorization(); const state = new URL(url).searchParams.get('state'); const result = await auth.handleCallback(`http://127.0.0.1:1455/auth/callback?code=mock-code&state=${state}&client_id=issued-dynamic-id`);
  assert.equal(result.authenticated, true); assert.equal(result.sharing, true); assert.equal(result.subject, 'subject-test');
  assert.equal(request.url, 'https://auth.openai.com/api/accounts/oauth/token');
  assert.equal(request.body.get('grant_type'), 'authorization_code'); assert.equal(request.body.get('client_id'), 'issued-dynamic-id');
  assert.equal(request.body.get('resource'), 'https://api.openai.com/v1'); assert.equal(request.body.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.equal(auth.status().tokenStorage, 'memory-only'); assert.deepEqual(new Set(auth.status().grantedScopes), new Set(['openid','profile','email','offline_access','resource.invoke','chatgpt.tokens.use.direct'])); assert.ok(await auth.accessToken());
  assert.equal(auth.registration.clientId, 'issued-dynamic-id');
});

test('rejects wrong OAuth state before making token exchange request', async (t) => {
  let calls = 0; const auth = await fixture(t, { fetchImpl: async () => { calls++; throw new Error('must not fetch'); } }); await auth.initialize(); auth.createAuthorization();
  await assert.rejects(auth.handleCallback('http://127.0.0.1:1455/auth/callback?code=x&state=wrong&client_id=client'), { code: 'invalid_state' });
  assert.equal(calls, 0);
});

test('rejects identity-only consent without ChatGPT plan-use scope', async (t) => {
  const auth = await fixture(t, { fetchImpl: async () => Response.json({ access_token:'a', refresh_token:'r', id_token:'id', scope:'openid profile email' }), verifyIdToken: async () => ({ sub:'s' }) }); await auth.initialize();
  const { url } = auth.createAuthorization(); const state = new URL(url).searchParams.get('state');
  await assert.rejects(auth.handleCallback(`http://127.0.0.1:1455/auth/callback?code=c&state=${state}&client_id=issued`), { code:'sharing_scope_missing' });
  assert.equal(auth.status().authenticated, false);
});

test('rotates refresh token and rejects expired/revoked refresh sessions', async (t) => {
  let calls = 0;
  const auth = await fixture(t, { now: () => 10_000_000, fetchImpl: async (_url, init) => { calls++; assert.equal(new URLSearchParams(init.body).get('grant_type'),'refresh_token'); return Response.json({ access_token:'new_access', refresh_token:'new_refresh', expires_in:3600, scope:'chatgpt.tokens.use.direct' }); }, verifyIdToken: async () => ({ sub:'s' }) });
  await auth.initialize(); auth.tokens = { accessToken:'old', refreshToken:'old_r', expiresAt:0 };
  auth.registration.clientId = 'issued'; assert.equal(await auth.accessToken(), 'new_access'); assert.equal(calls,1); assert.equal(auth.tokens.refreshToken,'new_refresh');
});
