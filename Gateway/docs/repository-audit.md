# Repositório auditado e arquitetura escolhida

## Original repositório (continued from previous turn)

- `https://github.com/opencoredev/login-with-chatgpt`
- Audited commit: `a1330697f35a1c6429009953acc8ec3e2f9f1f1c`, version manifests 0.2.0, MIT.
- Its core/server/react/ai packages implement a Codex CLI-style device flow, token refresh/session handler, model proxy, Codex Responses stream and Vercel AI SDK adapter. In that audited commit, default OAuth client ID is Codex CLI public ID, default scope `openid profile email offline_access`, and default inference base is `https://chatgpt.com/backend-api/codex`.
- The repository's own core config describes that endpoint as the Codex model API base; its Realtime voice is described as unsupported/private experimental transport.
- Its previous 100-test suite passed and builds/typecheck passed (recorded in prior audit; not rerun in this continuation).

## Why v0.2.0 does not call that transport

OpenAI's current official SIWC docs, cited in `terms-assessment.md`, state that the documented ChatGPT plan-use flow calls public `api.openai.com/v1/responses` and specifically says not to direct it to ChatGPT `backend-api`. Therefore this gateway preserves the user's requested API goals but replaces the upstream authentication/transport adapter with the official dynamic SIWC flow and public Responses protocol. No code from the original repo has been modified or copied into this independently authored gateway; the original audited repo remains in the project history/evidence.

## v0.2.0 architecture

- Node ESM gateway using built-in HTTP/fetch and `jose` for OIDC ID-token verification against OpenAI JWKS.
- One user-controlled local runtime, loopback only.
- `src/auth.js`: first-time dynamic client registration, host ID, state, nonce, S256 PKCE, code exchange, scope gate, JWKS validation, in-memory access/refresh credentials and serialized rotating refresh.
- `src/responses.js`: public account model catalog filter, Responses request with required `store:false`/`stream:true`, SSE parser, Chat Completions subset serializer, namespace function tool conversion and stream adapter.
- `src/gateway.js`: local key auth, health/models/chat routes, request size guard, rate limit, cancellation/timeouts and safe logs.
- `src/main.js`: local runner and minimal `.env` loader; `src/keygen.js`: crypto key generator.
- `.local-state` persists only host ID and issued OAuth client ID; OAuth tokens are memory-only.

The original AI SDK integration is not reused because its request/transport expectations are tied to the old Codex endpoint. v0.2.0 uses OpenAI's public Responses endpoint under the explicit `chatgpt.tokens.use.direct` grant. See the independent test fixtures/results in `docs/test-results.md`.
