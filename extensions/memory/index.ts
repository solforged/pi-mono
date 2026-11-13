// Keeps the memory wiki's small always-on layer in front of the model: each
// bundle's now.md in the system prompt, and a glossary entry the first time a
// prompt uses its term. Everything else in the wiki stays on demand. Nothing
// here writes to the wiki. See docs/memory.md.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { TERMS_TYPE } from "./context.ts";
import { type Details, register } from "./session.ts";

export default function (pi: ExtensionAPI) {
  register(pi);
  pi.registerMessageRenderer(TERMS_TYPE, (message, options, theme) => {
    const names = (message.details as Details | undefined)?.names ?? [];
    let text = theme.fg("dim", "◇ ") + theme.fg("muted", `Glossary: ${names.join(", ") || "terms"}`);
    if (options.expanded) text += "\n" + theme.fg("dim", String(message.content));
    return new Text(text, options.outputPad, 0);
  });
}
