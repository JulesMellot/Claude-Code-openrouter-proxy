import { describe, it, expect } from "vitest";
import {
  isLikelyUpstreamKey,
  detectProviderFromKey,
  resolveProvider,
  providerHeaders,
} from "../src/providers.js";

const req = (headers = {}) => ({
  headers: { get: (k) => headers[k.toLowerCase()] || "" },
});

describe("isLikelyUpstreamKey", () => {
  it("recognizes known prefixes", () => {
    expect(isLikelyUpstreamKey("sk-or-v1-abc")).toBe(true);
    expect(isLikelyUpstreamKey("gsk_abc")).toBe(true);
    expect(isLikelyUpstreamKey("xai-abc")).toBe(true);
    expect(isLikelyUpstreamKey("sk-proj-abc")).toBe(true);
    expect(isLikelyUpstreamKey("random")).toBe(false);
  });
});

describe("detectProviderFromKey", () => {
  it("routes by prefix", () => {
    expect(detectProviderFromKey("sk-or-x")).toBe("openrouter");
    expect(detectProviderFromKey("gsk_x")).toBe("groq");
    expect(detectProviderFromKey("xai-x")).toBe("xai");
    expect(detectProviderFromKey("sk-x")).toBe("openai");
    expect(detectProviderFromKey("")).toBeNull();
  });
});

describe("resolveProvider", () => {
  it("defaults to openrouter", () => {
    const p = resolveProvider({}, req(), "");
    expect(p.name).toBe("openrouter");
    expect(p.chatUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("auto-detects groq from key", () => {
    const p = resolveProvider({}, req(), "gsk_abc");
    expect(p.name).toBe("groq");
    expect(p.chatUrl).toContain("groq.com");
  });

  it("honors x-provider header", () => {
    const p = resolveProvider({}, req({ "x-provider": "openai" }), "sk-or-x");
    expect(p.name).toBe("openai");
  });

  it("supports a fully custom base url", () => {
    const p = resolveProvider({ UPSTREAM_BASE_URL: "https://my.host/v1/" }, req(), "");
    expect(p.name).toBe("custom");
    expect(p.chatUrl).toBe("https://my.host/v1/chat/completions");
    expect(p.modelsUrl).toBe("https://my.host/v1/models");
  });

  it("resolves the server key from env", () => {
    const p = resolveProvider({ GROQ_API_KEY: "gsk_server" }, req({ "x-provider": "groq" }), "");
    expect(p.serverKey).toBe("gsk_server");
  });
});

describe("providerHeaders", () => {
  it("adds ranking headers only for openrouter", () => {
    const or = resolveProvider({}, req(), "sk-or-x");
    const h = providerHeaders(or, "sk-or-x", {});
    expect(h.Authorization).toBe("Bearer sk-or-x");
    expect(h["X-Title"]).toBeDefined();

    const oai = resolveProvider({}, req({ "x-provider": "openai" }), "");
    const h2 = providerHeaders(oai, "sk-x", {});
    expect(h2["X-Title"]).toBeUndefined();
  });
});
