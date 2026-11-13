// Loaded explicitly by rex-hub-smoke.ts, in its parent and (via childExtensions) its
// children. Fixed responses only; never deploy this fixture as an extension.
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "../../extensions/workflows/process.ts";

export default function (pi: ExtensionAPI) {
  // Rex starts terminals with its server's environment; the agent directory is passed explicitly.
  if (!process.env.PI_CODING_AGENT_DIR?.includes("/pi-rex-hub-smoke-")) throw new Error("Rex hub provider requires the hub smoke test's isolated agent directory");
  globalThis.fetch = async () => { throw new Error("Network access forbidden in Rex hub fixture"); };
  pi.registerProvider("rex-smoke", {
    baseUrl: "https://invalid.example", apiKey: "test-only-not-a-credential", api: "rex-smoke",
    models: [{ id: "fixture", name: "Rex hub fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream(), last: any = context.messages.at(-1), seen = JSON.stringify(last);
      const output: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
        timestamp: Date.now(), stopReason: "pending", content: [], usage: { ...emptyUsage(), cost: { ...emptyUsage().cost, total: 0.0123 } } };
      let timer: ReturnType<typeof setTimeout> | undefined, finished = false;
      const text = (body: string) => {
        const block = { type: "text" as const, text: body }; output.content.push(block);
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: body, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: body, partial: output });
        output.stopReason = "stop"; stream.push({ type: "done", reason: "stop", message: output }); stream.end();
      };
      const finish = () => {
        if (finished) return; finished = true;
        if (timer) clearTimeout(timer);
        if (options?.signal?.aborted) { output.stopReason = "aborted"; output.errorMessage = "Cancelled"; stream.push({ type: "error", reason: "aborted", error: output }); stream.end(); return; }
        stream.push({ type: "start", partial: output });
        // Parent: one prompt starts two children, a long one and a quick one.
        if (!process.env.PI_REX_CHILD && last?.role === "user" && seen.includes("Spawn hub fixture")) {
          const calls = [
            { type: "toolCall" as const, id: "hub-1", name: "rex_agent", arguments: { agent: "scout", name: "birch", title: "Hold fixture", task: "Hold fixture: wait until cancelled" } },
            { type: "toolCall" as const, id: "hub-2", name: "rex_agent", arguments: { agent: "scout", name: "cedar", title: "Quick fixture", task: "Answer at once" } },
          ];
          output.content.push(...calls); output.stopReason = "toolUse";
          calls.forEach((call, i) => { stream.push({ type: "toolcall_start", contentIndex: i, partial: output }); stream.push({ type: "toolcall_end", contentIndex: i, toolCall: call, partial: output }); });
          stream.push({ type: "done", reason: "toolUse", message: output }); stream.end(); return;
        }
        if (!process.env.PI_REX_CHILD) return text(last?.role === "toolResult" ? "Children started." : "Parent fixture idle.");
        text(`## Fixture result\n\nThe child answered **without a model request**.\n\n- one\n- two\n\nMessages: ${context.messages.length}.`);
      };
      options?.signal?.addEventListener("abort", finish, { once: true });
      // A held child task runs until cancelled (or two minutes pass).
      if (process.env.PI_REX_CHILD && seen.includes("Hold fixture") && !options?.signal?.aborted) timer = setTimeout(finish, 120_000);
      else queueMicrotask(finish);
      return stream;
    },
  });
}
