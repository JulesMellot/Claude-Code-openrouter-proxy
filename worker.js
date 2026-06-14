import {
  CORS_HEADERS,
  header,
  parseJSON,
  json,
  withCORS,
  anthropicError,
  upstreamErrorToAnthropic,
} from "./src/util.js";
import { isLikelyUpstreamKey, resolveProvider, providerHeaders } from "./src/providers.js";
import {
  toOpenRouterPayload,
  toAnthropicResponse,
  estimatePromptTokensFromAnthropic,
  shouldEstimateUsage,
  shouldMapReasoning,
  tokensPerChar,
} from "./src/mappers.js";
import { anthropicSSEStream } from "./src/streaming.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") return withCORS(new Response(null, { status: 204 }));

    // Health / info
    if (url.pathname === "/health") return withCORS(json({ ok: true }));
    if (url.pathname === "/" && request.method === "GET") {
      return withCORS(
        json({
          name: "Claude Code Proxy",
          ok: true,
          endpoints: ["/v1/messages", "/v1/messages/count_tokens", "/v1/models", "/health"],
        })
      );
    }

    // ---- count_tokens (Anthropic-compatible) ----
    if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      try {
        const body = await request.json();
        return withCORS(json({ input_tokens: estimatePromptTokensFromAnthropic(body, env) }));
      } catch {
        return withCORS(json(anthropicError(400, "invalid_json"), 400));
      }
    }

    // Beyond this point only the upstream-backed routes exist.
    if (url.pathname !== "/v1/messages" && url.pathname !== "/v1/models") {
      return withCORS(json(anthropicError(404, "not_found"), 404));
    }

    // ---- Auth (shared) ----
    const clientKey = header(request, "anthropic-api-key") || header(request, "x-api-key") || "";
    const proxyToken = header(request, "proxy-token") || "";
    const byok = isLikelyUpstreamKey(clientKey);
    const provider = resolveProvider(env, request, byok ? clientKey : "");

    let upstreamKey = "";
    if (byok) {
      upstreamKey = clientKey;
    } else {
      if (String(env.REQUIRE_PROXY_TOKEN || "0") === "1" && proxyToken !== env.PROXY_TOKEN) {
        return withCORS(json(anthropicError(403, "forbidden"), 403));
      }
      upstreamKey = provider.serverKey;
    }
    if (!upstreamKey) {
      return withCORS(json(anthropicError(401, "missing_api_key"), 401));
    }

    // ---- models passthrough ----
    if (url.pathname === "/v1/models" && request.method === "GET") {
      try {
        const r = await fetch(provider.modelsUrl, {
          headers: providerHeaders(provider, upstreamKey, env),
        });
        const data = await r.json().catch(() => ({}));
        return withCORS(json(data, r.status));
      } catch (e) {
        return withCORS(json(anthropicError(502, String(e?.message || e)), 502));
      }
    }

    // ---- Main messages endpoint ----
    if (request.method !== "POST" || url.pathname !== "/v1/messages") {
      return withCORS(json(anthropicError(404, "not_found"), 404));
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return withCORS(json(anthropicError(400, "invalid_json"), 400));
    }

    // ---- Model mapping ----
    const MODEL_MAP_BASE = {
      "claude-3-5-haiku-20241022": "$passthrough",
      "claude-3-7-sonnet-latest": "$passthrough",
      "claude-3-7-sonnet-20250219": "$passthrough",
      "claude-3-opus-20240229": "$passthrough",
    };
    const MODEL_MAP_EXT = parseJSON(env.MODEL_MAP_EXT, {});
    const FORCE_MODEL = (env.FORCE_MODEL || "").trim();
    const mapModel = (id) => {
      if (FORCE_MODEL) return FORCE_MODEL;
      if (MODEL_MAP_EXT[id]) return MODEL_MAP_EXT[id];
      if (MODEL_MAP_BASE[id] && MODEL_MAP_BASE[id] !== "$passthrough") return MODEL_MAP_BASE[id];
      return id;
    };

    const accept = request.headers.get("accept") || "";
    const wantsStream = accept.includes("text/event-stream") || body?.stream === true;

    const headers = providerHeaders(provider, upstreamKey, env);
    const inputTokensEstimate = shouldEstimateUsage(env)
      ? estimatePromptTokensFromAnthropic(body, env)
      : 0;

    // ================= STREAMING =================
    if (wantsStream) {
      const payload = toOpenRouterPayload(body, request, env, mapModel);
      payload.stream = true;
      payload.usage = { include: true };

      let orResp = await fetchUpstream(provider.chatUrl, headers, payload, env);
      orResp = await maybeFallback(orResp, provider, headers, payload, env);

      if (!orResp.ok || !orResp.body) {
        const errText = await orResp.text().catch(() => "");
        return withCORS(json(upstreamErrorToAnthropic(orResp.status || 502, errText), orResp.status || 502));
      }

      const stream = anthropicSSEStream(orResp.body, {
        model: mapModel(payload.model),
        inputTokens: inputTokensEstimate,
        mapReasoning: shouldMapReasoning(env),
        tokensPerChar: tokensPerChar(env),
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive",
          "anthropic-version": "2023-06-01",
          ...CORS_HEADERS,
        },
      });
    }

    // ================= NON-STREAM =================
    const payload = toOpenRouterPayload(body, request, env, mapModel);
    const t0 = Date.now();

    let resp = await fetchUpstream(provider.chatUrl, headers, payload, env);
    resp = await maybeFallback(resp, provider, headers, payload, env);

    const durationMs = Date.now() - t0;

    let data;
    try {
      data = await resp.json();
    } catch {
      const raw = await resp.text().catch(() => "");
      return withCORS(json(upstreamErrorToAnthropic(resp.status || 502, raw), resp.status || 502));
    }

    if (!resp.ok) {
      return withCORS(json(upstreamErrorToAnthropic(resp.status, data), resp.status));
    }

    const { out, headers: extraHeaders } = toAnthropicResponse(
      data,
      payload,
      durationMs,
      env,
      mapModel,
      inputTokensEstimate
    );
    return withCORS(json(out, 200, extraHeaders));
  },
};

/* ========================= Upstream helpers ========================= */

async function fetchUpstream(chatUrl, headers, payload, env) {
  const timeoutMs = Number(env.TIMEOUT_MS || 240000);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    // Synthesize a Response so callers handle it uniformly.
    return new Response(JSON.stringify({ error: { message: String(e?.message || e) } }), {
      status: e?.name === "AbortError" ? 408 : 502,
      headers: { "content-type": "application/json" },
    });
  } finally {
    clearTimeout(t);
  }
}

/** Retry once with FALLBACK_MODEL on 429/5xx. */
async function maybeFallback(resp, provider, headers, payload, env) {
  if (resp.ok) return resp;
  const status = resp.status;
  const FALLBACK_MODEL = (env.FALLBACK_MODEL || "").trim();
  if (FALLBACK_MODEL && (status === 429 || (status >= 500 && status <= 599))) {
    return fetchUpstream(provider.chatUrl, headers, { ...payload, model: FALLBACK_MODEL }, env);
  }
  return resp;
}
