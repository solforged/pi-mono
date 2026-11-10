// Loaded explicitly by tests/worktree.test.ts. Never deploy this fixture as an extension.
// A scripted model: enter a worktree, then write a file once the session has moved.
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "../../extensions/workflows/process.ts";

export default function (pi: ExtensionAPI) {
  globalThis.fetch = async () => { throw new Error("Network access forbidden in the worktree fixture"); };
  // Print mode has no /name; this stands in for a manual or automatic title.
  pi.registerCommand("fixture-name", { handler: async (args) => { pi.setSessionName(args.trim()); } });
  pi.registerProvider("worktree-smoke", {
    baseUrl: "https://invalid.example", apiKey: "test-only-not-a-credential", api: "worktree-smoke",
    models: [{ id: "fixture", name: "Worktree fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last: any = context.messages.at(-1);
      const text = JSON.stringify(last);
      const output: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
        timestamp: Date.now(), stopReason: "stop", content: [], usage: emptyUsage() };
      const call = (...calls: [string, Record<string, unknown>][]) => {
        calls.forEach(([name, args], index) => {
          const block = { type: "toolCall" as const, id: `${name}-${index}-${Date.now()}`, name, arguments: args };
          output.content.push(block);
          stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
        });
        output.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message: output });
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: output });
        if (last?.role === "user" && text.includes("Start the worktree fixture")) call(["enter_worktree", { name: "Fixture Task" }]);
        // A model may batch an edit with the move; that edit must not land in the main checkout.
        else if (last?.role === "user" && text.includes("Start the batched fixture")) call(["enter_worktree", { name: "Batched" }], ["write", { path: "early.txt", content: "too early\n" }]);
        // In the TUI, a first edit in the main checkout is turned back once with a hint.
        else if (last?.role === "user" && text.includes("Start the guarded fixture")) call(["write", { path: "early.txt", content: "too early\n" }], ["write", { path: "early-2.txt", content: "too early\n" }]);
        else if (last?.role === "toolResult" && text.includes("call enter_worktree first")) call(["enter_worktree", { name: "Guarded" }]);
        else if (text.includes("Session moved to the worktree")) call(["write", { path: "made.txt", content: "from the worktree\n" }]);
        else {
          const block = { type: "text" as const, text: `Worktree fixture done after ${last?.role}.` };
          output.content.push(block);
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: output });
          stream.push({ type: "done", reason: "stop", message: output });
        }
        stream.end();
      });
      return stream;
    },
  });
}
