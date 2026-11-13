// The memory extension's behavior, apart from its TUI renderer so that it
// can be tested without Pi's packages.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Loaded, load, matches, SECTION, section, TERMS_TYPE, termId, termsMessage, wikiBinary } from "./context.ts";

export type Details = { terms: string[]; names: string[] };

/** Terms already defined in what the model sees; compaction can drop them, and then they return. */
export function seenTerms(entries: readonly any[]): Set<string> {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry?.type === "custom_message" && entry.customType === TERMS_TYPE) for (const id of (entry.details as Details | undefined)?.terms ?? []) seen.add(id);
  }
  return seen;
}

export function status(loaded: Loaded | undefined, binary: string, seen: ReadonlySet<string>): string {
  if (!loaded) return "Memory wiki: not loaded yet in this session.";
  if (!loaded.context) return `Memory wiki: nothing loaded (${loaded.error}).`;
  const c = loaded.context;
  const lines = [c.scope ? `Scope: ${c.scope} (${c.reason})` : `No scope: ${c.reason}`];
  for (const page of c.now) {
    const flags = [page.stale && "stale", page.truncated && "cut off"].filter(Boolean).join(", ");
    lines.push(`Current context: ${page.ref}, ${page.bytes}/${page.limit} bytes, refresh due ${page.staleAfter?.slice(0, 10) ?? "never"}${flags ? ` (${flags})` : ""}`);
  }
  if (!c.now.length) lines.push(`Current context: none${c.scope && c.scope !== "shared" ? `; fill in now.md in the ${c.scope} bundle (\`${binary} -scope ${c.scope} init\` creates it if missing)` : ""}`);
  const defined = c.terms.filter(t => seen.has(termId(t))).map(t => t.term);
  lines.push(`Glossary: ${c.terms.length} terms in view; ${defined.length ? `defined in context: ${defined.join(", ")}` : "none defined in context yet"}`);
  lines.push(`Binary: ${binary}`);
  return lines.join("\n");
}

export function register(pi: ExtensionAPI, binary = wikiBinary()) {
  let last: Loaded | undefined;
  let warned = new Set<string>();
  const warnOnce = (ctx: ExtensionContext, key: string, message: string) => {
    if (warned.has(key) || !ctx.hasUI) return;
    warned.add(key);
    ctx.ui.notify(message, "warning");
  };

  pi.on("session_start", () => { last = undefined; warned = new Set(); });

  pi.on("before_agent_start", async (event, ctx) => {
    const options = event.systemPromptOptions;
    last = await load(binary, ctx.cwd);
    const context = last.context;
    const text = context && section(context, binary);
    if (options.sections) {
      if (text) options.sections[SECTION] = text;
      else delete options.sections[SECTION];
    }
    if (!context) {
      // A machine without the wiki is not an error; a broken one is.
      if (!last.missing || process.env.LLM_WIKI_SCOPE) warnOnce(ctx, "error", `Memory wiki not loaded: ${last.error}`);
      return;
    }
    for (const page of context.now) {
      if (page.stale) warnOnce(ctx, `stale:${page.ref}`, `${page.ref} was due for a refresh on ${page.staleAfter?.slice(0, 10)}. Ask to update it, or edit it.`);
      if (page.truncated) warnOnce(ctx, `long:${page.ref}`, `${page.ref} is ${page.bytes} bytes, over its ${page.limit}-byte limit; the rest was not loaded.`);
    }
    if (event.messageType !== "user" || !event.prompt) return;
    const found = matches(event.prompt, context.terms, seenTerms(ctx.sessionManager.buildContextEntries()));
    if (!found.length) return;
    const details: Details = { terms: found.map(termId), names: found.map(t => t.term) };
    return { message: { customType: TERMS_TYPE, content: termsMessage(found), display: true, details } };
  });

  pi.registerCommand("memory", {
    description: "Show what the memory wiki loads into this session",
    handler: async (_args, ctx) => {
      last ??= await load(binary, ctx.cwd);
      const report = status(last, binary, seenTerms(ctx.sessionManager.buildContextEntries()));
      if (ctx.hasUI) ctx.ui.notify(report, "info");
      else console.log(report);
    },
  });
}
