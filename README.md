# Claude Code Proxy

A Cloudflare Worker that lets [Claude Code](https://claude.com/claude-code) talk to OpenAI-compatible backends (OpenRouter, OpenAI, Groq, and others). It translates the Anthropic Messages API into the OpenAI chat format and back, so you can point Claude Code at any model without installing anything locally.

## Quick start

Set two environment variables and you're done:

```bash
export ANTHROPIC_BASE_URL="https://proxycodeclaude.mellot-jules.workers.dev"
export ANTHROPIC_API_KEY="sk-or-v1-..."   # your own OpenRouter key

claude --model "z-ai/glm-4.5"
```

The base URL is the bare host — no `/v1/messages`, no query string. Your key is sent through the usual `x-api-key` / `anthropic-api-key` header and used as-is against the upstream provider (BYOK). Nothing is stored.

## How it works

Claude Code only speaks the Anthropic Messages API. Most other model providers speak the OpenAI chat-completions API. The worker sits in the middle and translates both directions, per request:

```
Claude Code ──POST /v1/messages──▶  Worker  ──POST /chat/completions──▶  Provider
 (Anthropic format)                   │  rewrite request                  (OpenAI format)
                                      │
Claude Code ◀──── SSE / JSON ────────┘  rewrite response  ◀──── SSE / JSON ────
 (Anthropic format)                                                (OpenAI format)
```

On the way in, the worker:

- Flattens Anthropic `system` / `messages` blocks into OpenAI messages, turning `tool_use` blocks into `tool_calls` and `tool_result` blocks into `tool` messages — and re-orders them so every tool reply sits directly after the assistant call that produced it (some providers reject anything else).
- Converts image blocks to OpenAI `image_url` parts.
- Maps Anthropic tool definitions (`input_schema`) to OpenAI function schemas.

On the way out, it does the reverse. The interesting part is **streaming**: the worker reads the provider's OpenAI-style SSE and re-emits the exact Anthropic event sequence Claude Code expects — `message_start`, `content_block_start/delta/stop` for each text or `tool_use` block, then `message_delta` (with `stop_reason` and token usage) and `message_stop`. Tool-call arguments are streamed back as `input_json_delta` chunks. Without this, tool calling — and therefore Claude Code's whole agent loop — silently breaks.

Auth is pass-through: whatever key you give Claude Code is forwarded to the provider. The worker keeps no state and stores nothing.

## Models in Claude Code

There is no central "model list" the proxy controls. The model is just a string Claude Code puts in the `model` field of every request, and the worker forwards (or remaps) it to the provider. You pick it in any of these ways:

```bash
claude --model "z-ai/glm-4.5"     # for one session
/model deepseek/deepseek-chat      # switch mid-session (slash command)
export ANTHROPIC_MODEL="..."       # default main model
```

**Important — Claude Code actually uses two models.** Besides the main model, it fires a smaller "fast" model for background chores (conversation titles, simple classifications). That one is sent as a Claude **haiku** name by default, which your provider won't recognize. Point it somewhere real too, or those background calls fail:

```bash
export ANTHROPIC_MODEL="z-ai/glm-4.5"
export ANTHROPIC_SMALL_FAST_MODEL="z-ai/glm-4.5-air"
```

(Recent Claude Code versions also expose `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` to remap each tier individually.) Alternatively, handle the remap server-side with `MODEL_MAP_EXT`, e.g. `{"claude-3-5-haiku-20241022":"z-ai/glm-4.5-air"}`.

How the worker resolves the final model name, in order:

1. `FORCE_MODEL` env — overrides everything (one model for all traffic)
2. `x-or-model` request header or `PRIMARY_MODEL` env
3. `MODEL_MAP_EXT` entry for the incoming name
4. Otherwise the name passes through unchanged

The built-in model picker in Claude Code only lists Anthropic models and ignores a custom base URL, so with the proxy you choose models by name (`--model` / `/model` / env) rather than from that menu. `GET /v1/models` is exposed for tooling that wants the provider's catalog, but Claude Code itself doesn't need it.

## Switching providers

For each request the worker decides which backend to hit, in this order:

1. `x-base-url` header or `UPSTREAM_BASE_URL` env — any OpenAI-compatible endpoint
2. `x-provider` header — `openrouter`, `openai`, `groq`, `deepseek`, `together`, `mistral`, `xai`, `cerebras`
3. `PROVIDER` env var
4. The API key prefix — `sk-or-` → OpenRouter, `gsk_` → Groq, `xai-` → xAI, `sk-` → OpenAI
5. Default: OpenRouter

In BYOK mode the simplest switch is just using that provider's key — the prefix gives it away:

```bash
# OpenRouter (default)
export ANTHROPIC_API_KEY="sk-or-v1-..."
claude --model "z-ai/glm-4.5"

# OpenAI
export ANTHROPIC_API_KEY="sk-proj-..."
claude --model "gpt-4o"

# Groq
export ANTHROPIC_API_KEY="gsk_..."
claude --model "llama-3.3-70b-versatile"
```

When the key prefix is ambiguous (DeepSeek, Together and Mistral all issue `sk-…` keys, like OpenAI), name the provider explicitly:

```bash
export PROVIDER="deepseek"
export ANTHROPIC_API_KEY="sk-..."   # a DeepSeek key
claude --model "deepseek-chat"
```

Anything that speaks the OpenAI chat API works through `UPSTREAM_BASE_URL` (or the per-request `x-base-url` header) — a local Ollama/LM Studio, vLLM, a gateway, etc.:

```bash
export UPSTREAM_BASE_URL="http://localhost:11434/v1"   # set on the worker
```

`x-provider`, `x-base-url` and `x-or-model` are per-request headers, so a single deployment can serve several backends at once if your client sets them.

## What it handles

- Streaming responses, including tool calls — the worker rebuilds the full Anthropic SSE sequence (`content_block_start` / `input_json_delta` / `content_block_stop` …), which Claude Code needs for its agentic loop.
- Tool / function calling in both streaming and non-streaming mode.
- Images in user messages (converted to OpenAI `image_url`).
- Token usage and an optional USD cost estimate, returned in `X-OR-*` response headers.
- Automatic retry on `429` / `5xx` against a fallback model when one is configured.
- Upstream errors rewritten into Anthropic's `{ "type": "error", ... }` shape so the CLI shows something sensible.

## Endpoints

| Method | Path | |
|--------|------|---|
| POST | `/v1/messages` | main endpoint, streaming or not |
| POST | `/v1/messages/count_tokens` | token estimate |
| GET | `/v1/models` | model list from the active provider |
| GET | `/health` | health check |
| GET | `/` | service info |

## Hosting your own

Deploy to Cloudflare Workers with `npm run deploy`. Configuration lives in `wrangler.toml`:

- `REQUIRE_PROXY_TOKEN = "1"` to lock the proxy behind a `PROXY_TOKEN` secret (otherwise it's open for BYOK).
- Server-key mode: set the provider's key as a secret (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, …) and callers don't need their own.
- `FORCE_MODEL`, `PRIMARY_MODEL`, `FALLBACK_MODEL`, `MODEL_MAP_EXT` to remap or pin models.
- `REASONING_EFFORT` (`low` / `medium` / `high`) and `MAP_REASONING = "1"` to surface reasoning as `thinking` blocks.
- `PRICING_JSON` to get cost estimates in the response headers.
- `TIMEOUT_MS` for the upstream request timeout (default 4 min).

By default model names pass through unchanged, so `claude --model "anything/the-provider-knows"` just works.

## Layout

```
worker.js          entrypoint — routing, auth, fallback, streaming
src/util.js        CORS, JSON, error envelopes
src/providers.js   provider resolution
src/mappers.js     Anthropic <-> OpenAI message/tool/usage mapping
src/streaming.js   OpenAI SSE -> Anthropic SSE
test/              vitest unit tests
```

```bash
npm install
npm test          # run the suite
npm run dev       # local worker on http://localhost:8787
```
