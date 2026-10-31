# Kirana ChatGPT Gateway v0.4.0 — multimodal adapters (private localhost)

**Stages 3–6: adapter code and local API contracts are implemented; real provider/model validation is still pending.** Text chat and the v0.3 file workflow are retained. The new vision, image, video and audio routes fail closed unless their required account access or local engines/workflows are configured. The capability catalog separates `implemented`, `configured`, `ready`, and `available`; media `available` only turns true after a real successful operation, never because an endpoint or mock exists. No engine/model was installed or downloaded for this release and no paid or real provider request was made during development.

This is a single-user personal gateway. It binds to `127.0.0.1` only, has no CORS, never exposes an API port publicly, and keeps OAuth access/refresh tokens in process memory. The OpenAI account access is via the documented Sign in with ChatGPT (SIWC) flow and public Responses API; it does not use an API key or private `chatgpt.com/backend-api` endpoints. Read the current [SIWC terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) and official [SIWC documentation](https://developers.openai.com/siwc/token-sharing-open-source) before use.

## Requirements and safe setup

- Node.js 20.20+ (Node 22 LTS recommended) and npm.
- Use the gateway only on the account owner's personal computer/local runtime. Do not deploy it, tunnel it, or expose it to LAN/public internet.
- Review and explicitly consent to the ChatGPT plan-use authorization yourself. Account eligibility, applicable plan limits and SIWC preview limitations still apply.
- Optional local engines (FFmpeg, Whisper.cpp, Piper, ComfyUI and models/workflows) are **not bundled**. Evaluate RAM/VRAM, disk use and licenses before installing; no models are fetched automatically.

```sh
npm ci
cp .env.example .env
npm run keygen
# copy the generated value into GATEWAY_API_KEY in .env; protect the file
npm start
```

Open `http://127.0.0.1:1455/auth/start` in the owner's browser and review/authorize the consent screen. OAuth tokens are memory-only, so signing in again after restart is expected. The gateway's registration metadata and temporary storage live in `.local-state/<APP_ID>/`; do not copy that folder between users.

### Windows / PowerShell

Unzip the release, open PowerShell in the project folder, install Node.js 20.20+ and run:

```powershell
.\windows\Setup.ps1
npm run keygen
notepad .env   # enter GATEWAY_API_KEY; do not share or commit .env
.\windows\Start.ps1
```

`Setup.ps1` preserves an existing `.env`, installs only the locked Node dependency, and runs syntax/tests; it does not install AI engines or weights.

Open the local `/auth/start` URL in the owner's browser. Keep `HOST=127.0.0.1`. The source ZIP does not include large engines, GPU runtimes, model weights, `.env`, OAuth state, or user files. `docs/deployment.md` describes preserving `.env` and `.local-state` on upgrades.

## Existing text and file APIs

- `GET /health` is public and reveals only local service/auth state.
- `GET /v1/models` lists account-visible model slugs after SIWC sign-in.
- `POST /v1/chat/completions` preserves the existing streaming/non-streaming text contract, function-tool handoff (the gateway does not execute tools), and now accepts validated user image parts through documented Responses input where supported by the selected model.
- `GET /v1/capabilities` reports status and file quotas.
- `GET /v1/engine` reports the model engine: routing policy, **observed model identity** and the capability catalogue. Identity is five separate fields (`model_requested`, `model_selected`, `model_used`, `model_reported`, `identity_verified`); `identity_verified` is only `true` when the provider itself declares the same model.
- `GET /v1/runs` and `GET /v1/runs/{id}` list recent executions with decision, attempts, latency, token usage and tool calls (metadata only, ring buffer of 200). See [`docs/engine.md`](docs/engine.md).

Model routing and fallback are **off by default** (`KIRANA_ROUTING=on` enables them); when off, behaviour is identical to v0.4.0. Paid models are blocked under `cost_policy=plan-only` (HTTP 402). `npm run quality:mock` checks the quality harness itself; `npm run quality` needs a real, SIWC-authorised account and refuses to produce results without one. Integration notes: [`docs/tama-integration.md`](docs/tama-integration.md).

To check the engine against a **real** account, run the gateway and then:

```powershell
.\windows\Avaliar-Modelo.ps1
```

It reads your local key, opens the SIWC consent page for you to authorise in your own browser, discovers the real model slug from `/v1/models`, runs the task battery and writes `resultados-qualidade.json` (requested vs. used vs. provider-declared model, latency, tokens). If the provider is not authorised it stops with "not executed" rather than producing a score.
- `GET /v1/files/formats`, `POST /v1/files`, `POST /v1/files/upload`, `GET|DELETE /v1/files/{id}` preserve temporary file creation, upload, download and deletion.

TXT/Markdown/JSON/CSV/PDF/DOCX/XLSX creation and image/audio/video file upload are still local storage operations, not by themselves model processing. JSON file upload is supported for smaller payloads; binary upload is recommended for larger media. Full shapes and PowerShell examples are in [`docs/files-api.md`](docs/files-api.md).

## Multimodal APIs (stages 3–6)

All `/v1/*` routes require `Authorization: Bearer <GATEWAY_API_KEY>`. Upload a file first, retain its opaque `file_id`, then call a modality route. All results are delivered through the gateway's authenticated temporary-file storage and expire under the configured file TTL.

| Stage | Routes | Provider / behavior | Default availability |
|---|---|---|---|
| 3 Vision | `POST /v1/images/analyze` | Uploaded PNG/JPEG/WebP/GIF + selected account-visible model via public SIWC Responses input | Requires sign-in and a compatible model; no successful live test recorded yet |
| 4 Images | `POST /v1/images/generate`, `/v1/images/edit`; poll/cancel `/v1/images/jobs/{id}` | Local ComfyUI API-format workflow | Unavailable until loopback ComfyUI + valid workflow bindings are configured and an operation succeeds |
| 5 Video | `POST /v1/videos/analyze`, `/v1/videos/generate`; poll/cancel `/v1/videos/jobs/{id}` | FFmpeg keyframe sampling + SIWC image analysis; optional Whisper transcription. Generation uses a local ComfyUI workflow | Requires local FFmpeg and SIWC; generation additionally needs ComfyUI workflow; no temporal video model is claimed |
| 6 Audio | `POST /v1/audio/transcriptions` (async); `POST /v1/audio/speech` (WAV) | Local Whisper.cpp + FFmpeg; local Piper voice/model | Unavailable until binaries/models are installed/configured and real operations succeed |

Generic polling/cancellation is also available at `GET|DELETE /v1/jobs/{id}`. Audio transcription jobs return a text file; speech returns a WAV `file_id` and authenticated `download_path`. The Gateway audio routes still do not provide audio/video streaming or realtime duplex. A separate experimental browser voice sample described below streams the existing textual response and synthesizes sentence chunks with Thalita Edge TTS, falling back to browser SpeechSynthesis Francisca when available; it is not an SIWC audio/Realtime provider. Cancellation of local transcription aborts its child process; ComfyUI cancellation is best-effort through its documented local queue/interrupt API.

Request and workflow contracts, file upload examples, queue/status behavior and error cases: [`docs/media-api.md`](docs/media-api.md).

## Optional local engines

Configuration is deliberately opt-in in `.env`; paths must refer to the owner's installed binaries/model files. Defaults do not install packages or download weights:

- `FFMPEG_PATH`, `WHISPER_CPP_PATH`, `WHISPER_MODEL_PATH` for local transcription and video keyframes.
- `PIPER_PATH`, `PIPER_MODEL_PATH`, optional `PIPER_VOICE_ID` for local WAV synthesis. Use a voice model whose license and language you have checked; returned language is inferred conservatively from its configured ID.
- `COMFYUI_BASE_URL=http://127.0.0.1:8188` plus absolute paths to JSON API workflows for image generation/editing and video generation. The ComfyUI API adapter accepts only loopback HTTP and JSON API-format node workflows with explicit input bindings. ComfyUI itself is GPL-3.0; it is not redistributed.
- For clips larger than the default 10 MiB file limit, deliberately increase `FILE_MAX_BYTES` and `FILE_MAX_TOTAL_BYTES` (individual limit up to 250 MiB). Review disk/privacy implications first. Video analysis defaults to at most 180 seconds and samples at most 12 frames.

The candidate comparison, licenses, Windows/GPU notes and official sources are in [`docs/provider-candidates.md`](docs/provider-candidates.md). This project does not provide a hosted “free” image/video/audio inference service. Open model licenses do not mean hosted inference is free; the SIWC plan is account-bound and still governed by account eligibility/limits.

## Experimental browser voice client

The existing local sample now uses browser SpeechRecognition `pt-BR` → unchanged SIWC textual streaming → `edge-tts` with `pt-BR-ThalitaMultilingualNeural`, streaming MP3 through the loopback Node server into the browser where Media Source Extensions support it. Microsoft Francisca SpeechSynthesis is the fallback only when the browser exposes that voice. Text is sanitized for speech only; the displayed answer and SIWC history remain unchanged. Python/`edge-tts` is an optional separate dependency; Gateway `.env`/auth and port 1455 are untouched. The voice interface stays on loopback port 1456 and the module scripts comply with `script-src 'self'`.

**Important service caveat:** `rany2/edge-tts` connects to Microsoft Edge's online Read Aloud service; it is not the supported Azure Speech API and is not a public documented API with SLA. Microsoft says Edge online voices send the text being converted to Microsoft [privacy details](https://learn.microsoft.com/en-us/legal/microsoft-edge/privacy); the project README describes its use of Edge's online TTS [service](https://github.com/rany2/edge-tts). The endpoint may change, reject calls, or have terms/rights that are not publicly clarified; use non-sensitive text and do not assume redistribution rights. No Azure API key or paid provider is configured. The browser client itself remains local, but the local server makes outbound TTS connections. See [`docs/voice-online-implementation.md`](docs/voice-online-implementation.md) for installation, test results, and limitations.

## Status, testing and limitations

```sh
npm test
npm run check
```

The automated suite uses deterministic mocks and synthetic file bytes. It does not execute FFmpeg, Whisper.cpp, Piper, ComfyUI, SIWC authorization or a real model. Separately, this revision did perform real Edge TTS catalogue, MP3 synthesis and Node/Python streaming checks; it did not verify browser playback or Windows audio. No paid inference calls were made. See [`docs/test-results.md`](docs/test-results.md), [`docs/evidence.md`](docs/evidence.md), and [`STATUS.md`](STATUS.md).

This is not a public or multi-user gateway; no credentials are logged, and no usage is pooled. Media jobs persist metadata/progress only; payloads and output files remain in local file storage with TTL. On restart, in-flight jobs become `interrupted`. Cancellation, model availability, provider limits and hardware performance must be verified on the target Windows PC. Realtime duplex audio, raw audio streaming through the Gateway, official cloud TTS/STT integration into SIWC and automatic barge-in remain unsupported. The separate Edge TTS browser sample has live catalogue/audio-stream checks, but its audible browser playback and Windows interruption/fallback are not yet verified.
