/* ========================= HTTP / CORS / misc utils ========================= */

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, x-api-key, anthropic-api-key, anthropic-version, anthropic-beta, proxy-token, x-or-model, x-provider, x-base-url",
  "access-control-expose-headers":
    "x-or-model, x-or-prompt-tokens, x-or-completion-tokens, x-or-total-tokens, x-or-cost-usd, x-or-duration-ms, x-or-tps",
};

export function header(request, key) {
  return request.headers.get(key) || request.headers.get(key.toLowerCase()) || "";
}

export function parseJSON(raw, fallback) {
  try {
    const t = (raw || "").trim();
    return t ? JSON.parse(t) : fallback;
  } catch {
    return fallback;
  }
}

export function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

export function withCORS(resp) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v);
  h.set("anthropic-version", "2023-06-01"); // compat Claude Code
  return new Response(resp.body, { status: resp.status, headers: h });
}

/** Short random id, works in Workers and Node. */
export function rid(prefix = "") {
  let s;
  try {
    s = (globalThis.crypto?.randomUUID?.() || "").replace(/-/g, "");
  } catch {
    s = "";
  }
  if (!s) s = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return prefix + s;
}

/* ----- Anthropic-shaped error envelope ----- */
const STATUS_TO_TYPE = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  408: "timeout_error",
  413: "request_too_large",
  422: "invalid_request_error",
  429: "rate_limit_error",
  500: "api_error",
  502: "api_error",
  503: "overloaded_error",
  529: "overloaded_error",
};

export function anthropicError(status, message, typeOverride) {
  const type = typeOverride || STATUS_TO_TYPE[status] || "api_error";
  return { type: "error", error: { type, message: String(message ?? "error") } };
}

/**
 * Turn an upstream (OpenAI-compatible) error body/string into an Anthropic error.
 * Accepts a parsed object or raw text.
 */
export function upstreamErrorToAnthropic(status, body) {
  let message = "";
  if (body && typeof body === "object") {
    message =
      body.error?.message ||
      body.error?.metadata?.raw ||
      body.message ||
      JSON.stringify(body.error || body);
  } else if (typeof body === "string") {
    message = body;
    try {
      const parsed = JSON.parse(body);
      message = parsed?.error?.message || parsed?.message || message;
    } catch {
      /* keep raw text */
    }
  }
  return anthropicError(status, message || `upstream_error_${status}`);
}
