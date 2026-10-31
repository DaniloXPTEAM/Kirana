# Limitations and validation status — v0.4.0

## Implemented adapters and interfaces

- Existing private loopback SIWC flow, public Responses text path, Chat Completions subset and caller-executed function-tool contract are preserved.
- Local file create/upload/download/delete, quotas, TTL, signature checks and temporary storage are retained.
- Vision input conversion and `/v1/images/analyze`; image generation/edit through local ComfyUI workflow adapter; video keyframe analysis through FFmpeg+SIWC with optional Whisper transcription; ComfyUI local video generation; Whisper.cpp transcription; Piper WAV TTS; persistent async jobs/status/progress/cancel are implemented in code.
- New validation covers multimodal input signatures/size/MIME, provider configuration, local-only ComfyUI URL, workflow input bindings, sanitized job metadata, persistence/interruption and no false availability from mocks.

## Not validated with real engines/accounts

There was no real SIWC consent, model call, ComfyUI/FFmpeg/Whisper.cpp/Piper install or operation, Windows run, GPU/hardware measurement, quality/latency benchmark or media output. Model compatibility, account plan use, license compliance of user-selected weights, workflow/custom-node behavior and Windows executable paths remain unverified. New media capabilities therefore stay unavailable until successful real operation on the user's machine. No paid call, model download or heavy engine installation occurred.

## Semantics and API limits

- Image understanding accepts stored PNG/JPEG/WebP/GIF and requires a currently visible account model selected by the owner. Chat image arrays remain user-only and must pass MIME/signature/size validation.
- Video analysis samples up to 12 scaled frames from a bounded clip; optional Whisper transcript is separate. This is not native temporal video reasoning and may miss unsampled events.
- Image/video generation needs local ComfyUI, an API-format workflow with node bindings, compatible models and possibly custom nodes. The project does not package them.
- Audio endpoints return completed files/text jobs. There is no streaming audio, speech-to-speech, VAD, barge-in or real-time interruption.
- Jobs are serialized, persisted as metadata only, and marked interrupted after restart; they do not resume. Job records can outlive file TTL, so a poll may reference expired output.
- Default upload size is 10 MiB. It can be increased to 250 MiB and total storage to 2 GiB; disk, privacy and local runtime limits remain the owner's responsibility.
- Tests are mocked/local and do not certify OpenAI acceptance, model content quality, hardware suitability or compliance of arbitrary workflow/model packages.

## Explicitly out of scope

Public/remote hosting, third-party/multi-user requests, pooling or transferring plan usage, private OpenAI backend endpoints, automatic model/engine downloads, credential logging, hosted web search/code execution/MCP, direct tool execution, native video model input, streaming audio and real-time interruption. No changes to Kirana or LangGraph nodes were made in the baseline; the gateway contracts are prepared for future caller integration.

## Model routing and fallback (v0.4.1 — limited by design)

The gateway now has a model engine (`src/engine.js`), but it is deliberately narrow:

- Routing is **off by default** (`KIRANA_ROUTING` unset). With it off, behaviour is identical to v0.4.0: the requested model runs, nothing is switched.
- When on, the **primary model is preserved**. Fallback happens only after an eligible infrastructure failure (timeout, connection error, upstream 5xx, plan/rate limit), at most once, and only **before the first byte** reaches the client.
- Account errors (`authentication_required`) and invalid requests never trigger fallback: another model cannot fix a revoked session, and hiding the error would mislead the user.
- **Paid models are blocked** under the default `cost_policy=plan-only` (HTTP 402). `allow-paid` is an explicit, documented opt-in by whoever pays the bill.
- Capability routing (`images.analyze`, `tools`, `coding`, `json`, `reasoning`) only uses a model whose capability is **`tested`** in `config/models.json`. The shipped catalogue is empty on purpose; nothing is claimed without evidence.
- Model identity is reported as five distinct fields (`model_requested`, `model_selected`, `model_used`, `model_reported`, `identity_verified`). `identity_verified` is `true` only when the provider itself declares the model and it matches the request. A mismatch is recorded, never smoothed over.

Still out of scope: multi-provider failover, automatic provider addition, cost-based optimisation, and any claim about real model quality or availability. Verifying real models requires the account owner's SIWC consent; `tools/quality-suite.mjs` is provided for that and refuses to produce results without it.
