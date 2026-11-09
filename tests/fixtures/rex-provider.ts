// Loaded explicitly by rex-smoke.ts. Never deploy this fixture as an extension.
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "../../extensions/workflows/process.ts";

export default function (pi: ExtensionAPI) {
  if (!process.env.PI_REX_CHILD) throw new Error("Rex smoke provider requires an isolated child");
  // A regression must fail rather than contact any provider.
  globalThis.fetch = async () => { throw new Error("Network access forbidden in Rex smoke fixture"); };
  pi.registerProvider("rex-smoke", {
    baseUrl: "https://invalid.example", apiKey: "test-only-not-a-credential", api: "rex-smoke",
    models: [{ id: "fixture", name: "Rex smoke fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const waiting = JSON.stringify(_context.messages.at(-1)).includes("Wait for cancellation fixture");
      let timer: ReturnType<typeof setTimeout> | undefined, finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", finish);
        const output: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
          timestamp: Date.now(), stopReason: "pending", content: [], usage: emptyUsage() };
        if (options?.signal?.aborted) {
          output.stopReason = "aborted"; output.errorMessage = "Cancelled";
          stream.push({ type: "error", reason: "aborted", error: output }); stream.end(); return;
        }
        stream.push({ type: "start", partial: output });
        const block = { type: "text" as const, text: "" }; output.content.push(block);
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        block.text = `Rex fixture completed without a model request. User messages: ${_context.messages.filter(m => m.role === "user").length}.`;
        stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: output });
        output.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message: output }); stream.end();
      };
      options?.signal?.addEventListener("abort", finish, { once: true });
      if (waiting && !options?.signal?.aborted) timer = setTimeout(finish, 10_000);
      else queueMicrotask(finish);
      return stream;
    },
  });
}
