// The agent hub's pure model: sections, row text, scrolling, the ← gate and key
// meanings. No Pi imports, so the regression suite can load it.
import { duration, money, oneLine, type Group, type Row } from "./ui.ts";

type Tone = "accent" | "success" | "error" | "warning" | "muted" | "dim";
type Theme = { fg(tone: Tone, text: string): string; bold?(text: string): string };

/** Another top-level Pi session on this machine, from its intercom card. */
export interface Peer { id: string; pid: number; cwd: string; title: string | null; busy: boolean; started: number; rex: { session: string; block: string } | null }
export type Section = Group | "peers";
export interface Entry {
  /** Stable across refreshes: selection follows it. */
  key: string; kind: "child" | "peer"; section: Section;
  glyph: string; tone: Tone; name: string; role: string; state: string; title: string;
  elapsedMs?: number; cost?: number; pinned?: boolean;
  /** Finished, and the parent model has not read the result yet. */
  unread?: boolean;
  childId?: string; peer?: Peer;
}
export const SECTIONS: Record<Section, string> = {
  attention: "Needs you", running: "Working", failed: "Failed", done: "Done", idle: "Idle", yours: "Yours (human control)", peers: "Other Pi sessions",
};
const ORDER: Section[] = ["attention", "running", "failed", "done", "idle", "yours", "peers"];
const HOME = process.env.HOME ?? "";
export const short = (p: string) => HOME && (p === HOME || p.startsWith(`${HOME}/`)) ? `~${p.slice(HOME.length)}` : p;
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** Children (already attention-first), then other sessions: in Rex, then busy, first. */
export function entries(rows: Row[], unread: Set<string>, peers: Peer[]): Entry[] {
  const kids: Entry[] = rows.map(r => ({ key: `child:${r.id}`, kind: "child", section: r.group, glyph: r.glyph, tone: r.tone, name: r.name, role: r.agent,
    state: r.state, title: r.title, elapsedMs: r.elapsedMs, cost: r.cost, pinned: r.pinned, unread: unread.has(r.id), childId: r.id }));
  const others: Entry[] = [...peers].sort((a, b) => Number(!!b.rex) - Number(!!a.rex) || Number(b.busy) - Number(a.busy) || a.started - b.started).map(p => ({
    key: `peer:${p.id}`, kind: "peer", section: "peers", glyph: p.busy ? "◆" : "◇", tone: p.busy ? "accent" : "muted",
    name: base(p.cwd), role: "", state: p.rex ? (p.busy ? "working" : "idle") : "not in Rex", title: p.title ?? `in ${short(p.cwd.replace(/\/+[^/]*\/*$/, "")) || "/"}`, peer: p }));
  return [...kids, ...others].sort((a, b) => ORDER.indexOf(a.section) - ORDER.indexOf(b.section));
}

export interface Columns { name: number; role: number; state: number; time: number; cost: number }
const GAP = 2, LEAD = 4, TITLE = 24, MIN = 8;
/**
 * Column widths from what the rows hold, so a long session name is not cut
 * while the screen beside it is empty. The title takes what is left; when the
 * pane is narrow, state and name shrink (not below 8), then time and cost go.
 */
export function columns(items: Entry[], width: number): Columns {
  const longest = (f: (e: Entry) => number) => items.reduce((n, e) => Math.max(n, f(e)), 0);
  const c: Columns = { name: longest(e => e.name.length), role: longest(e => e.role.length), state: longest(e => e.state.length),
    // Fixed widths: these change every second and must not shift the columns.
    time: items.some(e => e.elapsedMs !== undefined) ? 6 : 0, cost: items.some(e => e.cost) ? 6 : 0 };
  c.name = Math.min(c.name, 40); c.state = Math.min(c.state, 40);
  const used = () => LEAD + c.name + GAP + (c.role && c.role + GAP) + c.state + GAP + (c.time && c.time + 1) + (c.cost && c.cost + 1) + (c.time || c.cost ? GAP - 1 : 0);
  while (width - used() < TITLE && (c.state > MIN || c.name > MIN)) {
    if (c.state >= c.name && c.state > MIN) c.state--; else c.name--;
  }
  if (width - used() < TITLE) c.time = c.cost = 0;
  return c;
}

