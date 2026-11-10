// Draws Pi's built-in tool rows by what the action did: lookups (read, grep,
// find, ls) as one quiet line, changes (edit, write) and commands (bash) in a
// light frame with the outcome on the top rule. Execution is untouched; only
// the renderers change. See docs/tool-frames.md.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { formatReadLineRange, getLanguageFromPath, highlightCode, renderDiff, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
  absolutePath, clip, diffExcerpt, diffStats, DIVIDER, displayPath, fit, formatDuration, frame, grepStats, listedEntries, plural, readLines, row, shellResult, splitCommand,
  type BodyLine, type Measure,
} from "./layout.ts";

const measure: Measure = {
  width: visibleWidth,
  truncate: (text, width) => truncateToWidth(text, width, "…"),
  wrap: (text, width) => wrapTextWithAnsi(text, width),
};
const HOME = homedir();
// Collapsed rows show this much; ctrl+o expands every row.
const DIFF_LINES = 10;
const WRITE_LINES = 6;
const COMMAND_LINES = 2;
const OUTPUT_LINES = 5;
const ERROR_LINES = 4;
// Lookups finish in milliseconds; their time only matters when it was slow.
const QUIET_MS = 100;

type Result = { content: Array<{ type: string; text?: string }>; details?: any };
type RenderContext = {
  args: any; state: any; lastComponent?: Component; invalidate(): void; toolCallId: string; cwd: string;
  executionStarted: boolean; argsComplete: boolean; isPartial: boolean; expanded: boolean; isError: boolean;
  durationMs?: number; outputPad: number; keyHint(id: string, description: string): string;
};
/** Everything a row draws from, gathered from the latest call and result renders. */
type View = {
  args: any; result?: Result; theme: Theme; cwd: string; expanded: boolean; isError: boolean;
  started: boolean; done: boolean; elapsedMs?: number; hint: string;
};
/** A row's lines; lookups split theirs between Pi's call and result slots. */
type Drawn = string[] | { head: string[]; body: string[] };
type Draw = (view: View, width: number) => Drawn;

/**
 * One of a tool row's two slots, drawn from the row's shared state at render
 * time. Both slots share one drawing per update and width.
 */
class Row implements Component {
  state: any;
  draw: Draw;
  part: "head" | "body";
  constructor(state: any, draw: Draw, part: "head" | "body") { this.state = state; this.draw = draw; this.part = part; }
  render(width: number): string[] {
    const { version, context, theme } = this.state;
    let memo = this.state.drawn;
    if (memo?.width !== width || memo.version !== version) {
      const pad = Math.min(context.outputPad ?? 1, Math.max(0, Math.floor((width - 1) / 2)));
      const result: Result | undefined = this.state.result;
      const done = !!result && !context.isPartial;
      const startedAt: number | undefined = this.state.startedAt;
      const view: View = {
        args: context.args ?? {}, result, theme, cwd: context.cwd, expanded: !!context.expanded, isError: !!context.isError,
        started: !!context.executionStarted, done,
        elapsedMs: done ? context.durationMs ?? (startedAt !== undefined ? (this.state.endedAt ?? Date.now()) - startedAt : undefined)
          : startedAt !== undefined ? Date.now() - startedAt : undefined,
        hint: context.keyHint("app.tools.expand", "to expand"),
      };
      const drawn = this.draw(view, width - pad * 2);
      const indent = (lines: string[]) => lines.map((line) => " ".repeat(pad) + line);
      memo = this.state.drawn = Array.isArray(drawn) ? { width, version, head: indent(drawn), body: [] } : { width, version, head: indent(drawn.head), body: indent(drawn.body) };
    }
    return memo[this.part];
  }
  invalidate() { this.state.drawn = undefined; }
}

