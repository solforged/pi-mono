// Pure presentation helpers: no Pi imports, so the regression suite can load them.
import { headingRule, type Measure } from "../shared/rule.ts";
import type { Run, TaskRun } from "./runner.ts";
import { duration, fraction, glyph, money, oneLine, STATES, type State, type Theme, type Tone } from "../shared/status.ts";
export { duration, money, oneLine } from "../shared/status.ts";

export type PickAction = "open" | "message" | "result" | "take" | "cancel" | "close";
export type Group = "attention" | "running" | "done" | "failed" | "idle" | "yours";
export interface Row {
  id: string; name: string; group: Group; glyph: string; tone: Tone; agent: string; title: string; state: string;
  /** Settled usage plus the running task's live cost, in dollars. */
  cost: number;
  /** Elapsed time of the running task. */
  elapsedMs?: number;
  /** How far along the running task is, from the child's todo list. */
  progress?: { done: number; total: number };
}

/** Jumps to the child that most needs a look, from anywhere; ← on an empty prompt does too. */
export const SHORTCUT = "ctrl+shift+a";
const ORDER: Group[] = ["attention", "running", "failed", "done", "idle", "yours"];
/** Groups in the shared status vocabulary. */
const STATE: Record<Group, State> = { attention: "attention", running: "working", failed: "failed", done: "done", idle: "idle", yours: "yours" };

/** Children needing the user first, then active work, then finished. Closed children are hidden. */
export const taskCost = (task: TaskRun) => task.usageKnown ? task.usage.cost.total : task.liveCost ?? 0;
export function rows(runs: Iterable<Run>, tasks: Map<string, TaskRun>, now = Date.now()): Row[] {
  return [...runs].filter(run => run.status !== "closed").map(run => {
    const last = tasks.get(run.activeTask ?? run.taskIds.at(-1) ?? "");
    let group: Group = "idle", state: string = run.status;
    if (run.owner === "human") { group = "yours"; state = "yours"; }
    else if (run.owner === "unknown") { group = "attention"; state = "needs inspection"; }
    else if (run.activeTask && /^Waiting for user/.test(run.note ?? "")) { group = "attention"; state = oneLine(run.note!, 32); }
    else if (run.activeTask || run.status === "starting") { group = "running"; state = oneLine(run.note ?? run.status, 40); }
    else if (last?.status === "succeeded") { group = "done"; state = "done"; }
    else if (last?.status === "failed" || last?.status === "cancelled") { group = "failed"; state = last.status; }
    if (run.owner === "retired" && group !== "attention") state += ", retired";
    const [mark, tone] = STATES[STATE[group]];
    const active = run.activeTask ? tasks.get(run.activeTask) : undefined;
    const cost = run.taskIds.reduce((sum, id) => { const t = tasks.get(id); return sum + (t ? taskCost(t) : 0); }, 0);
    return { id: run.id, name: run.name, group, glyph: mark, tone, agent: run.agent, title: oneLine(last?.title ?? last?.task ?? "starting", 48), state,
      cost, ...(active ? { elapsedMs: Math.max(0, now - active.started) } : {}), ...(active?.progress ? { progress: active.progress } : {}) };
  }).sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
}

/**
 * One heading rule at any scale, in the editor's style: names grouped by state
 * with progress on the left, cost and the ← key on the right, e.g.
 * `─ Agents  ! oak needs you  ● birch 3/5 cedar  ✓ fern ──── $0.42 · ← open ─`.
 */
export function widgetLine(items: Row[], theme: Theme, m: Measure, width: number) {
  const groups = ORDER.map(group => {
    const names = items.filter(r => r.group === group).map(r => r.progress ? `${r.name} ${theme.fg("dim", fraction(r.progress))}` : r.name);
    if (!names.length) return "";
    return `${glyph(STATE[group], theme)} ${names.join(" ")}${group === "attention" ? theme.fg("warning", " needs you") : ""}`;
  }).filter(Boolean);
  const total = items.reduce((sum, r) => sum + r.cost, 0);
  const title = theme.fg("accent", theme.bold ? theme.bold("Agents") : "Agents");
  const facts = `${total ? `${theme.fg("muted", money(total))}${theme.fg("dim", " · ")}` : ""}${theme.fg("muted", "←")} ${theme.fg("dim", "open")}`;
  return headingRule(m, width, [title, ...groups].join("  "), facts, s => theme.fg("borderMuted", s));
}
/** Model-facing listing line: `birch · scout · read docs/x.md · 3/5 · managed`. */
export function listLine(r: Row, owner: string) {
  return [r.name, r.agent, r.state, fraction(r.progress), owner].filter(Boolean).join(" · ");
}

