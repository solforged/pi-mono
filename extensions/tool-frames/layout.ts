// Layout and parsing for framed tool rows. No Pi imports, so the tests run
// under plain Node: terminal measurement comes in as a Measure.
import { isAbsolute, relative, resolve } from "node:path";

export interface Measure {
  width(text: string): number;
  truncate(text: string, width: number): string;
  wrap(text: string, width: number): string[];
}

/** A body line that draws as a dashed rule across the frame. */
export const DIVIDER = Symbol("divider");
export type BodyLine = string | typeof DIVIDER;

/** Below this width a frame has no room for content; rows draw unframed. */
export const MIN_FRAME_WIDTH = 24;

/** One line: `left` truncated to make room for `right`, which sits at the right edge. */
export function row(m: Measure, width: number, left: string, right = ""): string {
  const rw = right ? m.width(right) : 0;
  // Keep at least a short subject visible; drop the meta before the subject.
  if (!right || width - rw - 1 < 12) return m.truncate(left, width);
  const fitted = m.truncate(left, width - rw - 1);
  return fitted + " ".repeat(Math.max(1, width - m.width(fitted) - rw)) + right;
}

/**
 * A box whose top rule carries the title on the left and the meta on the
 * right: `╭─ title ───── meta ─╮`. `paint` colours the border characters only.
 */
export function frame(m: Measure, options: { width: number; title: string; meta?: string; body: BodyLine[]; paint: (text: string) => string }): string[] {
  const { width, title, meta = "", body, paint } = options;
  if (width < MIN_FRAME_WIDTH) {
    return [row(m, width, title, meta), ...body.filter((line): line is string => line !== DIVIDER).map((line) => m.truncate(line, width))];
  }
  const inner = width - 4;
  const end = meta ? ` ${meta} ${paint("─╮")}` : paint("╮");
  // "╭─ " + title + " " + at least one "─" + end
  const room = width - 3 - m.width(end) - 2;
  const shown = m.truncate(title, Math.max(1, room));
  const fill = width - 3 - m.width(shown) - 1 - m.width(end);
  const lines = [`${paint("╭─ ")}${shown} ${paint("─".repeat(Math.max(1, fill)))}${end}`];
  for (const line of body) {
    if (line === DIVIDER) { lines.push(paint(`├${"╌".repeat(width - 2)}┤`)); continue; }
    const text = m.truncate(line, inner);
    lines.push(`${paint("│")} ${text}${" ".repeat(Math.max(0, inner - m.width(text)))} ${paint("│")}`);
  }
  lines.push(paint(`╰${"─".repeat(width - 2)}╯`));
  return lines;
}

/** Wraps each line to `width` (expanded rows) or cuts it there (collapsed rows). */
export function fit(m: Measure, lines: string[], width: number, wrap: boolean): string[] {
  return wrap ? lines.flatMap((line) => line ? m.wrap(line, width) : [""]) : lines.map((line) => m.truncate(line, width));
}

/** `count` lines from the start or end, plus how many were left out. */
export function clip<T>(lines: T[], count: number, keep: "start" | "end" = "start"): { shown: T[]; hidden: number } {
  if (lines.length <= count) return { shown: lines, hidden: 0 };
  return { shown: keep === "start" ? lines.slice(0, count) : lines.slice(lines.length - count), hidden: lines.length - count };
}

/**
 * The last `count` rows of `lines` wrapped to `width`, plus how many lines and
 * rows come before them. Only the lines those rows come from are wrapped: a
 * running command redraws its row every second, and its output can be long.
 */
