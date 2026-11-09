// Loaded explicitly by ask-smoke.ts. Never deploy this fixture as an extension.
// "go" or "again" asks two questions ("mixed" adds a read after the ask); a tool result is echoed; "dump" reports
// whether the decision ledger is in context; "tools" lists active tools;
// anything else (such as a compaction request) gets a stub.
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "../../extensions/workflows/process.ts";

export const QUESTIONS = [
  { question: "Which database should the service use?", header: "Database", recommended: 1, options: [
    { label: "SQLite", description: "Single file, no server" },
    { label: "Postgres", description: "Server, concurrent writers", preview: "```yaml\ndb:\n  url: postgres://localhost/app\n```" },
  ] },
  { question: "Which caches should we add?", header: "Caches", multi: true, options: [
    { label: "HTTP", description: "Response cache" }, { label: "Query", description: "ORM query cache" }, { label: "None" },
  ] },
];

export default function (pi: ExtensionAPI) {
  globalThis.fetch = async () => { throw new Error("Network access forbidden in ask smoke fixture"); };
  pi.registerProvider("ask-smoke", {
    baseUrl: "https://invalid.example", apiKey: "test-only-not-a-credential", api: "ask-smoke",
    models: [{ id: "fixture", name: "Ask smoke fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last: any = context.messages.at(-1);
      const output: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
        timestamp: Date.now(), stopReason: "pending", content: [], usage: emptyUsage() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: output });
        const content = last?.content ?? "", said = (typeof content === "string" ? content : content.map((c: any) => c.text ?? "").join("")).trim();
        if (last?.role === "toolResult" || !["go", "again", "mixed"].includes(said)) {
          const text = last?.role === "toolResult" ? `FIXTURE ECHO ${last.content.map((c: any) => c.text).join(" ").replace(/\s+/g, " ")}`
            : said === "dump" ? `FIXTURE LEDGER ${JSON.stringify(context.messages).includes("Decisions the user made earlier") ? "present" : "absent"}`
            : said === "tools" ? `FIXTURE TOOLS ${getCurrentTools(context.messages).map((tool: any) => tool.name).join(",")}`
            : "FIXTURE SUMMARY";
          output.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
          output.stopReason = "stop";
        } else {
          const call = { type: "toolCall" as const, id: `ask-${Date.now()}`, name: "ask_user_question", arguments: { questions: QUESTIONS } };
          const calls = said === "mixed" ? [call, { type: "toolCall" as const, id: `read-${Date.now()}`, name: "read", arguments: { path: "README.md" } }] : [call];
          calls.forEach((block, index) => {
            output.content.push(block);
            stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
            stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
          });
          output.stopReason = "toolUse";
        }
        stream.push({ type: "done", reason: output.stopReason as "stop", message: output }); stream.end();
      });
      return stream;
    },
  });
}