/** A JSON-safe snapshot for tool details; never a live TaskRun reference. */
export interface TaskMeta {
  name: string; agent: string; childId: string; taskId: string; title: string; status: TaskRun["status"];
  elapsedMs: number; tokens?: number; background: boolean;
  /** The user typed the task into the child's pane. */
  fromUser?: boolean;
}
export function taskMeta(run: Run, task: TaskRun): TaskMeta {
  return { name: run.name, agent: run.agent, childId: run.id, taskId: task.id, title: oneLine(task.title ?? task.task, 72), status: task.status,
    elapsedMs: task.elapsedMs, tokens: task.usageKnown ? task.usage.totalTokens : undefined, background: task.background, ...(task.from === "user" ? { fromUser: true } : {}) };
}
const TASK_STATES: Record<TaskRun["status"], State> = { starting: "starting", running: "working", succeeded: "done", failed: "failed", cancelled: "cancelled" };
const compact = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
/** One-line task status: `✓ birch scout · succeeded · 18s · 2.5k tok`. */
export function taskLine(meta: TaskMeta, theme: Theme) {
  const running = meta.status === "starting" || meta.status === "running";
  const state = running ? (meta.background ? "running in background" : "running") : meta.status;
  const facts = [state, ...(running ? [] : [duration(meta.elapsedMs)]), ...(meta.tokens !== undefined ? [`${compact(meta.tokens)} tok`] : []), ...(meta.fromUser ? ["typed by the user"] : [])];
  return `${glyph(TASK_STATES[meta.status] ?? "idle", theme)} ${meta.name} ${theme.fg("muted", `${meta.agent} · ${facts.join(" · ")}`)}`;
}
/** Enough of a task ID to name it: rex_result and rex_send resolve a prefix. */
export const shortId = (id: string) => id.slice(0, 8);
/**
 * A task's receipt for the model. It stays in the conversation, so file paths
 * appear only where they are the way forward: the full result when the text
 * was cut or the task did not succeed, and a worker's worktree to review.
 */
