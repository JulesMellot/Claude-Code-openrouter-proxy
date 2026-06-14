import { rid } from "./util.js";
import { mapStopReason, mapUsageFromOpenRouter } from "./mappers.js";

/* ========================= OpenAI SSE -> Anthropic SSE ========================= */
/*
 * Translates an OpenAI-compatible streaming chat completion into the Anthropic
 * Messages streaming protocol that Claude Code expects:
 *
 *   message_start -> [content_block_start -> content_block_delta* -> content_block_stop]*
 *                 -> message_delta (stop_reason + usage) -> message_stop
 *
 * Handles: incremental text, tool_use (input_json_delta), optional reasoning
 * (thinking_delta), final usage, and upstream errors.
 */

export function anthropicSSEStream(orBody, opts = {}) {
  const {
    model = "openrouter",
    inputTokens = 0,
    mapReasoning = false,
    tokensPerChar = 0.25,
  } = opts;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const messageId = rid("msg_");

  return new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      let started = false;
      let blockOpen = false;
      let blockType = null; // "text" | "tool_use" | "thinking"
      let blockIndex = -1;
      const toolByOrIndex = new Map(); // OpenAI tool_call index -> anthropic block index
      let finishReason = null;
      let usage = null;
      let outputCharLen = 0;
      let upstreamError = null;

      const ensureStart = () => {
        if (started) return;
        started = true;
        send("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        });
        send("ping", { type: "ping" });
      };

      const closeBlock = () => {
        if (!blockOpen) return;
        send("content_block_stop", { type: "content_block_stop", index: blockIndex });
        blockOpen = false;
        blockType = null;
      };

      const openBlock = (type, contentBlock) => {
        ensureStart();
        closeBlock();
        blockIndex += 1;
        blockOpen = true;
        blockType = type;
        send("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: contentBlock,
        });
        return blockIndex;
      };

      const reader = orBody.getReader();
      let buf = "";

      const handleObj = (obj) => {
        if (obj.error) {
          upstreamError = obj.error;
          return;
        }
        if (obj.usage) usage = obj.usage;
        const choice = obj.choices && obj.choices[0];
        if (!choice) return;
        const delta = choice.delta || {};

        // reasoning -> thinking
        if (mapReasoning && typeof delta.reasoning === "string" && delta.reasoning.length) {
          if (blockType !== "thinking") openBlock("thinking", { type: "thinking", thinking: "" });
          send("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "thinking_delta", thinking: delta.reasoning },
          });
        }

        // text content (string or array of parts)
        const emitText = (txt) => {
          if (!txt) return;
          if (blockType !== "text") openBlock("text", { type: "text", text: "" });
          outputCharLen += txt.length;
          send("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text: txt },
          });
        };
        if (typeof delta.content === "string") {
          emitText(delta.content);
        } else if (Array.isArray(delta.content)) {
          for (const part of delta.content) {
            const t = typeof part === "string" ? part : part?.text ?? "";
            emitText(t);
          }
        }

        // tool calls
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const orIdx = tc.index ?? 0;
            let aIdx = toolByOrIndex.get(orIdx);
            if (aIdx == null) {
              const toolId = tc.id || rid("toolu_");
              const name = tc.function?.name || "tool";
              aIdx = openBlock("tool_use", { type: "tool_use", id: toolId, name, input: {} });
              toolByOrIndex.set(orIdx, aIdx);
            }
            const argChunk = tc.function?.arguments;
            if (typeof argChunk === "string" && argChunk.length) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: aIdx,
                delta: { type: "input_json_delta", partial_json: argChunk },
              });
            }
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const events = buf.split("\n\n");
          buf = events.pop() || "";
          for (const evt of events) {
            const dataPayload = evt
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.toLowerCase().startsWith("data:"))
              .map((l) => l.slice(l.indexOf(":") + 1).trim())
              .join("");
            if (!dataPayload || dataPayload === "[DONE]") continue;
            let obj;
            try {
              obj = JSON.parse(dataPayload);
            } catch {
              continue;
            }
            handleObj(obj);
          }
        }

        // flush trailing buffer (provider that doesn't terminate with \n\n)
        if (buf.trim()) {
          const tail = buf
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.toLowerCase().startsWith("data:"))
            .map((l) => l.slice(l.indexOf(":") + 1).trim())
            .join("");
          if (tail && tail !== "[DONE]") {
            try {
              handleObj(JSON.parse(tail));
            } catch {
              /* ignore */
            }
          }
        }

        ensureStart();
        closeBlock();

        if (upstreamError) {
          send("error", {
            type: "error",
            error: { type: "api_error", message: upstreamError.message || "upstream_error" },
          });
        }

        const stop = mapStopReason(finishReason, toolByOrIndex.size > 0);
        const mapped = usage ? mapUsageFromOpenRouter(usage) : null;
        const finalUsage = {
          input_tokens: mapped?.input_tokens || inputTokens,
          output_tokens: mapped?.output_tokens || Math.floor(outputCharLen * tokensPerChar),
        };

        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stop, stop_sequence: null },
          usage: finalUsage,
        });
        send("message_stop", { type: "message_stop" });
        controller.close();
      } catch (e) {
        try {
          ensureStart();
          closeBlock();
          send("error", { type: "error", error: { type: "api_error", message: String(e?.message || e) } });
          send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          });
          send("message_stop", { type: "message_stop" });
        } catch {
          /* controller already closed */
        }
        controller.close();
      }
    },
  });
}
