import { header } from "./util.js";

/* ========================= Multi-provider resolution ========================= */
/*
 * Every provider here speaks the OpenAI-compatible /chat/completions API.
 * Resolution order for the backend:
 *   1. `x-base-url` header or env.UPSTREAM_BASE_URL  -> fully custom endpoint
 *   2. `x-provider` header
 *   3. env.PROVIDER
 *   4. auto-detection from the client API key prefix
 *   5. default: openrouter
 */

export const PROVIDERS = {
  openrouter: {
    base: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    ranking: true, // send HTTP-Referer / X-Title
  },
  openai: {
    base: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
  },
  groq: {
    base: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
  },
  deepseek: {
    base: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
  },
  together: {
    base: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY",
  },
  mistral: {
    base: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
  },
  xai: {
    base: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
  },
  cerebras: {
    base: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
  },
};

/** True when a client-provided key looks like a real upstream key (BYOK). */
export function isLikelyUpstreamKey(k) {
  return typeof k === "string" && /^(sk-or-|sk-proj-|sk-|gsk_|xai-|csk-)/.test(k);
}

/** Best-effort provider guess from a key prefix. Ambiguous `sk-` defaults to openai. */
export function detectProviderFromKey(k) {
  if (!k) return null;
  if (k.startsWith("sk-or-")) return "openrouter";
  if (k.startsWith("gsk_")) return "groq";
  if (k.startsWith("xai-")) return "xai";
  if (k.startsWith("csk-")) return "cerebras";
  if (k.startsWith("sk-")) return "openai";
  return null;
}

/**
 * Resolve the upstream provider for a request.
 * Returns { name, chatUrl, modelsUrl, serverKey, ranking }.
 */
export function resolveProvider(env, request, clientKey) {
  const customBase = (header(request, "x-base-url") || env.UPSTREAM_BASE_URL || "").trim();
  if (customBase) {
    const base = customBase.replace(/\/+$/, "");
    return {
      name: "custom",
      chatUrl: `${base}/chat/completions`,
      modelsUrl: `${base}/models`,
      serverKey: (env.UPSTREAM_API_KEY || env.OPENROUTER_API_KEY || "").trim(),
      ranking: false,
    };
  }

  const explicit = (header(request, "x-provider") || env.PROVIDER || "").trim().toLowerCase();
  const name =
    (explicit && PROVIDERS[explicit] && explicit) ||
    detectProviderFromKey(clientKey) ||
    "openrouter";

  const p = PROVIDERS[name] || PROVIDERS.openrouter;
  return {
    name,
    chatUrl: `${p.base}/chat/completions`,
    modelsUrl: `${p.base}/models`,
    serverKey: (env[p.envKey] || "").trim(),
    ranking: !!p.ranking,
  };
}

/** Build auth + ranking headers for the chosen provider. */
export function providerHeaders(provider, key, env) {
  const h = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (provider.ranking) {
    h["HTTP-Referer"] = (env.HTTP_REFERER || "https://github.com/").trim();
    h["X-Title"] = (env.X_TITLE || "Claude Code Proxy").trim();
  }
  return h;
}
