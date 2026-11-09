import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerChild } from "./child.ts";
import { displayTaskPrompt, type Manifest } from "./protocol.ts";
import { childFooter } from "./ui.ts";

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
    // One line instead of Pi's three: the pane label already names the child,
    // task, cwd and branch, and a deck slot is only ~20 rows tall.
    ctx.ui.setFooter((tui, theme, footerData) => {
      const off = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: off, invalidate() {},
        render(width: number) {
          let input = 0, output = 0, cost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type !== "message" || e.message.role !== "assistant") continue;
            const u = (e.message as any).usage; input += u?.input ?? 0; output += u?.output ?? 0; cost += u?.cost?.total ?? 0;
          }
          const statuses = [...footerData.getExtensionStatuses().entries()];
          const own = statuses.find(([k]) => k === "rex-child")?.[1], others = statuses.filter(([k]) => k !== "rex-child").map(([, v]) => v);
          const { left, right } = childFooter({ status: [own, ...others].filter(Boolean).join(" · "), input, output, cost,
            percent: ctx.getContextUsage()?.percent ?? undefined, model: ctx.model?.id ?? m.role.model, thinking: pi.getThinkingLevel() });
          const l = theme.fg("muted", left), r = theme.fg("dim", right), gap = width - visibleWidth(l) - visibleWidth(r);
          return [gap >= 1 ? l + " ".repeat(gap) + r : truncateToWidth(`${l} ${r}`, width)];
        },
      };
    });
  });
  // Display-only: the model still receives the exact delegated framing.
  pi.registerMarkdownTransformer((markdown, { messageType }) => messageType === "user" ? displayTaskPrompt(markdown, label) : markdown);
  pi.registerMessageRenderer("rex-parent", (message, options, theme) => {
    const body = String(message.content).replace(/^Parent agent message for task [a-f0-9-]+:\n/, "");
    return new Text(`${theme.fg("accent", "↳ Parent")} ${body}`, options.outputPad, 0);
  });
}
