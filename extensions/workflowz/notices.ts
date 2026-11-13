import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Keyword = "workflowz" | "orchestrate";
export const KEYWORDS: Keyword[] = ["workflowz", "orchestrate"];

/** Drops fenced and inline code so quoted keywords do not trigger. */
function prose(text: string) { return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " "); }

/** Keywords used as standalone words, as omp does: not inside paths, identifiers or code. */
export function keywordsIn(text: string): Keyword[] {
  const plain = prose(text);
  return KEYWORDS.filter((word) => new RegExp(`(^|[\\s(\\["'])${word}(?=$|[\\s.,!?;:)\\]"'])`, "i").test(plain));
}

/** `+500k` is an advisory token budget for kernel work; `+2m!` is a hard one. */
export function budgetIn(text: string): { total: number; hard: boolean } | undefined {
  const match = /(?:^|\s)\+(\d+(?:\.\d+)?)([km])(!?)(?=$|[\s.,;:])/i.exec(prose(text));
  if (!match) return undefined;
  const total = Math.round(Number(match[1]) * (match[2]!.toLowerCase() === "m" ? 1_000_000 : 1_000));
  return total > 0 ? { total, hard: match[3] === "!" } : undefined;
}

export async function loadNotices(dir: string): Promise<Record<Keyword, string>> {
  return {
    workflowz: await readFile(join(dir, "workflowz.md"), "utf8"),
    orchestrate: await readFile(join(dir, "orchestrate.md"), "utf8"),
  };
}

export interface NoticeState {
  active: string[]; concurrency: number; subagentConcurrency: number; maxTasks: number;
  budget?: { total: number; hard: boolean };
}

export function dispatchLine(state: NoticeState): string {
  const parts: string[] = [];
  if (state.active.includes("rex_agent")) parts.push("Dispatch with `rex_agent` (all of a phase's children in one message) and collect with `rex_result next=true`.");
  else if (state.active.includes("subagent")) parts.push(`Dispatch with the \`subagent\` tool: one call with up to ${state.maxTasks} tasks runs them in parallel (${state.subagentConcurrency} at a time) and returns when all finish.`);
  if (state.active.includes("eval")) parts.push("For larger fan-out, run named pools from the `eval` kernel (`workpool()`); results arrive as messages and the `wait` tool blocks for them.");
  if (!parts.length) return "No subagent tool is active here: work through the phases inline, still enumerating and verifying every item.";
  parts.push("Agents: `scout` reads the repo, `researcher` also searches the web, `advisor` reviews designs, `worker` edits a detached worktree from clean HEAD.");
  return parts.join(" ");
}

export function renderNotice(template: string, state: NoticeState): string {
  const budget = state.budget
    ? `This request set a ${state.budget.hard ? "hard" : "advisory"} budget of ${state.budget.total.toLocaleString("en-US")} tokens${state.budget.hard ? "; new work is refused once it is spent" : ""}.`
    : "No budget was set (the user can add `+500k`, or `+500k!` for a hard limit).";
  return template
    .replaceAll("{{concurrency}}", String(state.concurrency))
    .replaceAll("{{budget}}", budget)
    .replaceAll("{{dispatch}}", dispatchLine(state));
}
