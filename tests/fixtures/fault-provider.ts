// Loaded explicitly by fault-smoke.ts. Never deploy this fixture as an extension.
// Replays one scripted scenario from fault-scenarios.ts and records what Pi sent on each request.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { emptyUsage } from "../../extensions/workflows/process.ts";
import { DONE, SCENARIOS, TOOL, type Step } from "./fault-scenarios.ts";

const clip = (text: string, limit = 160) => text.length > limit ? `${text.slice(0, limit)}…` : text;
const textOf = (content: any) => typeof content === "string" ? content : (content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
// Enough to check pairing and duplication; the scripted texts are short.
const outline = (m: any) => m.role === "assistant" ? { role: m.role, stop: m.stopReason, error: m.errorMessage && clip(m.errorMessage, 60), text: clip(textOf(m.content)),
    thinking: (m.content ?? []).some((c: any) => c.type === "thinking") || undefined, calls: (m.content ?? []).filter((c: any) => c.type === "toolCall").map((c: any) => ({ id: c.id, name: c.name })) }
  : m.role === "toolResult" ? { role: m.role, id: m.toolCallId, name: m.toolName, isError: m.isError, text: clip(textOf(m.content)) }
  : m.role === "system" ? { role: m.role } : { role: m.role, type: m.customType, text: clip(textOf(m.content)) };

export default function (pi: ExtensionAPI) {
  const log = process.env.PI_FAULT_LOG, scenario = SCENARIOS.find(s => s.name === process.env.PI_FAULT_SCENARIO);
  if (!log || !scenario) throw new Error("The fault provider needs PI_FAULT_SCENARIO and PI_FAULT_LOG from fault-smoke.ts");
  const steps = scenario.phases[Number(process.env.PI_FAULT_PHASE ?? 0)]?.steps ?? [];
  const record = (value: object) => appendFileSync(log, `${JSON.stringify(value)}\n`);
  // A regression must fail rather than contact any provider.
  globalThis.fetch = async () => { throw new Error("Network access forbidden in fault fixture"); };
  let requests = 0;

  pi.registerTool({
    name: TOOL, label: "Probe", description: "Fixture tool. Echoes its value.",
    parameters: Type.Object({ value: Type.String() }),
    async execute(id, params) {
      record({ t: "exec", id, value: params.value });
      return { content: [{ type: "text", text: `probe:${params.value}` }], details: {} };
    },
  });

  pi.registerProvider("fault", {
    baseUrl: "https://invalid.example", apiKey: "test-only-not-a-credential", api: "fault",
    models: [{ id: "fixture", name: "Fault fixture", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
        timestamp: Date.now(), stopReason: "pending", content: [], usage: emptyUsage() };
      // Requests without tool declarations are summaries and the like; they do not consume the script.
      const agent = getCurrentTools(context.messages).length > 0;
      const step: Step = agent ? steps[requests] ?? { text: DONE } : { text: "FIXTURE SUMMARY" };
      record({ t: "request", n: agent ? requests++ : -1, messages: context.messages.map(outline) });
      queueMicrotask(() => {
        const fail = (reason: "error" | "aborted", message: string) => {
          output.stopReason = reason; output.errorMessage = message;
          stream.push({ type: "error", reason, error: output }); stream.end();
        };
        if (options?.signal?.aborted) return fail("aborted", "Cancelled");
        const bare = step.error && !step.thinking && !step.text && !step.calls;
        if (!bare) stream.push({ type: "start", partial: output });
        const add = (block: any) => output.content.push(block) - 1;
        if (step.thinking) {
          const index = add({ type: "thinking", thinking: step.thinking });
          stream.push({ type: "thinking_start", contentIndex: index, partial: output });
          stream.push({ type: "thinking_delta", contentIndex: index, delta: step.thinking, partial: output });
          // A stream that dies mid-block never closes it.
          if (!(step.error && !step.text && !step.calls)) stream.push({ type: "thinking_end", contentIndex: index, content: step.thinking, partial: output });
        }
        if (step.text) {
          const index = add({ type: "text", text: step.text });
          stream.push({ type: "text_start", contentIndex: index, partial: output });
          stream.push({ type: "text_delta", contentIndex: index, delta: step.text, partial: output });
          if (!(step.error && !step.calls)) stream.push({ type: "text_end", contentIndex: index, content: step.text, partial: output });
        }
        for (const call of step.calls ?? []) {
          const block = { type: "toolCall" as const, id: call.id, name: call.name ?? TOOL, arguments: call.args as any };
          const index = add(block);
          stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
        }
        if (step.error) return fail("error", step.error);
        output.stopReason = step.stop ?? (step.calls ? "toolUse" : "stop");
        if (step.stop === "length") output.usage.output = output.usage.totalTokens = step.output ?? model.maxTokens;
        stream.push({ type: "done", reason: output.stopReason as "stop", message: output }); stream.end();
      });
      return stream;
    },
  });
}
