# Authorization and terms assessment (v0.4.0)

**Sources checked 2026-10-24.** This is a technical assessment, not legal advice.

## Officially supported personal/local path

OpenAI's official [SIWC Token Sharing for Open Source overview](https://developers.openai.com/siwc/token-sharing-open-source) expressly says its docs cover open-source and locally hosted apps; it directs paid or remotely hosted apps to an interest form. It describes dynamic client registration and the public Responses API. The [sign-in guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) specifies `client_id=dynamic_agent_client` for first registration, `agent_name_hint`, stable `ext_agent_host_id`, loopback callback on `127.0.0.1`, S256 PKCE, the identity plus plan-use scopes, `resource=https://api.openai.com/v1`, issued client ID reuse, ID-token validation and granted-scope check. This code follows that flow.

The official [models and inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) requires `GET /v1/models` for account model discovery and public `POST https://api.openai.com/v1/responses` for inference; explicitly says do not use `chatgpt.com/backend-api` for this flow; every request sets `store:false` and `stream:true`, and success requires `response.completed`. The official [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) lists supported/unsupported fields and tools. [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) requires local or user-controlled token storage and explains refresh rotation.

## Applicable terms clauses

[Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) published 2026-09-29:

- **§1 Application identity and security:** use tokens only through supported sign-in; protect credentials; persistent token storage must be local and under user control, not remote/managed.
- **§2 ChatGPT plan usage:** requests originate from user's local runtime or a remote runtime only that user controls; requests are for authenticated user and their activity/expressly authorized automation; use plan only for connected application; no general-purpose API access for other tools/unrelated requests; no charge to user for plan use through SIWC. Eligibility/usage limits apply.
- **§4 Prohibited activities:** no circumventing limits; no pooling/transfer/resale/share of usage or tokens except permitted handling; do not use one person's subscription for another person's requests.

[Terms of Use](https://openai.com/policies/row-terms-of-use/) effective 2026-01-01 additionally covers account credential sharing and prohibits bypassing service limits/protections.

## Assessment of this build scope

This implementation is a single, no-charge, local app named in the OAuth consent (`Kirana Personal Gateway` by default), binds only to `127.0.0.1`, is intended only for the authenticated owner, holds OAuth tokens in process memory, and has no remote service, third-party consumer, multi-user pool, hosted deployment, or fallback to paid API. These are design constraints based on the user's stated private/personal POC and the official local open-source flow. The caller API key is a local credential for this app, not a plan token; it cannot travel to OpenAI.

The broad original goal of using one gateway as a general endpoint for unrelated apps/users is **not implemented or approved**. This POC supports only local personal testing of the named gateway app. Reusing the gateway for unrelated applications, another user's activity, remote hosting/managed storage, or charging for access requires a separate terms review and potentially OpenAI's hosted-app approval.

## Residual uncertainty

No live OAuth attempt was made in this Arena-managed sandbox. The official documentation supports the method implemented, but real account eligibility, specific consent screen availability, models and limits remain unobserved. A full gateway smoke test must be run by the owner on their own machine; this directly fits the docs' local-runtime design. No claim of real completion is made.
