import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { patchMarkdown, rereviewNotice } from "./patch.ts";

export default function (pi: ExtensionAPI) {
  const status = patchMarkdown(Markdown);
  let notified = false;

  pi.on("session_start", (_event, ctx) => {
    if (notified || ctx.mode !== "tui") return;
    if (process.env.PI_REX_CHILD || process.env.PI_WORKFLOW_CHILD_CONFIG) return;
    const notice = rereviewNotice(status);
    if (!notice) return;
    notified = true;
    ctx.ui.notify(notice, "info");
  });
}
