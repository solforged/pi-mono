// Deterministic gate for automatic learning. Nothing here calls a model: it
// reduces finished work to action features and finds patterns that recur
// across sessions, so the learn role runs only when repetition is evidenced.

// Observation, editing and delegation tools are part of every kind of task,
// so they say little about which workflow ran.
const QUIET_TOOLS = new Set([
  "read", "ls", "find", "grep", "edit", "write", "artifact_read", "session_search", "session_read", "todo",
  "web_search", "web_fetch", "ask_user_question", "intercom", "subagent", "rex_agent", "rex_send", "rex_result",
]);
// Inspection commands appear in nearly every task.
const QUIET_COMMANDS = new Set([
  "cat", "ls", "grep", "rg", "find", "fd", "head", "tail", "sed", "awk", "wc", "echo", "printf", "pwd",
  "which", "true", "false", "sleep", "tree", "stat", "file", "sort", "uniq", "cut", "tr", "jq", "less",
  "diff", "cd", "test", "[", "date", "type", "command", "export", "set", "source", ".", "xargs", "tee",
  "basename", "dirname", "realpath", "readlink", "du", "df", "ps", "env", "time", "sudo", "nl", "column",
  "for", "do", "done", "if", "then", "else", "elif", "fi", "while", "until", "case", "esac", "exit", "return",
  "local", "read", "wait", "kill", "mktemp", "mkdir", "rm", "rmdir", "cp", "mv", "touch", "chmod", "ln", "printenv", "open",
  "seq", "break", "continue", "unset", "hostname", "strings", "whoami", "id", "uname",
]);
const QUIET_GIT = new Set(["add", "commit", "push", "pull", "fetch", "stash", "checkout", "switch", "restore", "status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "grep", "branch", "remote", "config", "describe", "reflog", "shortlog", "cat-file"]);
// Words with long digit or hex runs are identifiers, not subcommands.
const INTERPRETERS = new Set(["node", "pi", "python", "python3", "bash", "sh", "zsh", "deno", "bun", "ruby", "perl", "osascript"]);
const WORD = /^(?![^]*[0-9a-f]{8})[a-z][a-z0-9:_.-]*$/;
const PATH = /^(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+$/;

function words(segment: string): string[] {
  const parts = segment.trim().split(/\s+/).filter(Boolean);
  for (;;) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0] ?? "") || ["sudo", "time", "env", "exec", "nohup", "command", "xargs"].includes(parts[0])) parts.shift();
    else if (parts[0] === "timeout") parts.splice(0, /^\d/.test(parts[1] ?? "") ? 2 : 1);
    else return parts;
  }
}

