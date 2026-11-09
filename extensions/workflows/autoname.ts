import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configSnapshot, type ConfigSource } from "./roles.ts";
import { completeRole } from "./requests.ts";

export async function loadTitlePrompt(root: string, agentDir: string): Promise<string> {
  try { return await readFile(join(agentDir, "TITLE_SYSTEM.md"), "utf8"); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  return readFile(join(root, "TITLE_SYSTEM.md"), "utf8");
}

export function parseTitle(text: string): string | undefined {
  const match = /^<title>([^<>\n\r]+)<\/title>$/.exec(text.trim());
  if (!match || match[1] === "none") return undefined;
  const title = match[1].trim();
  if (/[\x00-\x1f\x7f]|[.!?:;,]$/.test(title) || title.length > 100) return undefined;
  const words = title.split(/\s+/);
  return words.length >= 3 && words.length <= 7 ? title : undefined;
}
export function firstUserText(entries: any[]): string {
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    if (text.trim() && !/^(hi|hey|hello|thanks|thank you|ok|okay)[!.\s]*$/i.test(text.trim())) return text.slice(0, 6000);
  }
  return "";
}

export function registerAutoname(pi: ExtensionAPI, source: ConfigSource, prompt: string, lifetime: AbortSignal) {
  let busy = false;
  let attempted = false;
  let nameRevision = 0;
  let titleController: AbortController | undefined;
  pi.on("session_start", (_event, ctx) => {
    // Markers copied by fork/clone belong to the old session, not the new one.
    attempted = ctx.sessionManager.getEntries().some((entry: any) => entry.type === "custom" && entry.customType === "workflow-title" && entry.data?.sessionId === ctx.sessionManager.getSessionId());
  });
  pi.on("session_info_changed", () => { nameRevision++; });
  pi.on("session_tree", () => { titleController?.abort(); });

  async function generate(ctx: ExtensionContext, force: boolean) {
    if (busy || lifetime.aborted || (!force && (attempted || pi.getSessionName()))) return;
    const config = configSnapshot(source);
    const text = firstUserText(ctx.sessionManager.getBranch());
    if (!text) return;
    busy = true;
    titleController = new AbortController();
    const signal = AbortSignal.any([lifetime, titleController.signal]);
    const sessionId = ctx.sessionManager.getSessionId();
    const previous = pi.getSessionName();
    const revision = nameRevision;
    try {
      attempted = true;
      pi.appendEntry("workflow-title", { sessionId, attempted: true });
      const result = await completeRole(ctx, config, "tiny", prompt, text, signal);
      signal.throwIfAborted();
      const title = parseTitle(result.text);
      if (ctx.sessionManager.getSessionId() !== sessionId || nameRevision !== revision || pi.getSessionName() !== previous) return;
      pi.appendEntry("workflow-usage", { role: "tiny", ...result, text: undefined });
      if (title) pi.setSessionName(title);
      else if (force && ctx.hasUI) ctx.ui.notify("No valid task title generated", "info");
    } catch (error) {
      if (!signal.aborted && ctx.hasUI) ctx.ui.notify(`Automatic naming skipped: ${String(error)}`, "warning");
    } finally { busy = false; titleController = undefined; }
  }
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "user" || !configSnapshot(source).autoname || ctx.mode !== "tui") return;
    // Pi persists the message after extension handlers return; wait so the branch includes it.
    setTimeout(() => { void generate(ctx, false); }, 0);
  });
  pi.registerCommand("autoname", {
    description: "Generate a session title using the tiny role; leaves the main model unchanged",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error("/autoname requires interactive approval when replacing a title");
      if (pi.getSessionName() && !await ctx.ui.confirm("Replace session title?", pi.getSessionName()!)) return;
      await generate(ctx, true);
    },
  });
}
