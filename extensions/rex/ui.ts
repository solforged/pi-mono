// Pure presentation helpers: no Pi imports, so the regression suite can load them.
import type { Run, TaskRun } from "./runner.ts";

export type PickAction = "spotlight" | "focus" | "grid" | "park" | "auto" | "message" | "result" | "take" | "cancel" | "close";
type Tone = "accent" | "success" | "error" | "warning" | "muted" | "dim";
type Theme = { fg(tone: Tone, text: string): string; bold?(text: string): string };
export type Group = "attention" | "running" | "done" | "failed" | "idle" | "yours";
export interface Row { id: string; name: string; pinned: boolean; group: Group; glyph: string; tone: Tone; agent: string; title: string; state: string }

export const KEYS: Record<string, PickAction> = { enter: "spotlight", f: "focus", g: "grid", p: "park", a: "auto", m: "message", r: "result", t: "take", x: "cancel", c: "close" };
export const SHORTCUT = "ctrl+shift+a";
export const HINT = "↑↓ · enter pin to deck · f focus · g agents window · p park · a auto · m message · r result · t take · x cancel · c close · esc";
const ORDER: Group[] = ["attention", "running", "failed", "done", "idle", "yours"];
const STYLE: Record<Group, [string, Tone]> = {
  attention: ["!", "warning"], running: ["●", "accent"], failed: ["✗", "error"], done: ["✓", "success"], idle: ["○", "muted"], yours: ["◆", "muted"],
};

export const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Children needing the user first, then active work, then finished. Closed children are hidden. */
export function rows(runs: Iterable<Run>, tasks: Map<string, TaskRun>): Row[] {
  return [...runs].filter(run => run.status !== "closed").map(run => {
    const last = tasks.get(run.activeTask ?? run.taskIds.at(-1) ?? "");
    let group: Group = "idle", state: string = run.status;
    if (run.owner === "human") { group = "yours"; state = "yours"; }
    else if (run.owner === "unknown") { group = "attention"; state = "needs inspection"; }
    else if (run.activeTask && /^Waiting for user/.test(run.note ?? "")) { group = "attention"; state = oneLine(run.note!, 32); }
    else if (run.activeTask || run.status === "starting") { group = "running"; state = oneLine(run.note ?? run.status, 24); }
    else if (last?.status === "succeeded") { group = "done"; state = "done"; }
    else if (last?.status === "failed" || last?.status === "cancelled") { group = "failed"; state = last.status; }
    if (run.owner === "retired" && group !== "attention") state += ", retired";
    const [glyph, tone] = STYLE[group];
    return { id: run.id, name: run.name, pinned: !!run.pinned, group, glyph, tone, agent: run.agent, title: oneLine(last?.task ?? "starting", 48), state };
  }).sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
}

/** One line at any scale: names grouped by state, e.g. `Rex  ! oak  ● birch cedar  ✓ fern`. */
export function widgetLine(items: Row[], theme: Theme) {
  const groups = ORDER.map(group => {
    const names = items.filter(r => r.group === group).map(r => r.name);
    if (!names.length) return "";
    const [glyph, tone] = STYLE[group];
    return `${theme.fg(tone, glyph)} ${names.join(" ")}${group === "attention" ? theme.fg("warning", " needs you") : ""}`;
  }).filter(Boolean);
  return `${theme.fg("accent", "Rex")} ${theme.fg("dim", String(items.length))}  ${groups.join("   ")}   ${theme.fg("dim", SHORTCUT)}`;
}
export function pickerRow(r: Row, selected: boolean, theme: Theme) {
  return `${selected ? theme.fg("accent", "›") : " "} ${theme.fg(r.tone, r.glyph)}${r.pinned ? theme.fg("accent", "▪") : " "}${r.name.padEnd(9)} ${theme.fg("muted", r.agent.padEnd(7))} ${r.title}  ${theme.fg("muted", r.state)}`;
}

/** A JSON-safe snapshot for tool details; never a live TaskRun reference. */
export interface TaskMeta {
  name: string; agent: string; childId: string; taskId: string; title: string; status: TaskRun["status"];
  elapsedMs: number; tokens?: number; background: boolean;
}
export function taskMeta(run: Run, task: TaskRun): TaskMeta {
  return { name: run.name, agent: run.agent, childId: run.id, taskId: task.id, title: oneLine(task.task, 72), status: task.status,
    elapsedMs: task.elapsedMs, tokens: task.usageKnown ? task.usage.totalTokens : undefined, background: task.background };
}
const GLYPHS: Record<string, [string, Tone]> = {
  starting: ["◌", "dim"], running: ["●", "accent"], succeeded: ["✓", "success"], failed: ["✗", "error"], cancelled: ["–", "warning"],
};
const compact = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
export function duration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
/** One-line task status: `✓ birch scout · succeeded · 18s · 2.5k tok`. */
export function taskLine(meta: TaskMeta, theme: Theme) {
  const [glyph, tone] = GLYPHS[meta.status] ?? ["?", "muted"];
  const running = meta.status === "starting" || meta.status === "running";
  const state = running ? (meta.background ? "running in background" : "running") : meta.status;
  const facts = [state, ...(running ? [] : [duration(meta.elapsedMs)]), ...(meta.tokens !== undefined ? [`${compact(meta.tokens)} tok`] : [])];
  return `${theme.fg(tone, glyph)} ${meta.name} ${theme.fg("muted", `${meta.agent} · ${facts.join(" · ")}`)}`;
}
/** The model-facing result is `header\n\nanswer`; display separates them. */
export function splitResult(text: string): { header: string; answer: string } {
  const at = text.indexOf("\n\n");
  return at < 0 ? { header: text, answer: "" } : { header: text.slice(0, at), answer: text.slice(at + 2).trim() };
}
export function callLine(tool: "rex_agent" | "rex_send" | "rex_result", args: Record<string, any>, theme: Theme) {
  const quote = (s?: string) => s ? theme.fg("dim", ` "${oneLine(s, 72)}"`) : "";
  const rex = theme.fg("accent", "Rex");
  if (tool === "rex_agent") return `${rex} ${args.name ? `${args.name} · ` : ""}${args.agent ?? ""}${quote(args.task)}${args.view && args.view !== "background" ? theme.fg("muted", ` · ${args.view}`) : ""}`;
  if (tool === "rex_send") return `${rex} ${args.mode ?? "send"} → ${args.child ?? ""}${quote(args.text)}`;
  if (args.next) return `${rex} next result`;
  return `${rex} ${args.taskId ? `result ${String(args.taskId).slice(0, 8)}${args.wait ? " (wait)" : ""}` : "list"}`;
}
/** Batched completion receipts: one line per finished task. */
export function completionLines(items: TaskMeta[], theme: Theme) {
  return items.map(m => `${taskLine(m, theme)} ${theme.fg("dim", m.title)}`);
}

/** Deck priority: needs you > running > unread result > idle > human-owned. */
export function priority(row: Row, unread: boolean) {
  return row.group === "attention" ? 4 : row.group === "running" ? 3 : (row.group === "done" || row.group === "failed") && unread ? 2 : row.group === "yours" ? 0 : 1;
}
