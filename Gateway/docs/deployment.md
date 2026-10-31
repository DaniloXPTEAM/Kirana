# Local runtime, Windows installation and v0.4.0 upgrade

This gateway is **local-only**. It binds only to `127.0.0.1`, has no CORS, and must not be deployed, tunneled, reverse-proxied, exposed to LAN/public internet, or shared with another user's requests. SIWC is a user-controlled personal-runtime flow; consult current SIWC documentation/terms before any change. OAuth tokens remain memory-only and are cleared at process exit. The local registration file holds non-secret client/host identifiers; media job metadata and files are persisted under `.local-state/<APP_ID>/` with local ACLs and file TTL.

## Windows clean install

1. Install Node.js 20.20+ (Node 22 LTS recommended) from its official distribution.
2. Extract `Kirana-ChatGPT-Gateway-v0.4.0-Windows.zip` to a user-owned folder outside OneDrive/shared/public folders if possible.
3. Open PowerShell in the extracted project and run:

```powershell
.\windows\Setup.ps1
npm run keygen
notepad .env
.\windows\Start.ps1
```

Set only the generated local client key in `GATEWAY_API_KEY`; keep `HOST=127.0.0.1`. Start `http://127.0.0.1:1455/auth/start` in the owner's local browser and explicitly review the consent. There is no background service, port forwarding, TLS listener or cloud deployment.

Optional external/local executables and models are separate from this source ZIP. Read [`provider-candidates.md`](provider-candidates.md) and the exact license/install instructions before use. Do not install/download large weights until the target PC's hardware/disk has been assessed. Set provider executable/model/workflow paths in `.env` only after local installation. ComfyUI and its custom nodes/workflows must remain loopback/user-controlled.

## Safe upgrade from v0.3.x

1. Stop the old gateway. Do not run two copies against one port or the same local state directory.
2. Make a private backup of `.env` and `.local-state/<APP_ID>/`. This backup contains local identifiers and potentially user files; do not share or commit it.
3. Extract v0.4.0 into a **new versioned folder**. Do not overwrite the old project yet; preserve it for rollback.
4. Copy only the existing `.env` into the new folder, or merge values manually into the new `.env.example`. Preserve the exact `APP_ID`, `APP_NAME`, `PORT`, `GATEWAY_API_KEY`, file settings and any already configured paths. Do not copy a new sample key over the existing key.
5. Copy `.local-state/<APP_ID>/` into the new folder only if the user intentionally wants to preserve SIWC registration ID, job metadata and temporary files; preserve its directory name and OS user/ACLs. OAuth tokens are not in this folder and must be reauthorized after restart.
6. Run `npm ci`, `npm test`, `npm run check`, and then `npm start`. Verify `GET /health`, `GET /v1/capabilities` and an authenticated `GET /v1/files/formats` before performing any model/provider operation.
7. Keep the old folder and backup until the v0.4.0 runtime is accepted. Do not delete old job/file state before confirming needed outputs were downloaded; file TTL remains in effect.

There is no automated database migration. The file index and job journal are versioned JSON and load local metadata; current startup restores file metadata, expires old files, and marks queued/running jobs `interrupted` rather than resuming them. If an index is corrupt, stop the process and retain a backup before troubleshooting. Do not copy `.local-state` to cloud or another user's machine.

## Rollback

Stop v0.4.0 and restart the preserved v0.3.x folder with its original `.env` and state copy. Never overwrite a newer state folder with an older app while it is running. Restore only user-reviewed backups; `.env` remains private. An interrupted job is not resumable and output files may expire independently of job records.

## Operations and resource limits

The default file quota is 10 MiB per file, 50 MiB total, 50 files, 1-hour TTL. For local video clips, `FILE_MAX_BYTES` may be increased up to 250 MiB and `FILE_MAX_TOTAL_BYTES` up to 2 GiB, but available disk, temporary working space, privacy and cleanup must be considered. Video analysis defaults to 180 seconds, max 12 keyframes; local models/jobs can use substantial RAM/VRAM. Jobs are serialized (one concurrent job, ten queued) and kept up to 24 hours/200 records. No auto-resume, model download, hosted fallback or service install occurs.

Rotate the gateway client key with `npm run keygen` only when desired; replacing it requires updating local clients. It is distinct from ChatGPT OAuth. Logs contain route, status, model label and timing only; do not enable request-body logging.
