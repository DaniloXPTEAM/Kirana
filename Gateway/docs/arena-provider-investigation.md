# Arena / Gemini / Agnes / SIWC investigation

Date checked: 2026-10-24. **No credentials were used, no generation was submitted, and no undocumented endpoint was called.** This records the supported/public surface found for the requested gateway proof.

## Findings

### Arena.ai product vs. Arena API

Arena.ai's official help describes Image Arena generation as **Battle Mode**: a prompt yields two anonymous model generations for comparison/voting. That is a consumer evaluation workflow; the help page does not document a developer REST/SDK/MCP method to request a single generation and retrieve its image bytes. [Image Generation in Battle Mode](https://help.arena.ai/articles/1626988163-arena-how-to-use-image-generation)

Arena does have an official **Arena API** with API keys, usage/billing and integrations. The public setup docs currently demonstrate `coding-router-preview` through Claude Code/Claude Desktop Code/OpenCode. The OpenCode example declares input modalities `text` and `image`, but output modality **`text`**; the Windows instructions say free-router accounts support named interactive clients and list other harnesses such as `curl` as restricted. That is not a documented image-output contract for a custom Gateway adapter. [Arena API Claude Code docs](https://platform.arena.ai/docs/claude-code) · [OpenCode docs](https://portal.api.preview.arena.ai/docs/opencode) · [Windows / supported harness notes](https://portal.api.preview.arena.ai/docs/windows)

**Conclusion:** there is an official Arena API for a subset of text/coding models, but the publicly documented contract found does not support the requested `prompt → generated image bytes` flow. The website has image generation, but its documented Battle Mode is not a public developer endpoint. A general API key or OpenAI-compatible text endpoint is not enough to assume image generation is supported.

Arena's official help also describes daily usage credits and limits; account status/credits must be checked in the UI. Do not infer that every image request is free or that Battle Mode quota can be consumed by an unsupported custom client. [Arena credit system](https://help.arena.ai/articles/5476762589-credit-sytem)

### `reverse-api-engineer`

No `reverse-api-engineer` tool, Arena browser/session connector, or authorized capture facility is exposed in this conversation. I therefore did not inspect network calls, replay cookies/session tokens, or invoke private/undocumented Arena endpoints. That would not establish a supported integration contract and could bypass the service's documented harness restrictions. No Arena key/cookie/token should be pasted into chat.

### Gemini

Arena's public image leaderboard includes Gemini image models, which shows availability in Arena evaluations—not that the Arena API exposes those image models or their image bytes to third-party gateways. [Arena Text-to-Image leaderboard](https://arena.ai/leaderboard/image/text-to-image)

Google separately documents a **Gemini Developer API** for native image generation (Nano Banana models) that returns image data. This is a separate provider, requires a Google API key, and is not SIWC. Google's current pricing page lists no free tier for image output for the current Nano Banana image models; for example, the current 1K image output prices vary by model and the listed Gemini 3.1 Flash Image rate is about **US$0.067/image**. Prices and model IDs can change. [Google image-generation guide](https://ai.google.dev/gemini-api/docs/image-generation) · [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)

No Google request was made. A Gemini adapter would require a separately approved provider/key and explicit permission for any billable call; it would not be an Arena adapter.

### Agnes AI

Official Agnes documentation currently describes `POST https://apihub.agnes-ai.com/v1/images/generations` for `agnes-image-2.5-flash`, prompt-to-image, URL/Base64 output, and API-key authentication. Its current documentation says the image output tiers are currently priced at $0, but that is an offer/pricing claim that can change and is account/provider-specific. An Agnes key is a separate credential and Agnes AI is not Arena.ai. [Agnes Image 2.5 Flash API](https://agnes-ai.com/en/docs/agnes-image-25-flash) · [Agnes pricing](https://wiki.agnes-ai.com/en/docs/pricing)

No Agnes key/request was used. If chosen, the user should create/manage the key with Agnes and set it locally in `.env` or a protected environment variable; do not send it in chat. Add a separately named `agnes` provider (not `arena`) and verify the current displayed price/quotas before any live operation.

### Audio via SIWC

OpenAI's current SIWC preview limitations describe `https://api.openai.com/v1` Responses usage. They explicitly exclude **audio/video input**, the Files upload API and transcription API; they also list image generation among unsupported hosted tools. The public SIWC contract found does not document a TTS/audio-output route. Thus the existing SIWC access token must not be repurposed for OpenAI audio endpoints or treated as a general API key. Audio should remain local Piper/Whisper.cpp unless the SIWC docs explicitly add eligible audio routes. [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) · [SIWC models/inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

## Decision for the requested first proof

The requested proof—Gateway accepts a prompt, Arena performs online image generation, Gateway returns the actual image file—**cannot be honestly completed with the public Arena API contract documented above**. Implementing against guessed/private frontend calls, using a mock, or substituting another provider would not satisfy it. The previous ComfyUI adapter is not proof of Arena generation and remains only a configured-local option.

No `arena` image adapter was added and no capability was marked available. Next safe options:

1. User provides a link to Arena's official image-generation API contract/workspace entitlement (not a secret); then implement against that documented route and test with an authorized key stored locally.
2. User selects the separately named Agnes API (currently advertised at $0 in its docs) or Google Gemini API (billable image output), and explicitly approves the provider and any charges before a real request. The Gateway can then return the actual downloaded/base64 image as a stored file.
3. Continue with a local ComfyUI workflow.

Do not advance to real inference until a provider/key is explicitly selected and its current cost, quota and use terms are checked. The first real proof should then produce an actual image file and record which provider/model was used, not just a text response or synthetic placeholder.
