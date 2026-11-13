function parseSseChunk(chunk: string): Record<string, unknown> | undefined {
  const dataLines: string[] = [];
  for (const line of chunk.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  const data = dataLines.join("\n");
  if (!data || data === "[DONE]") return;
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return;
  }
}

export async function* readSseJson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const event = parseSseChunk(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (event) yield event;
        idx = buffer.indexOf("\n\n");
      }
    }
    const event = parseSseChunk(buffer);
    if (event) yield event;
  } finally {
    signal?.removeEventListener("abort", abort);
    try { reader.releaseLock(); } catch {}
  }
}
