import { describe, it, expect } from "vitest";
import {
  extractText,
  mapStopReason,
  mapUsageFromOpenRouter,
  computeCostUSD,
  toOpenRouterPayload,
  toAnthropicResponse,
  anthropicImageToOpenAI,
  estimatePromptTokensFromAnthropic,
} from "../src/mappers.js";

const fakeReq = { headers: { get: () => "" } };
const identity = (x) => x;

describe("extractText", () => {
  it("flattens array text blocks", () => {
    expect(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });
  it("returns plain strings", () => {
    expect(extractText("hello")).toBe("hello");
  });
});

describe("mapStopReason", () => {
  it("maps tool calls", () => {
    expect(mapStopReason("tool_calls", false)).toBe("tool_use");
    expect(mapStopReason("stop", true)).toBe("tool_use");
  });
  it("maps length to max_tokens", () => {
    expect(mapStopReason("length", false)).toBe("max_tokens");
  });
  it("defaults to end_turn", () => {
    expect(mapStopReason("stop", false)).toBe("end_turn");
    expect(mapStopReason(undefined, false)).toBe("end_turn");
  });
});

describe("mapUsageFromOpenRouter", () => {
  it("maps prompt/completion + cached", () => {
    const u = mapUsageFromOpenRouter({
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 3 },
    });
    expect(u.input_tokens).toBe(10);
    expect(u.output_tokens).toBe(5);
    expect(u.cache_read_input_tokens).toBe(3);
  });
});

describe("computeCostUSD", () => {
  it("computes from pricing per 1k tokens", () => {
    const c = computeCostUSD({ input_tokens: 1000, output_tokens: 1000 }, "m", { m: { in: 0.5, out: 1.5 } });
    expect(c.total).toBeCloseTo(2.0, 6);
  });
  it("returns null without pricing", () => {
    expect(computeCostUSD({ input_tokens: 1 }, "m", {})).toBeNull();
  });
});

describe("anthropicImageToOpenAI", () => {
  it("converts base64 to data url", () => {
    const r = anthropicImageToOpenAI({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    expect(r.image_url.url).toBe("data:image/png;base64,AAAA");
  });
  it("passes through url source", () => {
    const r = anthropicImageToOpenAI({ type: "image", source: { type: "url", url: "http://x/y.png" } });
    expect(r.image_url.url).toBe("http://x/y.png");
  });
});

describe("toOpenRouterPayload", () => {
  it("maps a simple user message", () => {
    const body = { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
    const p = toOpenRouterPayload(body, fakeReq, {}, identity);
    expect(p.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("keeps tool replies right after the assistant tool_use (no wedged user)", () => {
    const body = {
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "do it" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "ls", input: { path: "." } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "file.txt" }],
        },
      ],
    };
    const p = toOpenRouterPayload(body, fakeReq, {}, identity);
    const roles = p.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool"]);
    const assistant = p.messages[1];
    expect(assistant.tool_calls[0].id).toBe("call_1");
    const tool = p.messages[2];
    expect(tool.tool_call_id).toBe("call_1");
    expect(tool.content).toBe("file.txt");
  });

  it("builds multimodal content when images are present", () => {
    const body = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZ" } },
          ],
        },
      ],
    };
    const p = toOpenRouterPayload(body, fakeReq, {}, identity);
    const c = p.messages[0].content;
    expect(Array.isArray(c)).toBe(true);
    expect(c[0]).toEqual({ type: "text", text: "look" });
    expect(c[1].image_url.url).toBe("data:image/jpeg;base64,ZZ");
  });

  it("maps tools and tool_choice", () => {
    const body = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [{ name: "ls", description: "list", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    };
    const p = toOpenRouterPayload(body, fakeReq, {}, identity);
    expect(p.tools[0].function.name).toBe("ls");
    expect(p.tool_choice).toBe("required");
  });

  it("applies FORCE_MODEL via mapModel", () => {
    const body = { model: "claude-x", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] };
    const p = toOpenRouterPayload(body, fakeReq, {}, () => "forced/model");
    expect(p.model).toBe("forced/model");
  });
});

describe("toAnthropicResponse", () => {
  it("maps text + usage", () => {
    const or = {
      id: "x",
      model: "m",
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    };
    const { out, headers } = toAnthropicResponse(or, { model: "m" }, 100, {}, identity, 0);
    expect(out.content[0]).toEqual({ type: "text", text: "hello" });
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage.input_tokens).toBe(4);
    expect(headers["X-OR-Total-Tokens"]).toBe("6");
  });

  it("maps tool calls to tool_use blocks", () => {
    const or = {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [{ id: "call_9", function: { name: "ls", arguments: '{"path":"."}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const { out } = toAnthropicResponse(or, { model: "m" }, 50, {}, identity, 0);
    expect(out.stop_reason).toBe("tool_use");
    const tu = out.content.find((b) => b.type === "tool_use");
    expect(tu.name).toBe("ls");
    expect(tu.input).toEqual({ path: "." });
  });
});

describe("estimatePromptTokensFromAnthropic", () => {
  it("counts roughly chars/4", () => {
    const n = estimatePromptTokensFromAnthropic(
      { messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(40) }] }] },
      {}
    );
    expect(n).toBe(10);
  });
});
