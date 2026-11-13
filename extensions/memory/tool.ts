// The memory tool: the wiki's read commands for the model, and three narrow
// writes (a jot, a glossary entry, now.md) that the user confirms first. The
// `wiki` CLI enforces the scope and the limits; this module maps parameters
// to its arguments and keeps writes behind a confirmation.
import { spawn } from "node:child_process";

export const TOOL = "memory";
export const ACTIONS = ["search", "read", "define", "recent", "jot", "term", "now"] as const;
export type Action = (typeof ACTIONS)[number];
export type Params = { action: Action; words?: string; paths?: string[]; term?: string; aliases?: string[]; replace?: boolean; text?: string };

export const WRITES: ReadonlySet<Action> = new Set(["jot", "term", "now"]);
export const OUTPUT_MAX = 30_000;

export const DESCRIPTION = [
  "The user's memory wiki: their own vocabulary, systems, current work and past decisions.",
  "Read: search (words), read (paths from search or an index, such as work/notes/deploy.md), define (term; none lists all), recent (journal lines).",
  "Write only when the user asks or accepts your offer; each write shows the user the change to confirm.",
  "jot (text): one line learned, not done. term (term, text as the definition, optional aliases; replace to change one).",
  "now (text): the complete new current context, the stack and a few dated focus bullets under 2,000 bytes, which every session loads.",
  "A longer finding with sources belongs to /skill:memory remember.",
].join(" ");

const need = (value: string | undefined, what: string) => {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${what} is required for this action`);
  return trimmed;
};

/** The `wiki` arguments, and stdin, for one call. */
export function command(p: Params): { args: string[]; input?: string } {
  switch (p.action) {
    case "search": return { args: ["search", ...need(p.words, "words").split(/\s+/)] };
    case "read": {
      const paths = (p.paths ?? []).map(path => path.trim()).filter(Boolean);
      if (!paths.length) throw new Error("paths is required for read");
      return { args: ["read", ...paths] };
    }
    case "define": return { args: ["define", ...(p.term?.trim() ? [p.term.trim()] : [])] };
    case "recent": return { args: ["recent"] };
    case "jot": return { args: ["jot", need(p.text, "text")] };
    case "term": {
      const aliases = (p.aliases ?? []).map(a => a.trim()).filter(Boolean);
      return { args: ["term", ...(aliases.length ? ["-aliases", aliases.join(",")] : []), ...(p.replace ? ["-replace"] : []), "--", need(p.term, "term"), need(p.text, "text")] };
    }
    case "now": return { args: ["now", "-set"], input: need(p.text, "text") };
    default: throw new Error(`Unknown action: ${(p as Params).action}`);
  }
}

/** What the user is asked before a write. */
export function preview(p: Params, scope: string): { title: string; body: string } {
  const where = scope ? `the ${scope}` : "this scope's";
  switch (p.action) {
    case "jot": return { title: `Jot in ${where} journal?`, body: p.text!.trim() };
    case "term": {
      const aliases = (p.aliases ?? []).filter(a => a.trim());
      return { title: `${p.replace ? "Change an entry in" : "Add to"} ${where} glossary?`, body: `**${p.term!.trim()}**${aliases.length ? ` (${aliases.join(", ")})` : ""}: ${p.text!.trim()}` };
    }
    default: {
      const text = p.text!.trim();
      return { title: `Replace ${scope ? `${scope}/` : ""}now.md?`, body: `${text}\n\n${Buffer.byteLength(text)} bytes. Every session in this scope loads it; the next refresh falls due in two weeks.` };
    }
  }
}

export type Result = { code: number | null; stdout: string; stderr: string };

export function runWiki(binary: string, args: string[], cwd: string, input?: string, signal?: AbortSignal, timeout = 10_000): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, signal, timeout, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

export type Confirm = (title: string, body: string) => Promise<boolean>;

/**
 * Runs one call. A write without a way to ask, or one the user declines,
 * changes nothing. Failures throw with the CLI's own message.
 */
export async function execute(binary: string, p: Params, cwd: string, scope: string, confirm: Confirm | undefined, signal?: AbortSignal): Promise<string> {
  const { args, input } = command(p);
  if (WRITES.has(p.action)) {
    if (!confirm) throw new Error("Writing to the memory wiki needs the user's confirmation, which this session cannot ask for.");
    const { title, body } = preview(p, scope);
    if (!(await confirm(title, body))) return "The user declined; nothing was written.";
  }
  const result = await runWiki(binary, args, cwd, input, signal);
  if (result.code !== 0) throw new Error((result.stderr.trim() || result.stdout.trim() || `wiki exited with ${result.code}`).replace(/^wiki: /, ""));
  const text = result.stdout.trim();
  return text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX)}\n… output cut at ${OUTPUT_MAX} characters; read fewer paths at once.` : text;
}
