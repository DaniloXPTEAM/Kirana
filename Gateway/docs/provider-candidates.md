# Provider candidates and deployment/licensing notes (v0.4.0)

**Reviewed 2026-10-24.** Technical summary, not legal advice or a performance claim. The gateway contains adapters only; no provider engine, model, weights, workflow or custom node was downloaded, installed, invoked or redistributed in this work. Windows hardware is unknown, so no fit is presumed. Check each model card and current upstream terms before installing or distributing anything.

## Decision summary

| Capability | Candidate selected in code | Why / cost model | Main constraint / current proof |
|---|---|---|---|
| Image understanding | SIWC public Responses API with account-visible vision model | Uses already-authorized account flow; not a separate paid API credential or private endpoint | Must have consent, eligible model and plan allowance. No real model run performed; capability starts unavailable. |
| Image create/edit | ComfyUI loopback API with user-selected local workflow/model | Provider-swappable workflow layer, local inference, no per-request hosted inference fee | GPU/RAM/disk and custom-node/workflow constraints vary substantially; ComfyUI is GPL-3.0. No workflow or model included/tested. |
| Video understanding | FFmpeg keyframes + SIWC image understanding; optional Whisper.cpp audio transcript | Reuses image and local audio paths; bounded frame count/runtime | Not native video/temporal reasoning. Requires FFmpeg, an account-visible vision model; optional local speech engine. No actual clip run. |
| Video create | ComfyUI local video workflow, e.g. an owner-built Wan workflow | No hosted inference billing, replaceable through workflow config | High resource/VRAM and long runtime; model and workflow licenses differ. Not installed or tested. |
| Speech-to-text | Whisper.cpp + FFmpeg local | MIT code, CPU-capable model selection, multilingual checkpoints suitable for Portuguese | Speed/quality depend on CPU/GPU, model size and audio; no pt-BR benchmark on target PC. Not installed or tested. |
| Text-to-speech | Piper local + a licensed voice model | No hosted per-character bill; the model can be chosen by the owner | GPL-3.0 engine; voice/model licenses are independent. The Cadu voice is a pt-BR candidate; generated quality not listened to or benchmarked. |

### Hosted inference is not “free because the code is open source”

- **SIWC plan use:** is an account-bound permission path with explicit user consent, account eligibility and applicable limits/allowances. It is not a generic free inference API or transferable credit pool. The gateway makes no request unless the owner signs in and calls a route. No fallback to OpenAI API billing is implemented.
- **Local open weights:** may avoid hosted inference charges, but still incur GPU/CPU, electricity, storage/download, model-license and operational costs. Different weights can have different commercial/redistribution terms from their inference software.
- **Hosted providers:** none are configured by default. Introducing one would require explicit user approval, provider terms/key management and cost limits; no such calls were made.

## Detailed candidates and source notes

### Vision through SIWC

The official [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), and [SIWC terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) describe a local/open-source account-sharing flow, visible account model catalog, public `/v1/responses`, consent/scope and user/plan limits. The image adapter accepts a model slug from current `/v1/models`, transmits validated image bytes as `input_image` data URLs and refuses unlisted models. It does not assume every account model supports vision; an actual successful operation is required to mark available. Cost is governed by the user's account/plan and current limits, not this app's API key. No account authorization or image request was performed here.

### Image/video generation through ComfyUI and candidate Wan2.1

