import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configSnapshot, type ConfigSource } from "./roles.ts";
import { completeRole } from "./requests.ts";
import { recordUsage } from "./usage.ts";

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

const PERMANENT_ERROR = /insufficient_quota|usage.?limit|quota.?exceeded|billing|available balance|out of budget/i;
const TRANSIENT_ERROR = /(?<![a-z0-9])(?:408|429|5\d\d)(?![a-z0-9])|overloaded|capacity|rate.?limit|too many requests|unavailable|timed? ?out|timeout|network|connection|fetch failed|socket|ECONNRESET|ENOTFOUND|EAI_AGAIN|stream ended/i;
export const MAX_TRANSIENT_FAILURES = 3;

/** Provider outages, rate limits and timeouts; quota and billing limits are permanent. */
export function isTransientError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return !PERMANENT_ERROR.test(text) && TRANSIENT_ERROR.test(text);
}

export function registerAutoname(pi: ExtensionAPI, source: ConfigSource, prompt: string, lifetime: AbortSignal) {
  let busy = false;
  let attempted = false;
  let transientFailures = 0;
  let nameRevision = 0;
  let titleController: AbortController | undefined;
  pi.on("session_start", (_event, ctx) => {
    // Markers copied by fork/clone belong to the old session, not the new one.
    transientFailures = 0;
    attempted = ctx.sessionManager.getEntries().some((entry: any) => entry.type === "custom" && entry.customType === "workflow-title" && entry.data?.sessionId === ctx.sessionManager.getSessionId());
  });
  pi.on("session_info_changed", () => { nameRevision++; });
  pi.on("session_tree", () => { titleController?.abort(); });

  async function generate(ctx: ExtensionContext, force: boolean) {
    if (busy || lifetime.aborted || (!force && (attempted || pi.getSessionName()))) return;
    const config = configSnapshot(source);
    // An unset role turns automatic naming off; only an explicit /autoname reports it.
    if (!force && !config.roles.tiny) return;
    const text = firstUserText(ctx.sessionManager.getBranch());
    if (!text) return;
    busy = true;
    titleController = new AbortController();
    const signal = AbortSignal.any([lifetime, titleController.signal]);
    const sessionId = ctx.sessionManager.getSessionId();
    const previous = pi.getSessionName();
    const revision = nameRevision;
    const sameSession = () => ctx.sessionManager.getSessionId() === sessionId;
    // Only a response or a permanent failure uses up the one automatic attempt.
    const markAttempted = () => {
      attempted = true;
      pi.appendEntry("workflow-title", { sessionId, attempted: true });
    };
    try {
      const result = await completeRole(ctx, config, "tiny", prompt, text, signal);
      signal.throwIfAborted();
      if (!sameSession()) return;
      markAttempted();
      const title = parseTitle(result.text);
      if (nameRevision !== revision || pi.getSessionName() !== previous) return;
      recordUsage(pi, { role: "tiny", ...result, text: undefined });
      if (title) pi.setSessionName(title);
      else if (force && ctx.hasUI) ctx.ui.notify("No valid task title generated", "info");
    } catch (error) {
      if (signal.aborted || !sameSession()) return;
      const retry = !force && isTransientError(error) && ++transientFailures < MAX_TRANSIENT_FAILURES;
      if (!retry) markAttempted();
      if (ctx.hasUI) ctx.ui.notify(`Automatic naming ${retry ? "will retry on your next message" : "skipped"}: ${String(error)}`, "warning");
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
