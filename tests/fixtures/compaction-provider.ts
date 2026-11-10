// Loaded explicitly by compaction-smoke.ts. Never deploy this fixture as an extension.
// A slow agent that reads one large file per turn, and a slower summarizer, so a smoke
// run shows how long compaction blocks the run. Every request is logged with its time.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { emptyUsage } from "../../extensions/workflows/process.ts";

import { FILE_CHARS, SUMMARY_MS, TURN_MS, TURNS } from "./compaction-script.ts";

const textOf = (content: any) => typeof content === "string" ? content : (content ?? []).map((c: any) => c.text ?? c.thinking ?? JSON.stringify(c.arguments ?? "")).join("");

export default function (pi: ExtensionAPI) {
  const log = process.env.PI_COMPACTION_LOG;
  if (!log) throw new Error("The compaction provider needs PI_COMPACTION_LOG from compaction-smoke.ts");
  const record = (value: object) => appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...value })}\n`);
  globalThis.fetch = async () => { throw new Error("Network access forbidden in compaction fixture"); };

  pi.registerTool({
    name: "read_file", label: "Read file", description: "Fixture tool. Returns a large file.",
    parameters: Type.Object({ n: Type.Number() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `file ${params.n}: ${"x".repeat(FILE_CHARS)}` }], details: {} };
    },
  });

  pi.registerProvider("compaction", {
    baseUrl: "https://invalid.example", apiKey: "test-only-not-a-credential", api: "compaction-fixture",
    models: [{ id: "fixture", name: "Compaction fixture", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 30_000, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
        timestamp: Date.now(), stopReason: "stop", content: [], usage: emptyUsage() };
      // Summaries carry no tool declarations.
      const agent = getCurrentTools(context.messages).length > 0;
      const summarized = context.messages.some((m: any) => m.role === "user" && /FIXTURE SUMMARY/.test(textOf(m.content)));
      const chars = context.messages.reduce((sum: number, m: any) => sum + textOf(m.content).length, 0);
      record({ t: agent ? "agent" : "summary", reasoning: options?.reasoning, reads: countReads(context.messages), summarized, tokens: Math.ceil(chars / 4) });
      const finish = () => {
        if (options?.signal?.aborted) {
          output.stopReason = "aborted"; output.errorMessage = "Cancelled";
          stream.push({ type: "error", reason: "aborted", error: output }); stream.end(); return;
        }
        if (agent && countReads(context.messages) < TURNS) {
          const n = countReads(context.messages) + 1;
          const call = { type: "toolCall" as const, id: `call-${n}`, name: "read_file", arguments: { n } };
          output.content.push(call); output.stopReason = "toolUse";
        } else output.content.push({ type: "text", text: agent ? "DONE" : "FIXTURE SUMMARY" });
        output.usage.input = Math.ceil(chars / 4); output.usage.totalTokens = output.usage.input;
        stream.push({ type: "start", partial: output });
        stream.push({ type: "done", reason: output.stopReason as "stop", message: output }); stream.end();
        if (!agent) record({ t: "summary_end" });
      };
      setTimeout(finish, agent ? TURN_MS : SUMMARY_MS);
      return stream;
    },
  });
}

// Reads already made in this run, counted from tool call ids so compaction cannot reset them.
function countReads(messages: any[]) {
  let highest = 0;
  for (const m of messages) for (const c of m.role === "assistant" ? m.content ?? [] : []) {
    const n = c.type === "toolCall" ? Number(String(c.id).replace("call-", "")) : 0;
    if (n > highest) highest = n;
  }
  return highest;
}
