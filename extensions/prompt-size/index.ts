// /prompt-size: what every request carries before any conversation. Also drops
// Pi rules that repeat a tool's description from every prompt.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { report as say } from "../shared/context.ts";
import { dropRepeatedRules, measure, owner, report, withoutRepeatedRules } from "./measure.ts";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", event => { dropRepeatedRules(event.systemPromptOptions.toolGuidelines); });

  // Extensions add sections (memory, sandbox, deferred tools) when a run
  // starts, and Pi forgets them when it ends, so the last run's prompt is kept.
  let sent: string | undefined;
  pi.on("agent_start", (_event, ctx) => { sent = ctx.getSystemPrompt(); });

  pi.registerCommand("prompt-size", {
    description: "Show the size of the system prompt and active tool declarations sent with every request",
    handler: async (_args, ctx) => {
      const active = new Set(pi.getActiveTools());
      const all = pi.getAllTools();
      // Pi's own inactive tools (powershell, codemode, ...) are opt-in, so only extension tools are listed.
      const inactive = all.filter(t => !active.has(t.name) && owner(t) !== "pi");
      const text = report(measure(withoutRepeatedRules(sent ?? ctx.getSystemPrompt()), all.filter(t => active.has(t.name)), inactive), sent !== undefined);
      say(ctx, text);
    },
  });
}
