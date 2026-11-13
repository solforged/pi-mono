// Loaded explicitly by memory.test.ts. Never deploy this fixture as an extension.
// Answers every request with what the memory extension put in front of it.
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "../../extensions/workflows/process.ts";

export default function (pi: ExtensionAPI) {
  globalThis.fetch = async () => { throw new Error("Network access forbidden in memory fixture"); };
  pi.registerProvider("memory-smoke", {
    baseUrl: "https://invalid.example", apiKey: "test-only-not-a-credential", api: "memory-smoke",
    models: [{ id: "fixture", name: "Memory fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
        timestamp: Date.now(), stopReason: "stop", content: [], usage: emptyUsage() };
      const transcript = JSON.stringify(context.messages);
      const system = `${context.systemPrompt ?? ""}${transcript}`;
      const text = [
        `SECTION ${/<memory_wiki>[\s\S]*Billing runs on queues[\s\S]*<\/memory_wiki>/.test(system) ? "present" : "absent"}`,
        `DEFINITIONS ${(transcript.match(/glossary defines terms/g) ?? []).length}`,
        `PROMPTS ${(transcript.match(/PRR (?:done|owner)/g) ?? []).length}`,
      ].join(" ");
      queueMicrotask(() => {
        stream.push({ type: "start", partial: output });
        output.content.push({ type: "text", text });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        stream.push({ type: "done", reason: "stop", message: output }); stream.end();
      });
      return stream;
    },
  });
}
