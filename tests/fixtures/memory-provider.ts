// Loaded explicitly by memory.test.ts. Never deploy this fixture as an extension.
// Answers every request with what the memory extension put in front of it;
// "lookup" and "write" call the memory tool instead.
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
      const last: any = context.messages.at(-1);
      const said = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((c: any) => c.text ?? "").join("");
      // "lookup" and "write" call the memory tool; its result is echoed back.
      const call = last?.role === "user" && /^(lookup|write)$/.test(said.trim())
        ? { type: "toolCall" as const, id: `memory-${Date.now()}`, name: "memory", arguments: said.trim() === "lookup" ? { action: "define", term: "PRR" } : { action: "jot", text: "Staging needs the VPN." } }
        : undefined;
      if (call || last?.role === "toolResult") {
        queueMicrotask(() => {
          stream.push({ type: "start", partial: output });
          if (call) {
            output.content.push(call);
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
            output.stopReason = "toolUse";
          } else {
            const text = `TOOL ${last.isError ? "ERROR" : "OK"} ${last.content.map((c: any) => c.text).join(" ").replace(/\s+/g, " ")}`;
            output.content.push({ type: "text", text });
            stream.push({ type: "text_start", contentIndex: 0, partial: output });
            stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
          }
          stream.push({ type: "done", reason: output.stopReason as "stop", message: output }); stream.end();
        });
        return stream;
      }
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
