import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerChild } from "./child.ts";
import { RexClient } from "./client.ts";
import { installLeftArrow } from "./left-editor.ts";
import { displayTaskPrompt, OPENED, validateManifest, type Manifest } from "./protocol.ts";
import { setTitlePrefix } from "./title.ts";
import { childFooter } from "./ui.ts";

/** Child presentation only. Policy stays in child.ts and is unaffected by display. */
export function registerChildUi(pi: ExtensionAPI, manifestPath: string) {
  let agent = "child", label = "child";
  registerChild(pi, manifestPath, (ctx: ExtensionContext, m: Manifest) => {
    agent = m.agent ?? agent; label = m.name ?? agent;
    if (ctx.mode !== "tui") return;
    // The parent's colour on this terminal's title, so its tab and pane match the parent's.
    setTitlePrefix(m.mark ?? "");
    const home = process.env.HOME, cwd = home && m.cwd.startsWith(home) ? `~${m.cwd.slice(home.length)}` : m.cwd;
    // Replaces the generic Pi banner and key hints with what this terminal is.
    ctx.ui.setHeader((_tui, theme) => ({
      render: (width: number) => [
        truncateToWidth(`${m.mark ? `${m.mark} ` : ""}${theme.fg("accent", theme.bold(`${m.name ?? "Rex"} · ${agent}`))} ${theme.fg("dim", `· ${m.role.provider}/${m.role.model} · ${cwd}`)}`, width),
        truncateToWidth(theme.fg("dim", `Managed by the parent agent · ← on an empty prompt returns to it · approvals answer here · /take when idle · tools: ${m.tools.join(", ")}`), width),
      ],
      invalidate() {},
    }));
    // One line instead of Pi's three: the pane label already names the child,
    // task, cwd and branch, and a deck slot is only ~20 rows tall.
    ctx.ui.setFooter((tui, theme, footerData) => {
      const off = footerData.onBranchChange(() => tui.requestRender());
      let totals: { key: string; input: number; output: number; cost: number } | undefined;
      return {
        dispose: off, invalidate() {},
        render(width: number) {
          // Renders are frequent while streaming; the totals change only with the branch.
          const sm = ctx.sessionManager as any;
          const key = `${sm.getSessionId()}:${sm.getLeafId()}:${sm.getEntryCount?.() ?? sm.getEntries().length}`;
          if (totals?.key !== key) {
            totals = { key, input: 0, output: 0, cost: 0 };
            for (const e of ctx.sessionManager.getBranch()) {
              if (e.type !== "message" || e.message.role !== "assistant") continue;
              const u = (e.message as any).usage; totals.input += u?.input ?? 0; totals.output += u?.output ?? 0; totals.cost += u?.cost?.total ?? 0;
            }
          }
          const { input, output, cost } = totals;
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
  // ← on an empty prompt goes back to the parent pane, whoever owns the child now:
  // the round trip for the parent hub's "open". Display only; no protocol message.
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || !process.env.REX_BLOCK) return;
    let m: Manifest;
    try { m = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")), true); } catch { return; }
    const self = process.env.REX_BLOCK, rex = new RexClient(), marker = join(m.dir, OPENED);
    const back = async () => {
      // Only a float the parent's hub recorded is undone; the marker is consumed either way.
      let layer: string | undefined;
      try { const opened = JSON.parse(await readFile(marker, "utf8")); if (opened.block === self && typeof opened.layer === "string") layer = opened.layer; } catch {}
      await rex.returnTo(m.rexSession, self, m.parentBlock, layer, AbortSignal.timeout(10_000));
      await rm(marker, { force: true });
    };
    installLeftArrow(ctx, () => void back().catch(error => ctx.ui.notify(`Could not return to the parent: ${error instanceof Error ? error.message : String(error)}`, "error")),
      () => ctx.ui.notify("Press ← again to return to the parent", "info"));
  });
  // Display-only: the model still receives the exact delegated framing.
  pi.registerMarkdownTransformer((markdown, { messageType }) => messageType === "user" ? displayTaskPrompt(markdown, label) : markdown);
  pi.registerMessageRenderer("rex-parent", (message, options, theme) => {
    const body = String(message.content).replace(/^Parent agent message for task [a-f0-9-]+:\n/, "");
    return new Text(`${theme.fg("accent", "↳ Parent")} ${body}`, options.outputPad, 0);
  });
}
