# Test results — v0.4.0 (stages 3–6 adapter/API work)

Date: 2026-10-24. Environment: Node v20.20.2, npm 10.8.2, Linux sandbox. No user OAuth credentials, local engines, model weights or paid services were used.

## Executed

- `npm run check`: **passed** syntax checks for gateway, auth/Responses, capability/files/jobs modules, all provider adapters, tests and examples.
- `npm test`: **42 passed, 0 failed**. HTTP and module tests use mock auth/providers/upstream responses and synthetic media bytes. The suite does not contact Edge TTS; live voice check is separately recorded below.
- Existing regression coverage remains: SIWC OAuth request/state/PKCE/scope/rotation tests; text streaming/tool conversion; account model filtering; file creation/upload/download/delete, MIME/signature/CSV quotas/TTL, and loopback/key restrictions.
- New checks include: image input contract maps to public Responses `input_image` with `store:false`/SSE; bad signature rejected before any upstream request; media endpoints return `503 provider_not_configured`; capability catalog distinguishes adapter implementation from availability; mock image job persists/downloads a sample file while remaining unavailable (`live:false`); binary upload authenticity; job persistence/restart interruption; voice-client CSP/external-module delivery, app.js MIME, no executable inline script, cross-origin checks, sanitization, mocked MP3 route and worker abort, and mocked Thalita-to-Francisca routing; `error_code:null` on success.
- No code path in automated tests makes a real OpenAI or provider inference request. Fake model/token labels are synthetic test fixtures only.

## Live Edge TTS checks executed (outside the test suite)

- Installed `edge-tts==7.3.1` in a disposable `/tmp` virtual environment, not in the Gateway installation.
- Ran its live `--list-voices`: exact `pt-BR-ThalitaMultilingualNeural` and `pt-BR-FranciscaNeural` entries returned, both Portuguese (Brazil), Female, GA.
- Generated `/home/user/thalita-teste.mp3` with the user-provided phrase via the `edge-tts` CLI; valid MPEG Layer III, 24 kHz mono, 48 kbps, approximately 38 KB. A separate direct SDK stream produced 47 audio chunks (33,696 bytes); first chunk ~2,249 ms, total ~5,416 ms in this sandbox.
- Exercised the actual Node proxy + Python worker + online service: voice catalog confirmed Thalita, POST returned HTTP 200 `audio/mpeg`, 32,976 bytes; first MP3 byte reached the Node client in ~1,184 ms. That is server-side byte latency, **not first audible playback**.

## Not performed (real account/provider/Windows)

- Real SIWC browser consent, ID-token/JWKS, plan scope or refresh against OpenAI; no live SIWC model response was sent in this voice integration check.
- Playback audibly verified in a real browser/Windows device, Chrome/Edge MSE `audio/mpeg` decode, physical cancellation, real Francisca fallback voice, or end-to-end first-audible latency.
- Any real `/v1/models`, chat, image analysis, image generation/edit, video analysis/generation, Whisper transcription, or Piper synthesis request.
- FFmpeg, Whisper.cpp, Piper or ComfyUI installation/execution; GPU/VRAM measurement; Windows PowerShell execution.
- Paid request, model/engine download, package installation of heavy tools, timing/quality benchmark or license compliance audit for a chosen binary/model/workflow.
- Real output file from any media model. Job output tests use synthetic signature bytes; they prove route/storage/poll semantics only.

## Interpretation

Tests establish local API/adapter contracts, validation, error/status behavior and regressions under mocks; they do **not** prove account/model compatibility, provider readiness, output quality, hardware fit or availability. Media capability records remain unavailable until a real operation succeeds with the user's explicitly configured engine/account, and the local models must pass the target system's own tests. No authorization or claims for paid calls are implied.
