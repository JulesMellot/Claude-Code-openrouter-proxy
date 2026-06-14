import { rid, header, parseJSON } from "./util.js";

/* ========================= Token estimation (fallback) ========================= */

export function tokensPerChar(env) {
  const v = Number(env?.ESTIMATE_TOKENS_PER_CHAR ?? 0.25);
  return Number.isFinite(v) && v > 0 ? v : 0.25; // ~4 chars/token
}

export function shouldEstimateUsage(env) {
  return String(env?.ESTIMATE_USAGE ?? "1") === "1";
}

export function shouldMapReasoning(env) {
  return String(env?.MAP_REASONING ?? "0") === "1";
}

export function extractText(content) {
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!b) return "";
        if (typeof b === "string") return b;
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (typeof b.text === "string") return b.text;
        if ("input" in b) return typeof b.input === "string" ? b.input : JSON.stringify(b.input);
        if ("output" in b) return typeof b.output === "string" ? b.output : JSON.stringify(b.output);
        return JSON.stringify(b);
      })
      .join("\n");
  }
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    if (content.type === "text" && typeof content.text === "string") return content.text;
    if (typeof content.text === "string") return content.text;
    if ("input" in content)
      return typeof content.input === "string" ? content.input : JSON.stringify(content.input);
    if ("output" in content)
      return typeof content.output === "string" ? content.output : JSON.stringify(content.output);
    return JSON.stringify(content);
  }
  return "";
}

export function estimatePromptTokensFromAnthropic(b, env) {
  const TOK_PER_CHAR = tokensPerChar(env || {});
  const clamp = (n) => Math.max(0, Math.floor(n));
  const pieces = [];
  if (b.system) pieces.push(extractText(b.system));
  for (const m of b.messages || []) {
    const role = m.role || "user";
    const c = m.content;
    if (Array.isArray(c)) {
      for (const blok of c) {
        if (blok?.type === "text")
          pieces.push(typeof blok.text === "string" ? blok.text : JSON.stringify(blok.text));
        if (role === "user" && blok?.type === "tool_result") {
          const out = blok.output ?? blok.content ?? "";
          pieces.push(typeof out === "string" ? out : JSON.stringify(out));
        }
      }
    } else {
      pieces.push(extractText(c));
    }
  }
  return clamp(pieces.join("\n").length * TOK_PER_CHAR);
}

export function estimateOutputTokensFromText(text, env) {
  const TOK_PER_CHAR = tokensPerChar(env || {});
  return Math.max(0, Math.floor(String(text || "").length * TOK_PER_CHAR));
}

/* ========================= Tools & multimodal ========================= */

export function mapToolsAnthropicToOpenAI(tools = []) {
  return (tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {}, additionalProperties: true },
    },
  }));
}