/** Normalize one shell command to its meaningful action heads, e.g. `mise run test`. */
export function commandActions(command: string): string[] {
  const actions: string[] = [];
  // Heredoc bodies and quoted arguments are data, not actions.
  const text = command.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, " ").replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, " _ ")
    .replace(/\d*[<>]+&?\s*\S+/g, " ");
  for (const segment of text.split(/&&|\|\||[;|\n]|\$\(|`|\(|\)/)) {
    const parts = words(segment);
    if (!parts.length) continue;
    const head = parts[0].replace(/^.*\//, "");
    if (!WORD.test(head) || QUIET_COMMANDS.has(head)) continue;
    const action = [head];
    for (const word of parts.slice(1)) {
      // Flags and machine-local paths vary between runs of the same workflow.
      if (/^[-/~$]/.test(word)) continue;
      if (action.length === 1 && PATH.test(word)) { action.push(word.replace(/^\.\//, "")); break; }
      if (!WORD.test(word) || action.length >= 3) break;
      action.push(word);
    }
    if (head === "git" && QUIET_GIT.has(action[1] ?? "")) continue;
    // A bare interpreter runs an inline script that differs every time.
    if (action.length === 1 && INTERPRETERS.has(head)) continue;
    // Keep tool + subcommand: `git commit`, `mise run test`, `gh pr create`.
    actions.push(action.slice(0, head === "mise" || head === "npm" || head === "pnpm" || head === "gh" ? 3 : 2).join(" "));
  }
  return actions;
}

/** Ordered actions from assistant tool calls in a branch segment. */
export function actionsFromEntries(entries: any[]): string[] {
  const actions: string[] = [];
  for (const entry of entries) {
    if (entry?.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block?.type !== "toolCall" || typeof block.name !== "string" || QUIET_TOOLS.has(block.name)) continue;
      if (block.name === "bash" && typeof block.arguments?.command === "string") actions.push(...commandActions(block.arguments.command).map((a) => `$ ${a}`));
      else actions.push(block.name);
    }
  }
  return actions;
}

/** Distinct actions plus ordered pairs, so order matters without demanding an exact sequence. */
export function features(actions: string[]): string[] {
  const ordered = actions.filter((action, i) => action !== actions[i - 1]);
  const pairs = ordered.slice(1).map((action, i) => `${ordered[i]} → ${action}`);
  return [...new Set([...ordered, ...pairs])];
}

/** Split a branch into tasks, each starting at a user message. */
export function segments(branch: any[]): any[][] {
  const result: any[][] = [];
  for (const entry of branch) {
    if (entry?.type === "message" && entry.message?.role === "user") result.push([entry]);
    else if (result.length) result[result.length - 1].push(entry);
  }
  return result;
}
export function toolCalls(entries: any[]): number {
  return entries.reduce((sum, entry) => sum + (entry?.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content)
    ? entry.message.content.filter((block: any) => block?.type === "toolCall").length : 0), 0);
}

/** A finished task worth comparing: one user request and the work that followed. */
export interface Run { first: string; last: string; features: string[] }
export const MIN_TOOL_CALLS = 6;
export function summarizeRun(entries: any[]): Run | undefined {
  const actions = actionsFromEntries(entries);
  if (toolCalls(entries) < MIN_TOOL_CALLS || new Set(actions).size < 3) return undefined;
  return { first: entries[0].id, last: entries[entries.length - 1].id, features: features(actions) };
}
export function runs(branch: any[]): Run[] {
  return segments(branch).map(summarizeRun).filter((run): run is Run => !!run);
}
/** Skill files the task read, and whether any tool call failed. */
export function skillUse(entries: any[]): { skills: string[]; errors: boolean } {
  const skills = new Set<string>();
  let errors = false;
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    if (entry.message?.role === "toolResult" && entry.message.isError) errors = true;
    if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      const path = block?.type === "toolCall" && block.name === "read" ? block.arguments?.path : undefined;
      if (typeof path === "string" && /(?:^|\/)SKILL\.md$/.test(path)) skills.add(path.split("/").at(-2) ?? path);
    }
  }
  return { skills: [...skills], errors };
}

export interface Match { session: string; run: Run }
/** `sessions` counts every session, this one included, whose work contains the whole core. */
export interface Recurrence { core: string[]; matches: Match[]; sessions: number }
// A pattern needs a few distinctive steps, at least one of them ordered.
export const MIN_CORE = 4;
/**
 * Find the steps of `current` that recur together in at least `minSessions - 1`
 * other sessions. `sessions` is the whole project population, including
 * sessions with no comparable runs. Steps found in over half the sessions (routine edits, the test command)
 * do not count, so only distinctive workflows qualify. Greedy: it takes the
 * session sharing the most, then narrows the core with each further session.
 */
export function recurrence(current: Run, others: Map<string, Run[]>, minSessions: number, sessions = others.size + 1): Recurrence | undefined {
  const df = new Map<string, number>();
  for (const list of [[current], ...others.values()]) {
    for (const feature of new Set(list.flatMap((run) => run.features))) df.set(feature, (df.get(feature) ?? 0) + 1);
  }
  const routine = (feature: string) => sessions >= 6 && df.get(feature)! / sessions > 0.5;
  let core = new Set(current.features.filter((feature) => !routine(feature)));
  const matches: Match[] = [];
  for (let picked = 0; picked < minSessions - 1; picked++) {
    let choice: Match | undefined, choiceCore = new Set<string>();
    for (const [session, list] of others) {
      if (matches.some((match) => match.session === session)) continue;
      for (const run of list) {
        const shared = new Set(run.features.filter((feature) => core.has(feature)));
        if (shared.size > choiceCore.size) { choice = { session, run }; choiceCore = shared; }
      }
    }
    if (!choice) return undefined;
    matches.push(choice); core = choiceCore;
  }
  const ordered = [...core].filter((feature) => feature.includes(" → "));
  if (core.size < MIN_CORE || !ordered.length) return undefined;
  const contains = (run: Run) => [...core].every((feature) => run.features.includes(feature));
  const sessionsWithCore = [...others.values()].filter((list) => list.some(contains)).length + 1;
  return { core: [...core].sort(), matches, sessions: sessionsWithCore };
}

export interface PatternReview { core: string[]; sessions: number; at: string; outcome: string }
/**
 * A reviewed pattern stays quiet until it has recurred in twice as many
 * sessions as when it was last reviewed.
 */
export function alreadyReviewed(core: string[], sessions: number, reviews: PatternReview[]): boolean {
  return reviews.some((review) => {
    const shared = review.core.filter((feature) => core.includes(feature)).length;
    return shared / Math.min(core.length, review.core.length) >= 0.6 && sessions < review.sessions * 2;
  });
}
/** True when project instructions already name every command in the pattern. */
export function documented(core: string[], instructions: string): boolean {
  const steps = core.filter((feature) => !feature.includes(" → ")).map((feature) => feature.replace(/^\$ /, ""));
  return steps.length > 0 && steps.every((step) => instructions.includes(step));
}
