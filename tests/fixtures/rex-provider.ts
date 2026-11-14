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
      const last: any = _context.messages.at(-1);
      // "Todo progress fixture": list three steps, finish one, then keep working until cancelled.
      const users = _context.messages.map((m, i) => m.role === "user" ? i : -1).filter(i => i >= 0), lastUser = users.at(-1) ?? -1;
      const todoStep = lastUser >= 0 && JSON.stringify(_context.messages[lastUser]).includes("Todo progress fixture")
        ? _context.messages.slice(lastUser).filter(m => m.role === "toolResult").length : -1;
      const waiting = JSON.stringify(last).includes("Wait for cancellation fixture") || todoStep >= 2;
      const asking = lastUser >= 0 && JSON.stringify(_context.messages[lastUser]).includes("Ask the user fixture") && last?.role !== "toolResult";

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
        const tool = asking ? { name: "ask_user_question", arguments: { questions: [{ question: "Pick one?", options: [{ label: "Alpha" }, { label: "Beta" }] }] } }
          : todoStep === 0 ? { name: "todo", arguments: { action: "add", items: ["Read", "Change", "Check"] } }
          : todoStep === 1 ? { name: "todo", arguments: { action: "update", id: 1, status: "done" } } : undefined;
        if (tool) {
          const call = { type: "toolCall" as const, id: `call-${Date.now()}`, ...tool };
          output.content.push(call); output.stopReason = "toolUse";
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
          stream.push({ type: "done", reason: "toolUse", message: output }); stream.end(); return;
        }
        const block = { type: "text" as const, text: "" }; output.content.push(block);
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        block.text = last.role === "toolResult" ? `Rex fixture asked. ${JSON.stringify(last.content)}`
          : `Rex fixture completed without a model request. User messages: ${_context.messages.filter(m => m.role === "user").length}.`;
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
