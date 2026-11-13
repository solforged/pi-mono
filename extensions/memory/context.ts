// What the memory wiki puts in every session: its current context (each
// bundle's now.md) in the system prompt, and a glossary entry the first time
// a prompt uses the term. `wiki context` in the wiki repository resolves the
// scope and parses the bundles; this module only shapes what it prints.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const SECTION = "memory_wiki";
export const TERMS_TYPE = "memory-terms";

export type NowPage = { ref: string; bundle?: string; text: string; bytes: number; limit: number; truncated: boolean; stale: boolean; staleAfter?: string };
export type Term = { bundle?: string; term: string; aliases?: string[]; definition: string };
export type WikiContext = { scope: string; reason: string; bundles: { name?: string; root: string }[]; now: NowPage[]; terms: Term[] };

export function wikiDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.LLM_WIKI_DIR;
  return dir && isAbsolute(dir) ? dir : join(homedir(), ".local", "share", "wiki");
}

export const wikiBinary = (env: NodeJS.ProcessEnv = process.env) => join(wikiDir(env), "bin", "wiki");

export type Loaded = { context?: WikiContext; error?: string; missing?: boolean };

/** Runs `wiki context` from the session's directory, which is what picks the scope. */
export function load(binary: string, cwd: string, timeout = 3000): Promise<Loaded> {
  return new Promise(resolve => {
    execFile(binary, ["context"], { cwd, timeout, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      if (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        resolve({ missing, error: missing ? `${binary} is not built` : (stderr.trim() || error.message).replace(/^wiki: /, "") });
        return;
      }
      try {
        resolve({ context: JSON.parse(stdout) as WikiContext });
      } catch (err) {
        resolve({ error: `unreadable output from wiki context: ${(err as Error).message}` });
      }
    });
  });
}

const day = (iso?: string) => iso?.slice(0, 10) ?? "";

/** The system prompt section, or undefined when there is no scope and no current context. */
export function section(context: WikiContext, binary: string, tool = false): string | undefined {
  if (!context.scope && !context.now.length) return;
  const lines: string[] = [];
  for (const page of context.now) {
    lines.push(`Current context from the user's memory wiki (${page.ref}), in their words. Live evidence and the user's instructions take precedence:`, "", page.text, "");
    if (page.stale) lines.push(`${page.ref} was due for a refresh on ${day(page.staleAfter)}; confirm anything time-sensitive before relying on it.`, "");
    if (page.truncated) lines.push(`${page.ref} is over its ${page.limit}-byte limit and was cut off here.`, "");
  }
  if (context.scope && tool) {
    lines.push(
      "Look things up with the `memory` tool (search, read, define, recent) when a task turns on the user's own vocabulary, systems or past decisions, not by default.",
      "When the user corrects a term or a fact about their stack or current work, offer to record it with `memory` (term, jot or now); never write unasked. Each write asks the user to confirm.",
    );
  } else if (context.scope) {
    const home = homedir(), shown = binary.startsWith(`${home}/`) ? `~${binary.slice(home.length)}` : binary;
    lines.push(
      `More of the wiki is available on demand through \`${shown} -scope ${context.scope}\` with \`search <words>\`, \`read <path>\`, \`define <term>\` or \`recent\`. Use it when a task turns on the user's own vocabulary, systems or past decisions, not by default.`,
      "When the user corrects a term or a fact about their stack or current work, offer to record it in the wiki; never write to it unasked.",
    );
  }
  return lines.join("\n").trim();
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a term or alias appears in the text as a whole word. An acronym or
 * a key of one or two characters must match its case, so that "PR" is not
 * found in "pr" and "IT" not in "it"; anything else ignores case.
 */
export function mentions(text: string, key: string): boolean {
  key = key.trim();
  if (!key) return false;
  const exact = key.length <= 2 || !/\p{Ll}/u.test(key);
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escape(key).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, exact ? "u" : "iu").test(text);
}

export const termId = (t: Term) => `${t.bundle ?? ""}/${t.term.toLowerCase()}`;

export function matches(text: string, terms: readonly Term[], seen: ReadonlySet<string> = new Set()): Term[] {
  return terms.filter(t => !seen.has(termId(t)) && [t.term, ...(t.aliases ?? [])].some(key => mentions(text, key)));
}

/** A bundle-relative Markdown link becomes a path `wiki read` accepts. */
export function plain(definition: string, bundle?: string): string {
  return definition.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, label: string, target: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return `${label} (${target})`;
    const path = target.replace(/^\.?\//, "").replace(/#.*$/, "");
    return `${label} (${bundle ? `${bundle}/` : ""}${path})`;
  });
}

export function termsMessage(found: readonly Term[]): string {
  const lines = found.map(t => {
    const aliases = t.aliases?.length ? ` (${t.aliases.join(", ")})` : "";
    const from = t.bundle ? ` [${t.bundle}]` : "";
    return `- **${t.term}**${aliases}${from}: ${plain(t.definition, t.bundle)}`;
  });
  return ["The user's glossary defines terms in this message:", ...lines].join("\n");
}
