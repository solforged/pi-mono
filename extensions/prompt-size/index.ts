// /prompt-size: what every request carries before any conversation. Also drops
// Pi rules that repeat a tool's description from every prompt.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dropRepeatedRules, measure, owner, report, withoutRepeatedRules } from "./measure.ts";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", event => { dropRepeatedRules(event.systemPromptOptions.toolGuidelines); });

  pi.registerCommand("prompt-size", {
    description: "Show the size of the system prompt and active tool declarations sent with every request",
    handler: async (_args, ctx) => {
      const active = new Set(pi.getActiveTools());
      const all = pi.getAllTools();
      // Pi's own inactive tools (powershell, codemode, ...) are opt-in, so only extension tools are listed.
      const inactive = all.filter(t => !active.has(t.name) && owner(t) !== "pi");
      const text = report(measure(withoutRepeatedRules(ctx.getSystemPrompt()), all.filter(t => active.has(t.name)), inactive));
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });
}
