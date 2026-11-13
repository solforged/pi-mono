import { createHash } from "node:crypto";
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
  /** provider/model of a configured classifier judge. */
  judge?: string;
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

export function budgetLine(budget: NoticeState["budget"]): string {
  return budget
    ? `This request set a ${budget.hard ? "hard" : "advisory"} budget of ${budget.total.toLocaleString("en-US")} tokens${budget.hard ? "; new work is refused once it is spent" : ""}.`
    : "No budget was set (the user can add `+500k`, or `+500k!` for a hard limit).";
}

export function renderNotice(template: string, state: NoticeState): string {
  return template
    .replaceAll("{{concurrency}}", String(state.concurrency))
    .replaceAll("{{budget}}", budgetLine(state.budget))
    .replaceAll("{{judge}}", state.judge ? `classifier ${state.judge}` : "estimated by a small chat model")
    .replaceAll("{{dispatch}}", dispatchLine(state));
}

export const NOTICE_TYPE = "workflowz-notice";
export interface NoticeDetails { keywords: Keyword[]; budget?: NoticeState["budget"]; sent?: Partial<Record<Keyword, string>> }

/** What a notice says apart from its budget, which every request restates. */
const fingerprint = (template: string, state: NoticeState) =>
  createHash("sha256").update(renderNotice(template, { ...state, budget: undefined })).digest("hex").slice(0, 16);

/** The notices still in context, by keyword. `entries` is the branch with compaction applied, so a compacted notice is sent again. */
export function noticesInContext(entries: readonly any[]): Partial<Record<Keyword, string>> {
  const seen: Partial<Record<Keyword, string>> = {};
  for (const entry of entries) if (entry?.type === "custom_message" && entry.customType === NOTICE_TYPE) Object.assign(seen, (entry.details as NoticeDetails | undefined)?.sent);
  return seen;
}

/**
 * The message for a prompt that used `words`. A notice runs to thousands of
 * characters and stays in history, so one that is already in context
 * unchanged is pointed at rather than repeated; only its budget is restated.
 */
export function noticeMessage(words: Keyword[], templates: Record<Keyword, string>, state: NoticeState, seen: Partial<Record<Keyword, string>> = {}) {
  const sent: Partial<Record<Keyword, string>> = {};
  const parts = words.map((word) => {
    const mark = fingerprint(templates[word], state);
    if (seen[word] !== mark) { sent[word] = mark; return renderNotice(templates[word], state); }
    return `The \`${word}\` notice earlier in this conversation still applies.${templates[word].includes("{{budget}}") ? ` ${budgetLine(state.budget)}` : ""}`;
  });
  const details: NoticeDetails = { keywords: words, budget: state.budget, sent };
  return { content: parts.join("\n\n"), details };
}
