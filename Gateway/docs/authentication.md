# Authentication test procedure (owner-local, explicit consent)

The former repo flow (`Login with ChatGPT` at the audited commit) uses public Codex CLI OAuth details and defaults to `chatgpt.com/backend-api/codex`. Current official SIWC open-source instructions instead specify dynamic agent registration, `chatgpt.tokens.use.direct` and the public `https://api.openai.com/v1` Responses endpoint. This implementation follows the latter documented route.

## Exact local procedure

1. On the owner's personal machine, run `npm install`, create `.env` using README, generate own gateway client key (`npm run keygen`), and `npm start`. Never run this OAuth step in an Arena-managed runtime or public server.
2. Open `http://127.0.0.1:1455/auth/start` yourself. The gateway shows the app identity and scope purpose before redirecting.
3. OpenAI login is completed on the official OpenAI site. Inspect the named application and requested plan-use scope; proceed only if you authorize them. The gateway does not request passwords/cookies.
4. Browser redirects to the local callback. The callback validates `state`, exchanges PKCE code using the returned issued client ID, validates the OIDC ID token via OpenAI JWKS (issuer, audience, nonce), and verifies `chatgpt.tokens.use.direct` is among granted scopes. Only then is the in-memory session enabled.
5. Confirm `GET /health` reports `authenticated:true`; with the local Gateway bearer, `GET /auth/status` reports `grantedScopes` (names only; no credentials), and `/v1/models` lists account-visible models. Save no output containing tokens.
6. Send a low-cost test prompt with the account model slug, `store:false` is enforced upstream and `stream:true` is mandatory upstream. Confirm terminal SSE completion and record first useful delta and total time. Run 10 trials per benchmark class only if the user explicitly wishes to spend plan usage.
7. For function tools, submit only a harmless simulated `consultar_status_projeto` declaration. The model's function call is returned to client; gateway does not execute it. Validate request schema/output and subsequent tool result message.
8. Stop with Ctrl-C to clear all tokens from memory. To revoke the renewable session, use ChatGPT Settings → Usage/connected app management; this POC does not persist a refresh token for automatic revocation after process exit.

No one should paste credentials, authorization codes, cookies, or token values in chat. The current workspace only contains test fixtures and source.

## Protocol implemented

- Authorization: `https://auth.openai.com/api/accounts/authorize`
- Token: `https://auth.openai.com/api/accounts/oauth/token`
- JWKS: `https://auth.openai.com/.well-known/jwks.json`
- First registration: `client_id=dynamic_agent_client`, stable `agent_name_hint`, stable UUIDv4 `ext_agent_host_id`.
- Scopes: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`.
- Resource audience: `https://api.openai.com/v1`.
- Loopback redirect: `http://127.0.0.1:1455/auth/callback`.
- S256 PKCE; fresh state and OIDC nonce per attempt.
- Inference: `GET /v1/models`; `POST /v1/responses` with OAuth bearer token, `store:false`, `stream:true`; only `response.completed` indicates success.

See OpenAI official docs: [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source), [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