[ComfyUI's official API route documentation](https://docs.comfy.org/development/comfyui-server/comms_routes) documents local `/prompt`, `/history`, `/view`, upload and queue/interrupt routes used by the adapter. The [official ComfyUI repository license](https://github.com/Comfy-Org/ComfyUI/blob/master/LICENSE) is GPL-3.0. It is not copied into this release. ComfyUI custom nodes, workflows and model weights each need their own review; a workflow file is executable configuration in the sense that it can invoke installed nodes, so only use sources you trust.

[Wan2.1 official repository](https://github.com/Wan-Video/Wan2.1) identifies its model/code license as Apache-2.0 and supports local video-generation workflows; [ComfyUI's Wan video guide](https://docs.comfy.org/tutorials/video/wan/wan-video) shows integration. A small 1.3B T2V configuration is reported around 8 GB of VRAM in the official project material, but resolution, quantization, offloading, precision and workflow/custom nodes change actual memory needs. This is a planning indicator, not a Windows guarantee or a measurement in this project. Larger models require substantially more resources. Wan weights were not downloaded; no GPU was benchmarked. Local ComfyUI cost is hardware/electricity/storage, not a provider inference fee; downloading model weights uses disk/network and remains subject to model terms.

This adapter therefore requires an owner-configured API-format workflow JSON, and the capability remains unavailable until the loopback backend and a real generation succeed. For video it validates/downloads video outputs through gateway storage. It does not claim every Comfy workflow or checkpoint is compatible.

### Video analysis: FFmpeg + still frames + optional transcript

The [FFmpeg legal page](https://www.ffmpeg.org/legal.html) states FFmpeg is LGPL-2.1-or-later by default, while optional GPL components can change obligations for a build. Windows FFmpeg distributions vary; inspect the exact build and comply with its license before redistribution. The gateway does not bundle FFmpeg. `FFMPEG_PATH` points to the owner's existing executable.

The adapter extracts a bounded number of still frames locally, sends them through the vision path, and optionally extracts normalized audio for Whisper.cpp. This is sampled-frame analysis, not native temporal video understanding: motion and events between sampled timestamps may be missed. CPU-only FFmpeg can be sufficient for basic decoding but runtime depends on codec, clip length, scaling and hardware; GPU decode is not assumed. Storage and upload quotas apply. No frame extraction or video request was executed in this work.

### Audio transcription: Whisper.cpp

The [whisper.cpp official repository](https://github.com/ggml-org/whisper.cpp) documents Windows support, MIT license, CPU and optional acceleration backends, and multilingual model variants (non-`.en` variants). The official model table lists approximate downloads/RAM such as `tiny` (~75 MiB/~273 MB) and `base` (~142 MiB/~388 MB); exact RAM depends on execution/build. Larger models generally trade resource use and latency for recognition capacity; the source does not establish a pt-BR benchmark for this user's PC. [OpenAI Whisper's official repository](https://github.com/openai/whisper) labels code and model weights MIT. Still check the exact checkpoint source/version. These are local inference components, not a hosted free transcription API.

The adapter uses FFmpeg to normalize to mono 16 kHz WAV before running Whisper.cpp. `WHISPER_MODEL_PATH` must point to a multilingual model for Portuguese. pt-BR quality depends on model, accent, noise, microphone and runtime; no real audio, latency or accuracy was measured.

### Speech synthesis: Piper and pt-BR voice candidate

The current [Open Home Foundation Piper repository](https://github.com/OHF-Voice/piper1-gpl) is GPL-3.0. Piper's executable license does not automatically govern each voice. The [pt_BR-cadu-medium model card](https://huggingface.co/rhasspy/piper-voices/blob/main/pt/pt_BR/cadu/medium/MODEL_CARD) identifies a Brazilian Portuguese candidate at 22,050 Hz and declares the dataset CC0; this dataset statement is not, by itself, proof that every distributed model artifact is unrestricted. Review the exact model card/weights license and attribution conditions before use/redistribution. The [pt_BR-jeff-medium card](https://huggingface.co/rhasspy/piper-voices/blob/main/pt/pt_BR/jeff/medium/MODEL_CARD) is another candidate, also with its own model-card terms.

Piper is local and can run on CPU in typical configurations, but this project has no measured realtime factor, memory or listening evaluation on the target system. The current endpoint writes WAV; it does not stream audio or implement interruption. A model download is not bundled or performed.

## Windows-specific practical checks before enabling

1. Check Windows version, CPU, RAM, available disk and (if local video generation is desired) GPU model/VRAM and driver compatibility. Reserve additional disk for model weights, workflow dependencies, temporary input/output and logs.
2. Install only the tool required for the intended route. Verify executable provenance/hash and official release channel; do not run untrusted custom nodes/workflows.
3. Record the exact model ID/revision, source and license. Check whether model redistribution or commercial use is allowed independently of the engine license.
4. Configure absolute local paths in `.env`; leave the API bind at `127.0.0.1`; keep ComfyUI on loopback and do not expose its port.
5. Start with small, non-sensitive sample media, monitor RAM/VRAM/time/temporary disk, and inspect the capability catalog. Run a real provider test only with the owner's explicit approval and account authorization.
6. Increase gateway upload/storage limits only after considering local disk capacity and file TTL. No automated cleanup of third-party model caches is provided.

## Official references

- SIWC overview: https://developers.openai.com/siwc/token-sharing-open-source
- SIWC inference/model catalog: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- SIWC preview limitations: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- SIWC Terms: https://openai.com/policies/sign-in-with-chatgpt-terms/
- ComfyUI server routes: https://docs.comfy.org/development/comfyui-server/comms_routes
- ComfyUI license: https://github.com/Comfy-Org/ComfyUI/blob/master/LICENSE
- Wan2.1 official repository: https://github.com/Wan-Video/Wan2.1
- ComfyUI Wan video guide: https://docs.comfy.org/tutorials/video/wan/wan-video
- FFmpeg legal/licensing: https://www.ffmpeg.org/legal.html
- whisper.cpp repository: https://github.com/ggml-org/whisper.cpp
- OpenAI Whisper repository: https://github.com/openai/whisper
- Piper official repository: https://github.com/OHF-Voice/piper1-gpl
- Piper Cadu pt-BR medium card: https://huggingface.co/rhasspy/piper-voices/blob/main/pt/pt_BR/cadu/medium/MODEL_CARD
- Piper Jeff pt-BR medium card: https://huggingface.co/rhasspy/piper-voices/blob/main/pt/pt_BR/jeff/medium/MODEL_CARD
