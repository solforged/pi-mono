// /prompt-size: what every request carries before any conversation.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { measure, report } from "./measure.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("prompt-size", {
    description: "Show the size of the system prompt and active tool declarations sent with every request",
    handler: async (_args, ctx) => {
      const active = new Set(pi.getActiveTools());
      const text = report(measure(ctx.getSystemPrompt(), pi.getAllTools().filter(t => active.has(t.name))));
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });
}
