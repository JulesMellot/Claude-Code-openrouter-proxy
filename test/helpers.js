/** Build a ReadableStream that emits the given string chunks (encoded). */
export function streamFromChunks(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

/** Drain a ReadableStream<Uint8Array> to a string. */
export async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** Parse raw Anthropic SSE text into [{event, data}]. */
export function parseSSE(raw) {
  const events = [];
  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n");
    let event = null;
    let data = null;
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        try {
          data = JSON.parse(payload);
        } catch {
          data = payload;
        }
      }
    }
    if (event) events.push({ event, data });
  }
  return events;
}
