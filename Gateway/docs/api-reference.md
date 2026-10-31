# Local API reference

Base URL `http://127.0.0.1:1455`; bind is intentionally loopback-only. Except `/health`, routes require `Authorization: Bearer <GATEWAY_API_KEY>`.

## `GET /health`
Public, credential-free response: `{status, authenticated, gateway, version}`. Does not test upstream reachability or reveal identity/credentials.

## `GET /v1/models`
Lists current account models authorized for the direct Responses API; filters to OpenAI's `visibility == "list"` entries. Gateway returns Chat Completions-compatible `data[]` with `id` equal to actual model slug. Requires bearer key and live connection.

## `POST /v1/chat/completions`
Supported JSON fields: `model`, `messages`, `stream`, `tools`, `tool_choice`, `parallel_tool_calls`, `stream_options.include_usage`. Unknown fields return 400. Messages are text-only and roles system/developer/user/assistant/tool. Provider supports only model slugs discovered for the authenticated user. Upstream always `stream:true`, `store:false`; when client sends `stream:false`, gateway buffers until successful response completion then returns JSON.

Chat Completions tool definitions (`type:function`) are grouped beneath Responses namespace `gateway`. Tool call names returned to a Chat Completions client are represented as `gateway.<function>`. The gateway never runs tools. The client must execute an authorized local function and provide a tool result in a subsequent request; round-trip uses `tool_call_id` and namespace mapping.

### Errors

JSON errors have `{error:{message,type,code,retryable}}`; upstream raw bodies and credential details are not forwarded. Common codes: `invalid_api_key` 401, `authentication_required` 401, `sharing_scope_missing` 401, `model_not_available` 400, `invalid_request`/`unsupported_parameter` 400, `rate_limit` 429, upstream 429 plan/rate limits preserved as 429, upstream 5xx mapped to 502. Streaming failure is an SSE `data: {"error":...}` and connection end; success requires `[DONE]` emitted after `response.completed`.