/** `→ ! oak    scout   Allow bash: gh run view?   1m02s  $0.21  Check CI config` */
export function entryLine(e: Entry, selected: boolean, theme: Theme, c: Columns) {
  const fit = (text: string, n: number) => oneLine(text, n).padEnd(n);
  const mark = e.pinned ? theme.fg("accent", "▪") : e.unread ? theme.fg("success", "•") : " ";
  const name = selected ? theme.fg("accent", fit(e.name, c.name)) : fit(e.name, c.name), gap = " ".repeat(GAP);
  const numbers = [c.time ? theme.fg("dim", (e.elapsedMs !== undefined ? duration(e.elapsedMs) : "").padStart(c.time)) : "",
    c.cost ? theme.fg("dim", (e.cost ? money(e.cost) : "").padStart(c.cost)) : ""].filter(Boolean).join(" ");
  return `${selected ? theme.fg("accent", "→") : " "} ${theme.fg(e.tone, e.glyph)}${mark}${name}${gap}${c.role ? `${theme.fg("muted", fit(e.role, c.role))}${gap}` : ""}`
    + `${fit(e.state, c.state)}${gap}${numbers ? `${numbers}${gap}` : ""}${e.title}`;
}

export type ListLine = { kind: "gap" } | { kind: "section"; section: Section; count: number } | { kind: "entry"; entry: Entry; index: number };
/** Section headers and rows, scrolled so the selection stays in a window of `max` lines. */
export function listLines(items: Entry[], selected: number, max: number, spaced = false): { lines: ListLine[]; above: number; below: number } {
  const all: ListLine[] = [];
  items.forEach((entry, index) => {
    if (entry.section !== items[index - 1]?.section) {
      if (spaced && index) all.push({ kind: "gap" });
      all.push({ kind: "section", section: entry.section, count: items.filter(e => e.section === entry.section).length });
    }
    all.push({ kind: "entry", entry, index });
  });
  if (all.length <= max) return { lines: all, above: 0, below: 0 };
  const at = all.findIndex(l => l.kind === "entry" && l.index === selected);
  // Keep the selected row's header in view when it fits.
  let start = Math.max(0, Math.min(at - Math.floor(max / 2), all.length - max));
  if (max > 1 && at > 0 && all[at - 1].kind === "section" && start === at) start--;
  return { lines: all.slice(start, start + max), above: start, below: all.length - start - max };
}

/** Where typed text goes for the selected entry, or why it cannot. */
export function replyTarget(e: Entry | undefined, run?: { owner: string; activeTask?: string; status: string }):
  { mode: "steer" | "followup"; label: string } | { mode: "none"; reason: string } {
  if (!e) return { mode: "none", reason: "" };
  if (e.kind === "peer") return { mode: "none", reason: "Another session: → opens its pane to type there" };
  if (!run || run.status === "closed") return { mode: "none", reason: "Terminal closed" };
  if (run.owner === "human") return { mode: "none", reason: "Yours: → opens its pane to type there" };
  if (run.owner !== "managed") return { mode: "none", reason: "No longer parent-managed: → opens its pane; /take there to continue" };
  return run.activeTask ? { mode: "steer", label: `Steer ${e.name}'s task` } : { mode: "followup", label: `New task for ${e.name}` };
}

/** Blank lines and pure rules (editor borders, separators) carry nothing in a peek. */
const CHROME = /^[\s─━│┃╌┄┈╭╮╰╯┌┐└┘├┤═║…]*$/;
/** The last `count` meaningful lines of a terminal capture. */
export function tailLines(text: string, count: number) {
  return text.replace(/\r/g, "").split("\n").filter(line => !CHROME.test(line)).map(line => line.trimEnd()).slice(-count);
}

/**
 * ← on an empty prompt opens the hub. Right after the prompt was emptied
 * (deleting text, leaving history) a first press only arms it, so a held
 * backspace or ← cannot jump away by accident.
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

export type HubAction = "open" | "pin" | "cancel" | "close" | "park" | "auto" | "grid" | "take" | "result";
/** Keys while the reply box is empty; anything printable starts a reply instead. `stop` cancels a task, or closes an idle child. */
export const COMMANDS: Record<string, HubAction | "stop"> = { "ctrl+t": "pin", "ctrl+x": "stop", "ctrl+p": "park", "ctrl+a": "auto", "ctrl+g": "grid", "ctrl+o": "take", "ctrl+r": "result" };
/** Destructive or irreversible actions ask for the same key again. */
export const CONFIRM: Partial<Record<HubAction | "stop", true>> = { stop: true, take: true };
export const HELP = [
  ["↑ ↓", "move (the peek follows)"], ["space", "peek: screen, question or result"], ["→ / enter", "open its pane (← on its empty prompt comes back)"],
  ["type", "steer the running task, or start a follow-up when idle"], ["ctrl+t", "pin to the deck, or unpin"], ["ctrl+x ×2", "cancel the task; when idle, close the terminal"],
  ["ctrl+p / ctrl+a", "park (detach, keeps running) / back to automatic placement"], ["ctrl+g", "show the Agents window"],
  ["ctrl+r", "print the latest result into this transcript"], ["ctrl+o ×2", "take human control of an idle child"], ["← / esc", "back to the prompt"],
] as const;
