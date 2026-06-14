import { describe, it, expect } from "vitest";
import { anthropicSSEStream } from "../src/streaming.js";
import { streamFromChunks, readAll, parseSSE } from "./helpers.js";

const d = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

describe("anthropicSSEStream - text", () => {
  it("emits a conformant Anthropic event sequence", async () => {
    const src = streamFromChunks([
      d({ choices: [{ delta: { role: "assistant", content: "Hel" } }] }),
      d({ choices: [{ delta: { content: "lo" } }] }),
      d({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      "data: [DONE]\n\n",
    ]);
    const events = parseSSE(await readAll(anthropicSSEStream(src, { model: "m", inputTokens: 5 })));
    const names = events.map((e) => e.event);

    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_start");
    expect(names).toContain("content_block_delta");
    expect(names).toContain("content_block_stop");
    expect(names[names.length - 1]).toBe("message_stop");

    const text = events
      .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "text_delta")
      .map((e) => e.data.delta.text)
      .join("");
    expect(text).toBe("Hello");

    const msgDelta = events.find((e) => e.event === "message_delta");
    expect(msgDelta.data.delta.stop_reason).toBe("end_turn");
    expect(msgDelta.data.usage.input_tokens).toBe(5);
    expect(msgDelta.data.usage.output_tokens).toBe(1);
  });
});

describe("anthropicSSEStream - tool calls", () => {
  it("translates streamed tool_calls into tool_use + input_json_delta", async () => {
    const src = streamFromChunks([
      d({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "ls", arguments: "" } }] } }] }),
      d({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }),
      d({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"."}' } }] } }] }),
      d({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    ]);
    const events = parseSSE(await readAll(anthropicSSEStream(src, { model: "m", inputTokens: 3 })));

    const start = events.find((e) => e.event === "content_block_start");
    expect(start.data.content_block.type).toBe("tool_use");
    expect(start.data.content_block.name).toBe("ls");
    expect(start.data.content_block.id).toBe("call_1");

    const args = events
      .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta")
      .map((e) => e.data.delta.partial_json)
      .join("");
    expect(args).toBe('{"path":"."}');
    expect(JSON.parse(args)).toEqual({ path: "." });

    const msgDelta = events.find((e) => e.event === "message_delta");
    expect(msgDelta.data.delta.stop_reason).toBe("tool_use");
  });

  it("handles text followed by a tool call (block transitions)", async () => {
    const src = streamFromChunks([
      d({ choices: [{ delta: { content: "thinking..." } }] }),
      d({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "ls", arguments: "{}" } }] } }] }),
      d({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    const events = parseSSE(await readAll(anthropicSSEStream(src, { model: "m" })));

    const starts = events.filter((e) => e.event === "content_block_start");
    expect(starts.length).toBe(2);
    expect(starts[0].data.index).toBe(0);
    expect(starts[0].data.content_block.type).toBe("text");
    expect(starts[1].data.index).toBe(1);
    expect(starts[1].data.content_block.type).toBe("tool_use");

    const stops = events.filter((e) => e.event === "content_block_stop");
    expect(stops.map((s) => s.data.index)).toEqual([0, 1]);
  });
});

describe("anthropicSSEStream - errors", () => {
  it("surfaces an upstream error event but still closes cleanly", async () => {
    const src = streamFromChunks([d({ error: { message: "rate limited" } })]);
    const events = parseSSE(await readAll(anthropicSSEStream(src, { model: "m" })));
    expect(events.find((e) => e.event === "error").data.error.message).toBe("rate limited");
    expect(events[events.length - 1].event).toBe("message_stop");
  });
});
