// Explicitly loaded only by the regression suite, beside every repo extension
// that registers tools. No model or network calls.
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { declarationSize, measure, owner } from "../../extensions/prompt-size/measure.ts";

// Every request carries these declarations. Raise a budget only deliberately.
export const BUDGETS: Record<string, number> = {
  artifact_read: 500, ask_user_question: 960, intercom: 480, rex_agent: 640, rex_result: 440, rex_send: 560, session_read: 620,
  session_search: 520, subagent: 560, todo: 420, web_search: 400,
};
// Tools whose prompt guidelines are deliberate (see docs/ask.md); others put guidance in the description.
const GUIDED = new Set(["ask_user_question"]);

export default function (pi: ExtensionAPI) {
  pi.registerCommand("prompt-size-smoke", {
    description: "Check repo tool declaration budgets and the delegation tool switch",
    handler: async (_args, ctx) => {
      const ours = pi.getAllTools().filter(t => owner(t) !== "pi");
      assert.deepEqual(ours.map(t => t.name).sort(), Object.keys(BUDGETS).sort());
      for (const tool of ours) {
        assert.ok(declarationSize(tool) <= BUDGETS[tool.name], `${tool.name} declaration grew to ${declarationSize(tool)} characters`);
        assert.ok(GUIDED.has(tool.name) || !tool.promptGuidelines?.length, `${tool.name} adds prompt guidelines`);
      }
      // Outside Rex, the Rex tools give way to subagent.
      const active = pi.getActiveTools();
      assert.ok(active.includes("subagent") && !active.some(n => n.startsWith("rex_")), active.join());
      const m = measure(ctx.getSystemPrompt(), pi.getAllTools().filter(t => active.includes(t.name)));
      assert.ok(m.sections.some(s => s.name === "tools"));
      // Repo tools add no rule or tool-list lines; their descriptions carry the guidance.
      const listed = ctx.getSystemPrompt().match(/<(rules|tools)>[\s\S]*?<\/\1>/g)?.join("\n") ?? "";
      for (const name of Object.keys(BUDGETS).filter(n => !GUIDED.has(n))) assert.ok(!listed.includes(name), `${name} appears in the rules or tool list`);
      console.log(`Prompt size: ${ours.length} tool budgets, the delegation switch and measurement passed (${m.total} characters)`);
    },
  });
}
