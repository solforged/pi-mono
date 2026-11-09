import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { registerChild } from "./child.ts";
import { displayTaskPrompt, type Manifest } from "./protocol.ts";

/** Child presentation only. Policy stays in child.ts and is unaffected by display. */
export function registerChildUi(pi: ExtensionAPI, manifestPath: string) {
  let agent = "child", label = "child";
  registerChild(pi, manifestPath, (ctx: ExtensionContext, m: Manifest) => {
    agent = m.agent ?? agent; label = m.name ?? agent;
    if (ctx.mode !== "tui") return;
    const home = process.env.HOME, cwd = home && m.cwd.startsWith(home) ? `~${m.cwd.slice(home.length)}` : m.cwd;
    // Replaces the generic Pi banner and key hints with what this terminal is.
    ctx.ui.setHeader((_tui, theme) => ({
      render: (width: number) => [
        truncateToWidth(`${theme.fg("accent", theme.bold(`${m.name ?? "Rex"} · ${agent}`))} ${theme.fg("dim", `· ${m.role.provider}/${m.role.model} · ${cwd}`)}`, width),
        truncateToWidth(theme.fg("dim", `Managed by the parent agent · tools: ${m.tools.join(", ")} · approvals answer here · /take when idle`), width),
      ],
      invalidate() {},
    }));
  });
  // Display-only: the model still receives the exact delegated framing.
  pi.registerMarkdownTransformer((markdown, { messageType }) => messageType === "user" ? displayTaskPrompt(markdown, label) : markdown);
  pi.registerMessageRenderer("rex-parent", (message, options, theme) => {
    const body = String(message.content).replace(/^Parent agent message for task [a-f0-9-]+:\n/, "");
    return new Text(`${theme.fg("accent", "↳ Parent")} ${body}`, options.outputPad, 0);
  });
}