export function resultText(run: Pick<Run, "name" | "agent" | "sessionFile" | "worktree">, task: TaskRun) {
  const done = task.status !== "starting" && task.status !== "running";
  const lines = [`${run.name} (${run.agent}) · task ${shortId(task.id)} · ${task.status}`];
  if (done && (task.status !== "succeeded" || task.text.endsWith("\n[truncated]"))) lines.push(`Result: ${task.resultFile}`, `Session: ${run.sessionFile}`);
  if (run.worktree) lines.push(`Worktree (not integrated): ${run.worktree}`);
  if (done && !task.usageKnown) lines.push("Usage: unavailable");
  return `${lines.join("\n")}\n\n${task.text}`;
}
/** The model-facing result is `header\n\nanswer`; display separates them. */
export function splitResult(text: string): { header: string; answer: string } {
  const at = text.indexOf("\n\n");
  return at < 0 ? { header: text, answer: "" } : { header: text.slice(0, at), answer: text.slice(at + 2).trim() };
}
export function callLine(tool: "rex_agent" | "rex_send" | "rex_result", args: Record<string, any>, theme: Theme) {
  const quote = (s?: string) => s ? theme.fg("dim", ` "${oneLine(s, 72)}"`) : "";
  const rex = theme.fg("accent", "Rex");
  if (tool === "rex_agent") return `${rex} ${args.name ? `${args.name} · ` : ""}${args.agent ?? ""}${quote(args.title ?? args.task)}${args.view && args.view !== "background" ? theme.fg("muted", ` · ${args.view}`) : ""}`;
  if (tool === "rex_send") return `${rex} ${args.mode ?? "send"} → ${args.child ?? ""}${quote(args.text)}`;
  if (args.next) return `${rex} next results`;
  return `${rex} ${args.taskId ? `result ${String(args.taskId).slice(0, 8)}${args.wait ? " (wait)" : ""}` : "list"}`;
}
/** Child pane footer facts: status on the left, usage and model on the right. */
export function childFooter(f: { status: string; input: number; output: number; cost: number; percent?: number; model: string; thinking?: string }) {
  const usage = [`↑${compact(f.input)} ↓${compact(f.output)}`, ...(f.cost ? [`$${f.cost.toFixed(2)}`] : []), ...(f.percent != null ? [`${Math.round(f.percent)}%`] : [])];
  return { left: oneLine(f.status, 80), right: `${usage.join(" · ")} · ${f.model}${f.thinking && f.thinking !== "off" ? ` ${f.thinking}` : ""}` };
}
/** How many results fit one rex_result reply: always the first, then while under budget. */
export function fitResults(sizes: number[], budget: number) {
  let used = 0, count = 0;
  for (const size of sizes) { if (count && used + size > budget) break; used += size; count++; }
  return count;
}
/** Live status while rex_result waits: `waiting on 3 · alpha 3/5 2m10s · bravo 45s · charlie 3s`. */
export function waitingLine(items: Array<{ name: string; elapsedMs: number; progress?: { done: number; total: number } }>) {
  return `waiting on ${items.length}${items.map(i => ` · ${i.name} ${i.progress ? `${fraction(i.progress)} ` : ""}${duration(i.elapsedMs)}`).join("")}`;
}
/** Batched completion receipts: one line per finished task. */
export function completionLines(items: TaskMeta[], theme: Theme) {
  return items.map(m => `${taskLine(m, theme)} ${theme.fg("dim", m.title)}`);
}

/** Who gets a cell in a full Agents tab: needs you > working > unread result > idle > human-owned. */
export function priority(row: Row, unread: boolean) {
  return row.group === "attention" ? 4 : row.group === "running" ? 3 : (row.group === "done" || row.group === "failed") && unread ? 2 : row.group === "yours" ? 0 : 1;
}
/** Where ← goes: needs you > a result to read > working > the rest. */
export function urgency(row: Row, unread: boolean) {
  return row.group === "attention" ? 4 : (row.group === "done" || row.group === "failed") && unread ? 3 : row.group === "running" ? 2 : row.group === "yours" ? 0 : 1;
}

/**
 * Runs `fn` at the first call, and once more `ms` later when calls came in
 * between, so a burst costs two runs and the last state is always drawn.
 */
export function coalesce(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined, again = false, stopped = false;
  const call = () => {
    if (stopped) return;
    if (timer) { again = true; return; }
    fn();
    timer = setTimeout(() => { timer = undefined; if (again) { again = false; call(); } }, ms);
    timer.unref?.();
  };
  return { call, stop() { stopped = true; clearTimeout(timer); } };
}

/**
 * ← on an empty prompt jumps (to a child, or back to the parent). Right after
 * the prompt was emptied (deleting text, leaving history) a first press only
 * arms it, so a held backspace or ← cannot jump away by accident.
 */
export class LeftGate {
  private editedAt = -Infinity;
  private armedAt = -Infinity;
  private readonly settleMs: number;
  private readonly armMs: number;
  constructor(settleMs = 1000, armMs = 2000) { this.settleMs = settleMs; this.armMs = armMs; }
  /** After any other key the editor handled: did the prompt hold text before or after it? */
  edited(hadText: boolean, now: number) { if (hadText) this.editedAt = now; this.armedAt = -Infinity; }
  left(empty: boolean, now: number): "pass" | "arm" | "open" {
    if (!empty) return "pass";
    if (now - this.armedAt < this.armMs || now - this.editedAt >= this.settleMs) { this.armedAt = -Infinity; return "open"; }
    this.armedAt = now; return "arm";
  }
}
