# Evidence and official source references — v0.4.0

## SIWC source facts (prior audit and current implementation)

- Overview: https://developers.openai.com/siwc/token-sharing-open-source — applies to open-source/locally hosted apps; paid/remote apps should consult OpenAI interest/approval path.
- Registration/sign-in: https://developers.openai.com/siwc/token-sharing-open-source/sign-in — dynamic first registration, stable agent name/host ID, loopback callback, S256 PKCE, state, nonce, authorization-code exchange and scope validation.
- Models/inference: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference — current account model catalog and public `/v1/responses`; `store:false`, `stream:true`; avoid private `chatgpt.com/backend-api` endpoints.
- Accounts/sessions: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions — local/user-controlled credential handling, refresh rotation and revocation.
- Preview limitations: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations — supported input/tools and limitations evolve.
- SIWC terms: https://openai.com/policies/sign-in-with-chatgpt-terms/ — application security, user control, plan-use and restrictions.

## Official sources used for local media candidates (2026-10-24)

- ComfyUI documented server routes: https://docs.comfy.org/development/comfyui-server/comms_routes — `/prompt`, `/history`, `/view`, upload, queue/interrupt.
- ComfyUI license: https://github.com/Comfy-Org/ComfyUI/blob/master/LICENSE — GPL-3.0; not redistributed.
- Wan2.1 model/code repository: https://github.com/Wan-Video/Wan2.1 — Apache-2.0 stated by upstream; model revisions/workflow dependencies still need separate checking.
- ComfyUI Wan guide: https://docs.comfy.org/tutorials/video/wan/wan-video — local workflow integration and resource notes; not a target-PC benchmark.
- FFmpeg legal notes: https://www.ffmpeg.org/legal.html — LGPL-2.1-or-later default; optional GPL components can alter distribution obligations.
- whisper.cpp: https://github.com/ggml-org/whisper.cpp — MIT, Windows support, multilingual model choices and approximate model download/RAM table; no target-PC benchmark.
- OpenAI Whisper: https://github.com/openai/whisper — MIT code and weights per official repository.
- Piper engine: https://github.com/OHF-Voice/piper1-gpl — GPL-3.0; voice/model license is independent.
- Piper pt_BR Cadu medium card: https://huggingface.co/rhasspy/piper-voices/blob/main/pt/pt_BR/cadu/medium/MODEL_CARD — Brazilian Portuguese candidate, 22,050 Hz, dataset CC0 statement; not blanket proof of model artifact rights.
- Piper pt_BR Jeff medium card: https://huggingface.co/rhasspy/piper-voices/blob/main/pt/pt_BR/jeff/medium/MODEL_CARD — alternative card; check exact model terms before distribution.

Candidate interpretation, Windows/hardware notes and license caveats are collected in [`provider-candidates.md`](provider-candidates.md). Open weights do not imply free hosted inference; SIWC is account-bound with eligibility/limits; no paid provider is configured.

## Executed in v0.4.0 continuation

Environment: Linux sandbox, Node v20.20.2, npm 10.8.2. `npm run check` passed; `npm test` passed 32/32 on 2026-10-24. All upstream/provider test clients are fabricated mocks; synthetic media bytes are only for file/API contract tests. No OAuth/browser sign-in, real model request, paid inference, media engine install, model download or Windows test occurred. See [`test-results.md`](test-results.md).

## Credential hygiene

No `.env`, gateway key, authorization code, cookie, OAuth access/refresh token, account identifier or session data was included. Mock tokens in tests are fabricated fixtures. No real user prompt/media was submitted upstream.