export function wrapTail(m: Measure, lines: string[], width: number, count: number): { shown: string[]; hidden: number } {
  const kept = clip(lines, count, "end");
  const rows = clip(fit(m, kept.shown, width, true), count, "end");
  return { shown: rows.shown, hidden: kept.hidden + rows.hidden };
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  return minutes < 60 ? `${minutes}m ${whole % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** A tool's path argument as the tool resolves it, `~` included. */
export function absolutePath(raw: string, cwd: string, home?: string): string {
  const expanded = home && (raw === "~" || raw.startsWith("~/")) ? home + raw.slice(1) : raw;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * A path as the reader wants it: relative inside the working directory,
 * home-relative outside it. Agents often pass absolute worktree paths.
 */
export function displayPath(raw: string, cwd: string, home?: string): string {
  if (!raw) return raw;
  const absolute = absolutePath(raw, cwd, home);
  const inside = relative(cwd, absolute);
  if (inside === "") return ".";
  if (!inside.startsWith("..") && !isAbsolute(inside)) return inside;
  if (home && (absolute === home || absolute.startsWith(`${home}/`))) return `~${absolute.slice(home.length)}`;
  return absolute;
}

// ── edit ──────────────────────────────────────────────────────────────────

const ADDED = /^\+\s*\d+ /;
const SKIP = "   ⋯";
const REMOVED = /^-\s*\d+ /;

/** Pi's edit diff: `+12 text`, `-12 text`, ` 12 text`, and `  ...` skips. */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (ADDED.test(line)) added++;
    else if (REMOVED.test(line)) removed++;
  }
  return { added, removed };
}

/**
 * The part of a diff a collapsed row shows: the changed lines with one line
 * of context around each run and a mark for each gap, cut at `count`, plus
 * how many changed lines that leaves out.
 * Pi's diff carries four context lines a side, which would fill a short
 * excerpt before the change starts.
 */
export function diffExcerpt(diff: string, count: number): { shown: string[]; hidden: number } {
  const lines = diff.split("\n");
  const changed = lines.map((line) => ADDED.test(line) || REMOVED.test(line));
  const near = (i: number) => changed[i] || changed[i - 1] || changed[i + 1];
  const kept: string[] = [];
  lines.forEach((line, i) => {
    if (near(i)) kept.push(line);
    else if (kept.length && near(i - 1)) kept.push(SKIP);
  });
  while (kept.at(-1) === SKIP) kept.pop();
  const { shown } = clip(kept, count);
  // Only changes count as hidden: context alone is not worth a hint.
  const changes = (list: string[]) => list.filter((line) => ADDED.test(line) || REMOVED.test(line)).length;
  return { shown, hidden: changes(lines) - changes(shown) };
}

// ── bash ──────────────────────────────────────────────────────────────────

export type ShellStatus =
  | { kind: "ok" }
  | { kind: "exit"; code: number }
  | { kind: "timeout"; seconds: number }
  | { kind: "aborted" }
  | { kind: "failed" };

// Pi appends one of these as the last line of the output it returns.
const STATUS = [
  { pattern: /\n?Command exited with code (\d+)\s*$/, status: (m: RegExpMatchArray): ShellStatus => ({ kind: "exit", code: Number(m[1]) }) },
  { pattern: /\n?Command timed out after (\d+) seconds[^\n]*\s*$/, status: (m: RegExpMatchArray): ShellStatus => ({ kind: "timeout", seconds: Number(m[1]) }) },
  { pattern: /\n?Command aborted\s*$/, status: (): ShellStatus => ({ kind: "aborted" }) },
  { pattern: /\n?Command terminated without an exit code\s*$/, status: (): ShellStatus => ({ kind: "failed" }) },
];
// The footer Pi adds when it saved the full output to a file.
const FULL_OUTPUT = /\n?\[(?:Showing [^\n]*)Full output: ([^\n\]]+)\]\s*$/;

/** Splits shell output into what the command printed and how it ended. */
export function shellResult(text: string, isError: boolean): { output: string; status: ShellStatus; fullOutputPath?: string } {
  // trimEnd is linear; /\s+$/ starts over at every space of a long run inside the output.
  let output = text.trimEnd();
  let status: ShellStatus = isError ? { kind: "failed" } : { kind: "ok" };
  for (const { pattern, status: read } of STATUS) {
    const match = output.match(pattern);
    if (match) { status = read(match); output = output.slice(0, match.index).trimEnd(); break; }
  }
  const full = output.match(FULL_OUTPUT);
  if (full) output = output.slice(0, full.index).trimEnd();
  if (output === "(no output)") output = "";
  return { output, status, fullOutputPath: full?.[1] };
}

/**
 * A command as a title line and the lines after it. A leading `cd <cwd> &&`
 * says nothing when it names the working directory, so it is dropped.
 */
export function splitCommand(command: string, cwd: string, home?: string): { title: string; rest: string[] } {
  let text = command.trim();
  const cd = text.match(/^cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*(&&|;)\s*/);
  if (cd) {
    const target = cd[2] ?? cd[3] ?? cd[4];
    if (displayPath(target, cwd, home) === ".") text = text.slice(cd[0].length);
  }
  const [title = "", ...rest] = text.split("\n");
  return { title, rest };
}

// ── read, grep, find, ls ──────────────────────────────────────────────────

/** The lines a read returned, without Pi's "[… Use offset=… to continue.]" notice. */
export function readLines(text: string): number {
  const body = text.replace(/\n*\[[^\n]*\bUse [^\n]*\]\s*$/, "").replace(/\n+$/, "");
  return body ? body.split("\n").length : 0;
}

/** Grep output is `path:line: text`, with `path-line- text` for context lines. */
export function grepStats(text: string): { hits: number; files: number } {
  const files = new Set<string>();
  let hits = 0;
  for (const line of text.split("\n")) {
    const match = line.match(/^(.+?):(\d+):/);
    if (!match) continue;
    hits++;
    files.add(match[1]);
  }
  return { hits, files: files.size };
}

/** Entries listed by find or ls, ignoring their empty-result and limit notices. */
export function listedEntries(text: string): number {
  return text.split("\n").filter((line) => line.trim() && !line.startsWith("[") && !/^No (files|matches) found|^\(empty directory\)$/.test(line)).length;
}