/** Convert an Anthropic image block to an OpenAI image_url part (or null). */
export function anthropicImageToOpenAI(block) {
  const src = block?.source || {};
  if (src.type === "base64" && src.data) {
    return {
      type: "image_url",
      image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` },
    };
  }
  if (src.type === "url" && src.url) {
    return { type: "image_url", image_url: { url: src.url } };
  }
  return null;
}

/* ========================= stop_reason mapping ========================= */

export function mapStopReason(finishReason, hasTools) {
  if (hasTools || finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "content_filter") return "end_turn";
  return "end_turn";
}

/* ========================= Anthropic -> OpenAI payload ========================= */

export function toOpenRouterPayload(b, request, env, mapModel) {
  const messagesOut = [];
  const toolsOA = mapToolsAnthropicToOpenAI(b.tools || []);

  if (b.system) messagesOut.push({ role: "system", content: extractText(b.system) });

  for (const m of b.messages || []) {
    const role = m.role || "user";
    const content = m.content;

    if (Array.isArray(content)) {
      if (role === "assistant") {
        let assistantText = "";
        const tool_calls = [];
        for (const block of content) {
          if (!block) continue;
          if (block.type === "text") {
            const t = typeof block.text === "string" ? block.text : JSON.stringify(block.text);
            assistantText += t + "\n";
          } else if (block.type === "tool_use") {
            const callId = block.id || rid("call_");
            const name = block.name || "tool";
            const args = block.input ?? {};
            tool_calls.push({
              id: callId,
              type: "function",
              function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
            });
          } else if (block.type === "thinking" || block.type === "redacted_thinking") {
            // Not representable in OpenAI chat history; drop to avoid corruption.
          } else {
            assistantText += JSON.stringify(block) + "\n";
          }
        }
        const assistantMsg = { role: "assistant" };
        if (assistantText.trim()) assistantMsg.content = assistantText.trim();
        if (tool_calls.length) assistantMsg.tool_calls = tool_calls;
        if (assistantMsg.content || assistantMsg.tool_calls) messagesOut.push(assistantMsg);
      } else if (role === "user") {
        // 1) Buffer text, images and tool_results
        let userText = "";
        const imageParts = [];
        const pendingToolMsgs = [];
        for (const block of content) {
          if (!block) continue;
          if (block.type === "text") {
            const t = typeof block.text === "string" ? block.text : JSON.stringify(block.text);
            userText += t + "\n";
          } else if (block.type === "image") {
            const img = anthropicImageToOpenAI(block);
            if (img) imageParts.push(img);
          } else if (block.type === "tool_result") {
            const tool_call_id = block.tool_use_id || block.id || rid("call_");
            const output = block.output ?? block.content ?? "";
            const toolContent = typeof output === "string" ? output : JSON.stringify(output);
            pendingToolMsgs.push({ role: "tool", tool_call_id, content: toolContent });
          } else {
            userText += JSON.stringify(block) + "\n";
          }
        }

        // 2) Find the most recent assistant message carrying tool_calls
        let prevAssistantIdx = -1;
        for (let i = messagesOut.length - 1; i >= 0; i--) {
          const mprev = messagesOut[i];
          if (mprev.role === "assistant" && Array.isArray(mprev.tool_calls) && mprev.tool_calls.length > 0) {
            prevAssistantIdx = i;
            break;
          } else if (mprev.role !== "tool" && mprev.role !== "assistant") {
            break;
          }
        }

        // 3) If tool_results need to satisfy an assistant -> insert tool msgs right after it
        if (pendingToolMsgs.length && prevAssistantIdx >= 0) {
          const prevAssistant = messagesOut[prevAssistantIdx];
          const toolIds = (prevAssistant.tool_calls || []).map((tc) => tc.id).filter(Boolean);
          const idToName = new Map((prevAssistant.tool_calls || []).map((tc) => [tc.id, tc.function?.name || "tool"]));

          const validById = new Map();
          const invalidTools = [];
          for (const tm of pendingToolMsgs) {
            if (toolIds.includes(tm.tool_call_id)) {
              validById.set(tm.tool_call_id, {
                role: "tool",
                tool_call_id: tm.tool_call_id,
                name: idToName.get(tm.tool_call_id) || "tool",
                content: tm.content,
              });
            } else {
              invalidTools.push(tm);
            }
          }
          const orderedValidTools = toolIds.filter((id) => validById.has(id)).map((id) => validById.get(id));
          if (orderedValidTools.length) {
            messagesOut.splice(prevAssistantIdx + 1, 0, ...orderedValidTools);
          }
          if (invalidTools.length) {
            userText +=
              "\n\n[tool_result]\n" +
              invalidTools.map((t) => `id=${t.tool_call_id} content=${t.content}`).join("\n");
          }
          // CRUCIAL: do not emit a user turn that would split assistant<->tool
          continue;
        }

        // 4) Normal user turn (text and/or images)
        const trimmed = (userText || "").trim();
        if (imageParts.length) {
          const parts = [];
          if (trimmed) parts.push({ type: "text", text: trimmed });
          parts.push(...imageParts);
          messagesOut.push({ role: "user", content: parts });
        } else if (trimmed) {
          messagesOut.push({ role: "user", content: trimmed });
        }
      }
    } else {
      // String content (rare for Claude Code, but keep it lossless)
      const t = extractText(content);
      if (t.trim()) messagesOut.push({ role, content: t.trim() });
    }
  }

  // ---- Post-normalization (Mistral-safe): drop any user wedged between an
  // assistant(tool_calls) and its tool replies. ----
  for (let i = 0; i < messagesOut.length; i++) {
    const m = messagesOut[i];
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const toolIds = new Set(m.tool_calls.map((tc) => tc.id).filter(Boolean));
      let j = i + 1;
      const usersToRemove = [];
      let seenTools = 0;
      while (j < messagesOut.length) {
        const mj = messagesOut[j];
        if (mj.role === "tool" && toolIds.has(mj.tool_call_id)) {
          seenTools++;
          j++;
          continue;
        }
        if (mj.role === "user" && seenTools === 0) {
          usersToRemove.push(j);
          j++;
          continue;
        }
        break;
      }
      for (let k = usersToRemove.length - 1; k >= 0; k--) messagesOut.splice(usersToRemove[k], 1);
    }
  }

  const reqModel = b.model || "anthropic/claude-3.7-sonnet";
  const mappedModel = mapModel(reqModel);

  const out = {
    model: mappedModel,
    messages: messagesOut,
    temperature: b.temperature ?? 0.2,
    max_tokens: b.max_tokens ?? 1024,
    usage: { include: true },
  };
  if (toolsOA.length) out.tools = toolsOA;
  if (b.tool_choice) out.tool_choice = mapToolChoice(b.tool_choice);
  if (Array.isArray(b.stop_sequences) && b.stop_sequences.length) out.stop = b.stop_sequences;

  if ((reqModel || "").includes(":thinking")) {
    out.reasoning = { effort: env.REASONING_EFFORT || "medium" };
  }

  // Header / env overrides
  const overrideModel = (header(request, "x-or-model") || "").trim();
  if (overrideModel) out.model = overrideModel;
  const PRIMARY_MODEL = (env.PRIMARY_MODEL || "").trim();
  if (PRIMARY_MODEL) out.model = PRIMARY_MODEL;

  // OpenRouter / OpenAI passthrough extras
  const passthroughKeys = [
    "plugins", "transforms", "web_search_options", "models", "provider", "reasoning", "usage",
    "top_p", "top_k", "frequency_penalty", "presence_penalty", "repetition_penalty",
    "seed", "logit_bias", "response_format", "user",
  ];
  for (const k of passthroughKeys) if (b[k] !== undefined) out[k] = b[k];

  return out;
}

function mapToolChoice(tc) {
  if (typeof tc === "string") return tc; // "auto" | "none" | "required"
  if (tc && typeof tc === "object") {
    if (tc.type === "auto") return "auto";
    if (tc.type === "any") return "required";
    if (tc.type === "none") return "none";
    if (tc.type === "tool" && tc.name) return { type: "function", function: { name: tc.name } };
  }
  return "auto";
}

/* ========================= Usage / cost ========================= */

export function mapUsageFromOpenRouter(orUsage = {}) {
  const inTok = Number(orUsage.prompt_tokens ?? orUsage.input_tokens ?? 0);
  const outTok = Number(orUsage.completion_tokens ?? orUsage.output_tokens ?? 0);
  const cached = Number(orUsage.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    input_tokens: inTok,
    output_tokens: outTok,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

export function computeCostUSD(usageAnthropic, model, pricing) {
  const p = pricing?.[model];
  if (!p) return null;
  const inTok = usageAnthropic.input_tokens || 0;
  const outTok = usageAnthropic.output_tokens || 0;
  const inCost = (inTok / 1000) * (p.in || 0);
  const outCost = (outTok / 1000) * (p.out || 0);
  return { total: inCost + outCost, inCost, outCost };
}

/* ========================= OpenAI -> Anthropic (non-stream) ========================= */

export function toAnthropicResponse(orjson, payload, durationMs, env, mapModel, inputTokensEstimate) {
  const choice = (orjson.choices && orjson.choices[0]) || {};
  const msg = choice.message || {};
  const finish = choice.finish_reason;
  const content = msg.content ?? "";
  const tool_calls = msg.tool_calls || [];

  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
      ? content.map((c) => (typeof c === "string" ? c : c?.text ?? JSON.stringify(c))).join("\n")
      : JSON.stringify(content);

  const toolUseBlocks = tool_calls.map((tc) => {
    const id = tc.id || rid("toolu_");
    const name = tc.function?.name || "tool";
    const argsRaw = tc.function?.arguments;
    let input;
    try {
      input = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw || {};
    } catch {
      input = { _raw: argsRaw };
    }
    return { type: "tool_use", id, name, input };
  });

  const blocks = [];
  if (shouldMapReasoning(env) && typeof msg.reasoning === "string" && msg.reasoning.trim()) {
    blocks.push({ type: "thinking", thinking: msg.reasoning, signature: "" });
  }
  if (text && String(text).trim()) blocks.push({ type: "text", text: String(text) });
  for (const tb of toolUseBlocks) blocks.push(tb);

  const hasTools = toolUseBlocks.length > 0;

  let usageAnthropic = mapUsageFromOpenRouter(orjson.usage || {});
  if (shouldEstimateUsage(env) && usageAnthropic.input_tokens === 0 && usageAnthropic.output_tokens === 0) {
    usageAnthropic = {
      input_tokens: inputTokensEstimate != null ? inputTokensEstimate : 0,
      output_tokens: estimateOutputTokensFromText(text, env),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }

  const modelUsedRaw = orjson.model || payload.model || "openrouter";
  const stableModel = mapModel(modelUsedRaw);

  const pricing = parseJSON(env.PRICING_JSON, {});
  const costUSD = computeCostUSD(usageAnthropic, stableModel, pricing);
  const totalTokens = usageAnthropic.input_tokens + usageAnthropic.output_tokens;
  const tps = totalTokens > 0 && durationMs > 0 ? totalTokens / (durationMs / 1000) : null;

  const extraHeaders = {
    "X-OR-Model": stableModel,
    "X-OR-Prompt-Tokens": String(usageAnthropic.input_tokens),
    "X-OR-Completion-Tokens": String(usageAnthropic.output_tokens),
    "X-OR-Total-Tokens": String(totalTokens),
    "X-OR-Duration-MS": String(durationMs),
  };
  if (tps != null) extraHeaders["X-OR-TPS"] = String(tps.toFixed(1));
  if (typeof orjson.usage?.cost === "number") extraHeaders["X-OR-Cost-Credits"] = String(orjson.usage.cost);
  if (typeof orjson.usage?.cost_details?.upstream_inference_cost === "number")
    extraHeaders["X-OR-Upstream-Cost"] = String(orjson.usage.cost_details.upstream_inference_cost);
  if (costUSD) extraHeaders["X-OR-Cost-USD"] = String(costUSD.total.toFixed(6));

  const out = {
    id: orjson.id || rid("msg_"),
    type: "message",
    role: "assistant",
    model: stableModel,
    content: blocks.length ? blocks : [{ type: "text", text: "" }],
    stop_reason: mapStopReason(finish, hasTools),
    stop_sequence: null,
    usage: usageAnthropic,
  };

  return { out, headers: extraHeaders };
}
