# Gateway v0.4.0 — capabilities and local file API

This document covers the capability catalog and temporary file handling retained from v0.3.0. Multimodal operation contracts for stages 3–6 are in [`media-api.md`](media-api.md).

## Authentication and safety boundary

The gateway remains restricted to `127.0.0.1`. All routes below require the gateway's local bearer key. Do not expose the port, key, or temporary-file endpoints to the LAN, a tunnel, or a public service. `GATEWAY_API_KEY` is separate from ChatGPT OAuth credentials.

File bodies are limited separately from chat:

- Chat request JSON: 1 MiB.
- File create/upload request JSON: 15 MiB maximum.
- Individual file: 10 MiB by default (`FILE_MAX_BYTES`, allowed 1 KiB–250 MiB).
- Temporary storage: 50 MiB and 50 files by default (`FILE_MAX_TOTAL_BYTES`, max 2 GiB; `FILE_MAX_COUNT`, max 500).
- Expiry: 1 hour by default (`FILE_TTL_SECONDS`, allowed 60 seconds–24 hours).
- The app removes expired files on a periodic cleanup pass, cleans remaining regular files in the dedicated temporary folder at next process startup, and provides explicit deletion. File content is stored locally in plaintext; directory/file permissions are restricted where the OS supports POSIX modes. On Windows, the folder inherits the current user's filesystem ACL. Do not store confidential material unless the local machine/account is appropriately protected.

The gateway never serves files inline: downloads use attachment disposition, `nosniff`, and `no-store`. Filenames cannot contain path separators/control characters. File IDs are random opaque identifiers, but the bearer key is still required for every metadata, download, and delete request.

## Discover capabilities

`GET /v1/capabilities` returns the current operation registry and file limits. Media records distinguish adapter implementation, provider configuration, readiness, and `available` (only after a real successful operation). A mock, configured name, healthy provider, or endpoint alone does not mark a capability available. Optional `KIRANA_*_PROVIDER` fields are informational preferences only; they do not select/enable a different adapter.

`GET /v1/files/formats` lists the supported file formats and limits.

Example (PowerShell):

```powershell
$base = 'http://127.0.0.1:1455'
$headers = @{ Authorization = "Bearer $env:GATEWAY_API_KEY" }
Invoke-RestMethod -Uri "$base/v1/capabilities" -Headers $headers
```

## Create files

`POST /v1/files` accepts JSON. Its `format` is one of `txt`, `md`, `json`, `csv`, `pdf`, `docx`, or `xlsx`. `filename` is optional; if supplied, its extension must match the format.

| Format | Request data | Notes |
|---|---|---|
| TXT, Markdown, PDF, DOCX | `content` string | UTF‑8 source text. PDF uses a built-in standard font; characters outside Windows-1252 may render as `?`. |
| JSON | `content` containing valid JSON text, or `data` containing a JSON value | Output is pretty-printed UTF‑8 JSON. |
| CSV, XLSX | `rows`: array of arrays, or array of objects | Object rows use the union of their keys as columns. XLSX numeric and boolean cells retain those types; text cells are stored as text. |

Example: create and download a Word document:

```powershell
$base = 'http://127.0.0.1:1455'
$headers = @{ Authorization = "Bearer $env:GATEWAY_API_KEY" }
$payload = @{ format = 'docx'; filename = 'nota.docx'; content = "Relatório Kirana`nEtapas 1 e 2 concluídas." } | ConvertTo-Json
$file = Invoke-RestMethod -Uri "$base/v1/files" -Method Post -Headers $headers -ContentType 'application/json' -Body $payload
Invoke-WebRequest -Uri "$base$($file.download_path)" -Headers $headers -OutFile $file.filename
```

Example: create a spreadsheet:

```powershell
$payload = @{ format = 'xlsx'; filename = 'contatos.xlsx'; rows = @(@('Nome','Status'), @('Ana','Ativo'), @('Bruno','Pendente')) } | ConvertTo-Json -Depth 8
$file = Invoke-RestMethod -Uri "$base/v1/files" -Method Post -Headers $headers -ContentType 'application/json' -Body $payload
Invoke-WebRequest -Uri "$base$($file.download_path)" -Headers $headers -OutFile $file.filename
```

`GET /v1/files/{id}` downloads the attachment. `DELETE /v1/files/{id}` removes it early. Responses contain `id`, `filename`, `mime_type`, `size_bytes`, `created_at`, `expires_at`, and a relative `download_path`.

CSV output quotes fields and prefixes potentially formula-leading values (`=`, `+`, `-`, `@`, or leading control/space sequences) with an apostrophe to reduce spreadsheet-formula injection risk. This can change the exact displayed cell text. XLSX string cells are explicitly stored as strings, not formulas.

## Upload to temporary storage

`POST /v1/files/upload` accepts JSON fields `filename`, `mime_type`, and `content_base64`, or raw binary with a supported `Content-Type` and `?filename=...`. It accepts the seven document types listed above plus these media MIME types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/mp4`, `audio/webm`, `video/mp4`, `video/quicktime`, and `video/webm`. The endpoint checks declared MIME against extension, validates text encodings/JSON and basic binary magic signatures, applies size/storage limits, then returns ordinary file metadata and a download path. Media upload is still only storage/transfer; use the modality routes in `media-api.md` for analysis or generation.

Example (PowerShell):

```powershell
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path '.\entrada.txt'))
$payload = @{
  filename = 'entrada.txt'
  mime_type = 'text/plain'
  content_base64 = [Convert]::ToBase64String($bytes)
} | ConvertTo-Json -Compress
$stored = Invoke-RestMethod -Uri "$base/v1/files/upload" -Method Post -Headers $headers -ContentType 'application/json' -Body $payload
Invoke-WebRequest -Uri "$base$($stored.download_path)" -Headers $headers -OutFile '.\baixado.txt'
```

Binary upload example (curl):

```sh
curl -H "Authorization: Bearer $GATEWAY_API_KEY" -H 'Content-Type: video/mp4' \
  --data-binary @clip.mp4 "$GATEWAY_URL/v1/files/upload?filename=clip.mp4"
```

Validation is intentionally not a malware scan, decoder, or deep OOXML validator. Uploaded content is retained only for this local transfer workflow and is not processed by a model. For images/audio/video, only type/extension and basic signature are checked; a successful upload is not proof that media is decodable or supported by an analysis provider.

## Important boundaries

Media routes/adapters are present in v0.4.0, but each remains unavailable until its exact provider is configured, ready and has completed a real successful operation. No hosted paid-provider integration, cloud/object storage, malware scanner, multi-user auth, public access, audio streaming, or temporal video model is provided. See [`media-api.md`](media-api.md) and [`provider-candidates.md`](provider-candidates.md).