/** Keeps a running command's elapsed time ticking until its result settles. */
function tick(context: RenderContext, live: boolean) {
  const state = context.state;
  if (context.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
  const done = !!state.result && !context.isPartial;
  if (done || context.isError) {
    state.endedAt ??= Date.now();
    if (state.timer) { clearInterval(state.timer); state.timer = undefined; }
  } else if (live && state.startedAt !== undefined && !state.timer) {
    state.timer = setInterval(() => context.invalidate(), 1000);
    state.timer.unref?.();
  }
}

/**
 * Pi composes a tool row from a call slot and a result slot. A frame spans
 * both, so the call slot draws it whole from shared state once the result is
 * in; the result slot only carries a lookup's detail lines. HTML export draws
 * each slot once, before and after the result, which those detail lines suit.
 */
function renderers(draw: Draw, live = false) {
  const update = (theme: Theme, context: RenderContext) => {
    const state = context.state;
    state.context = context;
    state.theme = theme;
    state.version = (state.version ?? 0) + 1;
    tick(context, live);
  };
  const slot = (context: RenderContext, part: "head" | "body") => {
    const component = context.lastComponent instanceof Row ? context.lastComponent : new Row(context.state, draw, part);
    component.state = context.state;
    return component;
  };
  return {
    renderShell: "self" as const,
    renderCall(_args: unknown, theme: Theme, context: RenderContext) {
      update(theme, context);
      return slot(context, "head");
    },
    renderResult(result: Result, _options: unknown, theme: Theme, context: RenderContext) {
      context.state.result = result;
      update(theme, context);
      return slot(context, "body");
    },
  };
}

// ── shared pieces ─────────────────────────────────────────────────────────

const text = (result?: Result) => (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
const tabs = (line: string) => line.replace(/\t/g, "   ");
const str = (value: unknown) => typeof value === "string" ? value : "";

function path(theme: Theme, raw: string, cwd: string): string {
  if (!raw) return theme.fg("dim", "…");
  const shown = theme.fg("accent", displayPath(raw, cwd, HOME));
  if (!getCapabilities().hyperlinks) return shown;
  return hyperlink(shown, pathToFileURL(absolutePath(raw, cwd, HOME)).href);
}

function title(theme: Theme, glyph: string, name: string, subject: string) {
  return `${glyph} ${theme.fg("toolTitle", theme.bold(name))}${subject ? ` ${subject}` : ""}`;
}

function elapsed(theme: Theme, view: View, quiet = false): string {
  if (view.elapsedMs === undefined || (quiet && view.elapsedMs < QUIET_MS)) return "";
  return theme.fg("dim", formatDuration(view.elapsedMs));
}

const join = (theme: Theme, ...parts: string[]) => parts.filter(Boolean).join(theme.fg("dim", " · "));

/** "… 3 more lines · ctrl+o to expand"; `what` is the singular after the count. */
function more(view: View, hidden: number, what = "more line"): string {
  return `${view.theme.fg("dim", `… ${plural(hidden, what)} ·`)} ${view.hint}`;
}

function errorLines(view: View): string[] {
  const lines = text(view.result).trim().split("\n").map((line) => view.theme.fg("error", tabs(line)));
  if (view.expanded) return lines;
  const { shown, hidden } = clip(lines, ERROR_LINES);
  return hidden ? [...shown, more(view, hidden)] : shown;
}

function highlight(content: string, rawPath: string): string[] {
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  const source = tabs(content.replace(/\r/g, ""));
  return lang ? highlightCode(source, lang) : source.split("\n");
}

// ── lookups: one line, detail on expand ───────────────────────────────────

function lookup(view: View, width: number, name: string, subject: string, outcome: string, detail: () => string[]): Drawn {
  const { theme } = view;
  const glyph = view.isError ? theme.fg("error", "✗") : view.done ? theme.fg("success", "●") : theme.fg("dim", "○");
  const head = [row(measure, width, title(theme, glyph, name, subject), view.isError ? "" : join(theme, outcome, elapsed(theme, view, true)))];
  const body = view.isError && view.done ? errorLines(view) : view.expanded && view.done ? detail() : [];
  return { head, body: fit(measure, body, Math.max(1, width - 2), view.expanded).map((line) => `  ${line}`) };
}

const read: Draw = (view, width) => {
  const { theme, args, result } = view;
  const raw = str(args.path ?? args.file_path);
  const range = formatReadLineRange(args.offset, args.limit);
  const skill = basename(raw) === "SKILL.md";
  const subject = skill ? theme.fg("accent", basename(dirname(raw))) : `${path(theme, raw, view.cwd)}${range ? theme.fg("dim", range) : ""}`;
  let outcome = "";
  if (view.done && result) {
    const truncation = result.details?.truncation;
    if (result.content.some((part) => part.type === "image")) outcome = "image";
    else if (truncation?.truncated) outcome = `${truncation.outputLines} of ${plural(truncation.totalLines, "line")}`;
    else outcome = plural(readLines(text(result)), "line");
  }
  return lookup(view, width, skill ? "skill" : "read", subject, theme.fg("dim", outcome), () => highlight(text(result).replace(/\n+$/, ""), raw));
};

const grep: Draw = (view, width) => {
  const { theme, args, result } = view;
  const where = str(args.path) ? ` in ${displayPath(str(args.path), view.cwd, HOME)}` : "";
  const glob = str(args.glob) ? ` (${args.glob})` : "";
  const subject = `${theme.fg("accent", `/${str(args.pattern)}/`)}${theme.fg("dim", where + glob)}`;
  const output = text(result);
  const { hits, files } = grepStats(output);
  const limited = result?.details?.matchLimitReached || result?.details?.truncation?.truncated;
  const outcome = !view.done ? "" : hits ? join(theme, theme.fg("dim", plural(hits, "hit")), theme.fg("dim", plural(files, "file")), limited ? theme.fg("warning", "limit") : "") : theme.fg("dim", "no matches");
  return lookup(view, width, "grep", subject, outcome, () => output.trim().split("\n").map((line) => theme.fg("toolOutput", tabs(line))));
};

function listing(name: "find" | "ls", noun: [string, string], limitKey: string): Draw {
  return (view, width) => {
    const { theme, args, result } = view;
    const where = displayPath(str(args.path) || ".", view.cwd, HOME);
    const subject = name === "find"
      ? `${theme.fg("accent", str(args.pattern))}${theme.fg("dim", ` in ${where}`)}`
      : path(theme, str(args.path) || ".", view.cwd);
    const output = text(result);
    const limited = result?.details?.[limitKey] || result?.details?.truncation?.truncated;
    const outcome = view.done ? join(theme, theme.fg("dim", plural(listedEntries(output), ...noun)), limited ? theme.fg("warning", "limit") : "") : "";
    return lookup(view, width, name, subject, outcome, () => output.trim().split("\n").map((line) => theme.fg("toolOutput", line)));
  };
}

// ── changes and commands: framed ──────────────────────────────────────────

function boxed(view: View, width: number, heading: string, meta: string, body: BodyLine[], failed: boolean): string[] {
  const { theme } = view;
  return frame(measure, { width, title: heading, meta, body, paint: (s) => theme.fg(failed ? "error" : "borderMuted", s) });
}

const edit: Draw = (view, width) => {
  const { theme, args, result } = view;
  const raw = str(args.path ?? args.file_path);
  const count = Array.isArray(args.edits) ? args.edits.length : 1;
  const glyph = view.isError ? theme.fg("error", "✗") : theme.fg("warning", "✎");
  const heading = title(theme, glyph, count > 1 ? `edit ×${count}` : "edit", path(theme, raw, view.cwd));
  const inner = width - 4;
  if (!view.done) return boxed(view, width, heading, theme.fg("dim", "editing…"), [], false);
  if (view.isError) return boxed(view, width, heading, theme.fg("error", "failed"), fit(measure, errorLines(view), inner, true), true);
  const diff = str(result?.details?.diff);
  const { added, removed } = diffStats(diff);
  const meta = join(theme, `${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `−${removed}`)}`, elapsed(theme, view, true));
  if (!diff) return boxed(view, width, heading, meta, [], false);
  if (view.expanded) return boxed(view, width, heading, meta, fit(measure, renderDiff(diff).split("\n"), inner, true), false);
  const { shown, hidden } = diffExcerpt(diff, DIFF_LINES);
  const body = fit(measure, renderDiff(shown.join("\n")).split("\n"), inner, false);
  return boxed(view, width, heading, meta, hidden ? [...body, more(view, hidden, "more changed line")] : body, false);
};

const write: Draw = (view, width) => {
  const { theme, args, result } = view;
  const raw = str(args.path ?? args.file_path);
  const content = str(args.content).replace(/\n+$/, "");
  const lines = content ? content.split("\n").length : 0;
  const glyph = view.isError ? theme.fg("error", "✗") : theme.fg("success", "+");
  const heading = title(theme, glyph, "write", path(theme, raw, view.cwd));
  const inner = width - 4;
  if (view.done && view.isError) return boxed(view, width, heading, theme.fg("error", "failed"), fit(measure, errorLines(view), inner, true), true);
  const created = result?.details?.created;
  const state = !view.done ? "writing…" : created === true ? "new" : created === false ? "rewrote" : "";
  const meta = join(theme, theme.fg("dim", state), theme.fg("dim", plural(lines, "line")), elapsed(theme, view, true));
  if (view.expanded) return boxed(view, width, heading, meta, fit(measure, highlight(content, raw), inner, true), false);
  // Highlight only the excerpt: a large file streams in on every keystroke of the model.
  const { shown, hidden } = clip(content.split("\n"), WRITE_LINES);
  const body = content ? fit(measure, highlight(shown.join("\n"), raw), inner, false) : [];
  return boxed(view, width, heading, meta, hidden ? [...body, more(view, hidden)] : body, false);
};

const bash: Draw = (view, width) => {
  const { theme, args, result } = view;
  const command = splitCommand(str(args.command), view.cwd, HOME);
  const heading = `${theme.fg("accent", "$")} ${theme.fg("toolTitle", theme.bold(command.title || "…"))}`;
  const inner = width - 4;
  const { output, status, fullOutputPath } = shellResult(text(result), view.isError);
  const time = elapsed(theme, view);
  let meta: string;
  let failed = false;
  if (!view.done) meta = view.started ? join(theme, theme.fg("muted", "running"), time) : "";
  else if (status.kind === "ok") meta = [theme.fg("success", "✓"), time].filter(Boolean).join(" ");
  else if (status.kind === "exit") { meta = join(theme, theme.fg("error", `exit ${status.code}`), time); failed = true; }
  else if (status.kind === "timeout") { meta = theme.fg("error", `timed out · ${status.seconds}s`); failed = true; }
  else if (status.kind === "aborted") meta = join(theme, theme.fg("warning", "aborted"), time);
  else { meta = join(theme, theme.fg("error", "failed"), time); failed = true; }

  const body: BodyLine[] = [];
  const rest = command.rest.map((line) => theme.fg("muted", tabs(line)));
  if (view.expanded) body.push(...fit(measure, rest, inner, true));
  else {
    const { shown, hidden } = clip(rest, COMMAND_LINES);
    body.push(...fit(measure, shown, inner, false));
    if (hidden) body.push(more(view, hidden, "more command line"));
  }
  const printed = output ? fit(measure, output.split("\n").map((line) => theme.fg("toolOutput", tabs(line))), inner, true) : [];
  if (body.length && printed.length) body.push(DIVIDER);
  if (view.expanded) body.push(...printed);
  else {
    const { shown, hidden } = clip(printed, OUTPUT_LINES, "end");
    if (hidden) body.push(more(view, hidden, "earlier line"));
    body.push(...shown);
  }
  if (fullOutputPath) body.push(theme.fg("dim", `full output: ${displayPath(fullOutputPath, view.cwd, HOME)}`));
  return boxed(view, width, heading, meta, body, failed);
};

const DRAW: Record<string, { draw: Draw; live?: boolean }> = {
  read: { draw: read },
  grep: { draw: grep },
  find: { draw: listing("find", ["file", "files"], "resultLimitReached") },
  ls: { draw: listing("ls", ["entry", "entries"], "entryLimitReached") },
  edit: { draw: edit },
  write: { draw: write },
  bash: { draw: bash, live: true },
};

export default function (pi: ExtensionAPI) {
  const table = Object.fromEntries(Object.entries(DRAW).map(([name, { draw, live }]) => [name, renderers(draw, live)]));
  pi.registerToolRenderer((toolName, next) => table[toolName] ?? next());

  // write's result does not say whether the file existed; note it before the
  // call so the row can say "new". Kept in details, which the model never sees.
  const existed = new Map<string, boolean>();
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "write") return;
    const raw = str((event.input as any)?.path ?? (event.input as any)?.file_path);
    if (raw) existed.set(event.toolCallId, existsSync(absolutePath(raw, ctx.cwd, HOME)));
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "write" || !existed.has(event.toolCallId)) return;
    const before = existed.get(event.toolCallId);
    existed.delete(event.toolCallId);
    if (event.isError) return;
    return { details: { ...(event.details as object | undefined), created: !before } };
  });
  // A call blocked before it ran has no result to collect its entry.
  pi.on("agent_end", () => existed.clear());
}
