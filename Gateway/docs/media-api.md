# Multimodal API contracts (v0.4.0)

All examples use loopback and assume the owner has already consented to SIWC. Every `/v1/*` route requires `Authorization: Bearer $GATEWAY_API_KEY`. Never expose the gateway or local ComfyUI, and do not put credentials in URLs. Requests use the existing temporary file store/TTL/quotas and authenticated downloads. Default max file size is 10 MiB; increase `FILE_MAX_BYTES` intentionally (up to 250 MiB) for local clips.

## Upload first

Binary upload avoids base64 expansion and is recommended for images/audio/video:

```sh
curl -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H 'Content-Type: image/png' --data-binary @photo.png \
  "$GATEWAY_URL/v1/files/upload?filename=photo.png"
```

Windows PowerShell (`Invoke-RestMethod` can buffer the body; for very large files prefer a client using raw HTTP streaming):

```powershell
$bytes = [IO.File]::ReadAllBytes((Resolve-Path '.\\clip.mp4'))
$file = Invoke-RestMethod -Method Post -Uri "$base/v1/files/upload?filename=clip.mp4" `
  -Headers $headers -ContentType 'video/mp4' -Body $bytes
$file.id
```

Small JSON/base64 uploads remain supported as `{ "filename":"photo.png", "mime_type":"image/png", "content_base64":"..." }`. The store validates allowlisted MIME, extension, size, and basic binary signatures. An uploaded media file is stored only; it does not mean its capability is enabled.

## Stage 3 — image analysis

`POST /v1/images/analyze` (synchronous, streamed upstream internally):

```json
{
  "model": "account-visible-model-slug",
  "prompt": "Descreva o que aparece, sem inferir detalhes não visíveis.",
  "file_ids": ["<opaque 32-character id>"]
}
```

- Accepts 1–10 stored PNG/JPEG/WebP/GIF files, total input up to 10 MiB. The model must appear in the account's current `GET /v1/models` list and support image input.
- The adapter submits data URLs as `input_image` content to the public Responses API, `store:false`, `stream:true`, and requires a completed response. It does not use private ChatGPT backend routes or download arbitrary remote URLs.
- Successful SIWC analysis can mark `images.analyze.available=true` for this process. A mock, configuration, or an endpoint alone cannot.
- Chat Completions user messages also accept validated `image_url` parts for public HTTPS URLs or base64 image data URLs; only user messages can include image arrays. Existing text-only limit remains 1 MiB; multimodal chat requests are capped at 15 MiB total JSON.

## Stage 4 — image generation/editing

`POST /v1/images/generate`:

```json
{"prompt":"Uma ilustração editorial de jangadas ao amanhecer, sem texto"}
```

`POST /v1/images/edit`:

```json
{"prompt":"Converta para estilo aquarela mantendo a composição.","file_id":"<stored image id>"}
```

These return `202` with a job snapshot and `poll_path` (e.g. `/v1/images/jobs/{id}`). Poll `GET /v1/images/jobs/{id}`; cancel with `DELETE /v1/images/jobs/{id}`. Success includes `output_files`, each with an authenticated `download_path` and file TTL. Edit input is capped at 10 MiB.

Configuration requires loopback ComfyUI plus `COMFYUI_IMAGE_GENERATE_WORKFLOW` and/or `COMFYUI_IMAGE_EDIT_WORKFLOW` pointing to absolute JSON API workflow files. A workflow wrapper can be:

```json
{
  "workflow": { "1": { "class_type":"CLIPTextEncode", "inputs": { "text":"", "clip":["4",0] } } },
  "bindings": {
    "prompt": [{"node":"1","field":"text"}],
    "input_image": [{"node":"7","field":"image"}],
    "duration": [{"node":"12","field":"length"}],
    "seed": [{"node":"3","field":"seed"}]
  },
  "output_nodes": ["9"]
}
```

This is a shape example, **not a working workflow**: node IDs, node classes, input names and outputs must match the installed ComfyUI/custom nodes. Image generation needs `bindings.prompt`; editing also needs `bindings.input_image`. Workflows are API-format node maps (not UI workflow exports). Never trust workflow JSON from an untrusted source. Configure only the fields needed for that operation. The adapter uploads edit images to ComfyUI's local input route, submits `/prompt`, polls `/history`, fetches supported output types, then imports bytes into the gateway file store.

## Stage 5 — video analysis/generation

`POST /v1/videos/analyze`:

```json
{
  "file_id":"<stored video id>",
  "model":"account-visible-vision-model",
  "prompt":"Resuma as ações observáveis e transcreva o que for possível.",
  "frame_interval_seconds":3,
  "max_frames":8
}
```

Returns `202`; poll/cancel via `/v1/videos/jobs/{id}`. On success, `result_file` is a JSON report in gateway storage. Accepted video MIME types are MP4/MOV/WebM. The local FFmpeg adapter samples at most 12 scaled JPEG keyframes from the first `VIDEO_ANALYSIS_MAX_SECONDS` seconds (default 180), then analyzes ordered stills with SIWC image input. Optional Whisper.cpp transcribes audio separately. This is **not native temporal video reasoning**: unsampled intervals are unknown; missing/unreadable audio is reported separately. Frame interval is 1–30 seconds. The total frames sent to vision are capped at 10 MiB.

`POST /v1/videos/generate`:

```json
{"prompt":"A short, calm coastal landscape shot","duration_seconds":5}
```

Returns `202`; poll/cancel via `/v1/videos/jobs/{id}`. Duration is 1–30 seconds, but the selected workflow/model may impose a lower limit. Configure `COMFYUI_VIDEO_GENERATE_WORKFLOW`; it must provide `bindings.prompt` and `bindings.duration` and produce a supported downloadable video. Output bytes are stored locally. No cloud video service or hosted model is configured.

## Stage 6 — speech/audio

`POST /v1/audio/transcriptions`:

```json
{"file_id":"<stored audio id>","language":"pt-BR"}
```

Returns `202`; poll `GET /v1/jobs/{id}`. A successful job provides a `.txt` transcript in `output_files`. `language` defaults to Portuguese (`pt`); `auto` is permitted. The Whisper.cpp adapter requires local `WHISPER_CPP_PATH`, multilingual `WHISPER_MODEL_PATH`, and `FFMPEG_PATH`.

`POST /v1/audio/speech` (synchronous, completed file; only WAV response currently):

```json
{"input":"Olá! Esta é uma amostra de voz local.","voice":"pt_BR-cadu-medium","response_format":"wav"}
```

Returns metadata plus `download_path`; download bytes as `audio/wav`. `voice` is optional and, if supplied, must match the configured Piper model/`PIPER_VOICE_ID`. The model file and its license are user-managed; the engine does not select/download a voice automatically. The gateway does not guarantee this voice is installed. No MP3/streamed output or real-time interruption is implemented.

## Jobs, state and errors

- Generic routes: `GET /v1/jobs/{id}`, `DELETE /v1/jobs/{id}`. Modality-scoped image/video paths enforce matching job types.
- Job state (`queued`, `running`, `succeeded`, `failed`, `cancel_requested`, `cancelled`, `interrupted`), stage, percent progress, provider job ID and opaque output references are persisted under `.local-state/<APP_ID>/jobs/jobs.json`. No prompts, audio/video bytes, authorization headers or tokens are stored in job records. Input/output payload bytes remain in the file store.
- Queue defaults: one local media job at a time, up to ten queued. Jobs are retained up to 24 hours/200 records. In-flight work becomes `interrupted` after process restart; it is not silently resumed. Output/input files still expire under file TTL/quota policy, so an old job can reference an expired file.
- `error_code` is a sanitized code, `null` when there was no error. Error text and upstream tokens are not logged or persisted.
- API errors include `provider_not_configured`, `unsupported_media_type`, `file_not_found`, `invalid_*`, `job_queue_full`, `provider_*`, and `cancelled`. Capability state distinguishes implementation, configuration, runtime readiness and successful real verification.

## Not implemented

Streaming audio, speech-to-speech, voice activity detection, barge-in/real-time interruption, native video model input, automatic model installation/downloading, paid API fallback, and automatic cross-provider switching are not supported in v0.4.0. Do not infer them from future-facing interfaces or job endpoints.
