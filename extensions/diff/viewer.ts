// The diff pane: a standalone terminal program that Rex runs beside Pi.
// Usage: node viewer.ts --root DIR --ipc DIR --pi-pid PID [--palette JSON] [--source NAME] [--highlighter FILE] [--focus FILE]
import { mkdirSync, readFileSync, realpathSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { changedHunks, collect, SOURCES, type Collected, type FileDiff, type Source, type Untracked } from "./git.ts";
import { DEFAULT_PALETTE, fileBody, layout, maxScroll, sameTarget, type Layout, type Palette, type Target, type View } from "./render.ts";
import { loadHighlighter } from "./syntax.ts";
import { decoder } from "./terminal.ts";
import { paint } from "./text.ts";

const { values } = parseArgs({ options: {
  root: { type: "string" }, ipc: { type: "string" }, "pi-pid": { type: "string" },
  palette: { type: "string" }, source: { type: "string" }, highlighter: { type: "string" }, focus: { type: "string" },
} });
if (!values.root || !values.ipc || !values["pi-pid"]) {
  console.error("Usage: viewer.ts --root DIR --ipc DIR --pi-pid PID [--palette JSON] [--source NAME]");
  process.exit(2);
}
/** The working tree shown; Pi moves it when its session moves to another worktree. */
let root = realpathSync(values.root);
const ipc = values.ipc;
const piPid = Number(values["pi-pid"]);
const tickName = `${piPid}.tick`;
const pidFile = join(ipc, `${piPid}.viewer`);
let palette: Palette = { ...DEFAULT_PALETTE, ...(values.palette ? JSON.parse(values.palette) : {}) };

const out = process.stdout;
const view: View = {
  loading: true, selected: 0, scroll: 0, wrap: true, follow: true, help: false,
  columns: out.columns || 80, rows: out.rows || 24, palette,
  highlighter: loadHighlighter(values.highlighter),
};
let source: Source = SOURCES.includes(values.source as Source) ? values.source as Source : "uncommitted";
let screen: string[] = [];
let current: Layout | undefined;
/** The last file Pi edited, relative to the root, for `f` to return to. */
let lastEdited: string | undefined;

// ── Terminal ────────────────────────────────────────────────────────────────

function draw(full = false) {
  view.columns = out.columns || 80;
  view.rows = out.rows || 24;
  current = layout(view);
  const lines = current.rows.map((row) => paint(row, view.columns));
  if (full) screen = [];
  let frame = "\x1b[?2026h";
  lines.forEach((line, i) => { if (screen[i] !== line) frame += `\x1b[${i + 1};1H${line}`; });
  frame += "\x1b[?2026l";
  screen = lines;
  out.write(frame);
}

const RESIZE_SETTLE_MS = 120;
const RESTORE = "\x1b[0m\x1b]22;default\x1b\\\x1b[?1004l\x1b[?1003l\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[?1049l";
let closing = false;
function quit(code = 0) {
  if (closing) return;
  closing = true;
  out.write(RESTORE);
  try { if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) rmSync(pidFile); } catch {}
  process.exit(code);
}

// ── Navigation ──────────────────────────────────────────────────────────────

const files = () => view.snapshot?.files ?? [];
const selectedFile = (): FileDiff | undefined => files()[view.selected];
const page = () => Math.max(1, current?.body.height ?? 10);

function clampScroll() {
  const file = selectedFile();
  const rows = file ? fileBody(file, view).rows.length : 0;
  view.scroll = Math.max(0, Math.min(view.scroll, maxScroll(rows, page())));
}

function scrollBy(delta: number) {
  view.scroll += delta;
  clampScroll();
}

/** Where each file was scrolled to, so returning to it picks up there. */
const positions = new Map<string, number>();

function select(index: number) {
  const count = files().length;
  if (!count) return;
  const from = selectedFile();
  if (from) positions.set(from.path, view.scroll);
  view.selected = (index + count) % count;
  view.scroll = positions.get(selectedFile()!.path) ?? 0;
  clampScroll();
}

/** Moves to the next or previous change, on into the next or previous file. */
function hunk(direction: 1 | -1) {
  const file = selectedFile();
  if (!file) return;
  const { rows, hunks: starts } = fileBody(file, view);
  const limit = maxScroll(rows.length, page());
  // The top row sits on a hunk's separator or just above its first line.
  const target = direction > 0 ? starts.find((row) => row > view.scroll + 1) : starts.findLast((row) => row < view.scroll);
  // Short files show every change at once, so a step goes straight to the next file.
  if (target !== undefined && (direction < 0 ? limit > 0 : Math.min(target, limit) > view.scroll)) view.scroll = target;
  else if (direction > 0) { select(view.selected + 1); view.scroll = 0; }
  else { select(view.selected - 1); view.scroll = fileBody(selectedFile()!, view).hunks.at(-1) ?? 0; }
  clampScroll();
}

/** Selects a file by path and shows its first hunk that changed since `before`. */
function focus(path: string, before?: FileDiff) {
  const index = files().findIndex((file) => file.path === path);
  if (index < 0) return;
  const file = files()[index];
  if (index !== view.selected || !before) view.scroll = 0;
  view.selected = index;
  const changed = changedHunks(before, file);
  if (changed.length) view.scroll = Math.max(0, fileBody(file, view).hunks[changed[0]] - 1);
  clampScroll();
}

/** Manual navigation pauses following until `f` or Pi's next turn. */
function manual(action: () => void) {
  view.follow = false;
  action();
}

// ── Refresh ─────────────────────────────────────────────────────────────────

let running = false;
let queued = false;
let queuedFocus: string | undefined;
let signature = "";
/** Untracked files already read from this root, so a refresh reads only what changed. */
const seen: Untracked = new Map();

async function refresh(focusPath?: string) {
  if (focusPath) queuedFocus = focusPath;
  if (running) { queued = true; return; }
  running = true;
  try {
    do {
      queued = false;
      const target = queuedFocus;
      queuedFocus = undefined;
      const from = root;
      let next: Collected | undefined, error: string | undefined;
      try { next = await collect(from, source, undefined, seen); }
      catch (failure) { error = (failure as Error).message; }
      if (from !== root) { queued = true; continue; } // Moved meanwhile: collect again there.
      const nextSignature = error ?? next!.signature;
      if (nextSignature === signature && !target) continue;
      signature = nextSignature;
      apply(next, error, target);
      draw();
    } while (queued);
  } finally {
    running = false;
  }
}

function apply(next: Collected | undefined, error: string | undefined, target?: string) {
  const previous = view.snapshot;
  const keep = selectedFile()?.path;
  view.loading = false;
  view.error = error;
  if (!next) return;
  view.snapshot = next;
  const before = (path: string) => previous?.source === next.source ? previous.files.find((file) => file.path === path) : undefined;
  const kept = keep ? next.files.findIndex((file) => file.path === keep) : -1;
  if (kept >= 0) view.selected = kept;
  else { view.selected = Math.min(view.selected, Math.max(0, next.files.length - 1)); view.scroll = 0; }
  if (target && view.follow) focus(target, before(target));
  clampScroll();
}

function relativePath(path: string): string | undefined {
  let absolute = path;
  try { absolute = realpathSync(path); } catch {}
  const inside = relative(root, absolute);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.split("\\").join("/") : undefined;
}

/** Shows another working tree, as if the pane had just opened there. */
function moveTo(next: string) {
  let resolved: string;
  try { resolved = realpathSync(next); } catch { return; }
  if (resolved === root) return;
  root = resolved;
  tree?.close();
  tree = watchTree();
  positions.clear();
  seen.clear();
  lastEdited = undefined;
  view.snapshot = undefined;
  view.selected = 0;
  view.scroll = 0;
  view.loading = true;
  view.follow = true;
  signature = "";
  draw();
}

function onTick() {
  let message: { event?: string; path?: string; root?: string } = {};
  try { message = JSON.parse(readFileSync(join(ipc, tickName), "utf8")); } catch {}
  if (message.event === "quit") { quit(); return; }
  if (message.event === "root" && message.root) moveTo(message.root);
  if (message.event === "agent_start") { view.follow = true; draw(); }
  const path = message.path ? relativePath(message.path) : undefined;
  if (path) lastEdited = path;
  void refresh(path);
}

let debounce: ReturnType<typeof setTimeout> | undefined;
function schedule() {
  clearTimeout(debounce);
  debounce = setTimeout(() => void refresh(), 150);
}

const IGNORED = /(^|\/)(node_modules|target|\.venv|__pycache__)(\/|$)|^\.git\/(objects|logs|lfs|fsmonitor)/;
const GIT_STATE = /^\.git\/(index|HEAD|refs\/)/;
function watchTree(): FSWatcher | undefined {
  try {
    return watch(root, { recursive: true }, (_event, name) => {
      const path = name ? String(name).split("\\").join("/") : "";
      if (path && (IGNORED.test(path) || (path.startsWith(".git/") && !GIT_STATE.test(path)))) return;
      schedule();
    });
  } catch {
    return undefined;
  }
}

// ── Input ───────────────────────────────────────────────────────────────────

function key(name: string) {
  if (view.help && name !== "?" && name !== "q" && name !== "ctrl-c") { view.help = false; draw(); return; }
  switch (name) {
    case "q": case "ctrl-c": quit(); return;
    case "?": view.help = !view.help; break;
    case "j": case "down": case "ctrl-e": manual(() => scrollBy(1)); break;
    case "k": case "up": case "ctrl-y": manual(() => scrollBy(-1)); break;
    case "d": case "ctrl-d": manual(() => scrollBy(Math.floor(page() / 2))); break;
    case "u": case "ctrl-u": manual(() => scrollBy(-Math.floor(page() / 2))); break;
    case " ": case "pagedown": case "ctrl-f": manual(() => scrollBy(page() - 2)); break;
    case "b": case "pageup": case "ctrl-b": manual(() => scrollBy(-(page() - 2))); break;
    case "g": case "home": manual(() => { view.scroll = 0; }); break;
    case "G": case "end": manual(() => { view.scroll = Number.MAX_SAFE_INTEGER; clampScroll(); }); break;
    case "]": case "tab": case "J": case "right": case "l": manual(() => select(view.selected + 1)); break;
    case "[": case "shift-tab": case "K": case "left": case "h": manual(() => select(view.selected - 1)); break;
    case "n": case "shift-down": manual(() => hunk(1)); break;
    case "p": case "N": case "shift-up": manual(() => hunk(-1)); break;
    case "blur": pointAt(undefined); return;
    case "w": view.wrap = !view.wrap; view.scroll = 0; break;
    case "f":
      view.follow = !view.follow;
      if (view.follow && lastEdited) focus(lastEdited);
      break;
    case "s": cycleSource(); return;
    case "r": signature = ""; seen.clear(); void refresh(); return;
    default: return;
  }
  draw();
}

function cycleSource() {
  source = SOURCES[(SOURCES.indexOf(source) + 1) % SOURCES.length];
  view.selected = 0;
  view.scroll = 0;
  view.loading = true;
  signature = "";
  draw();
  void refresh();
}

/** What is under a cell, by 0-based column and row. */
function hit(x: number, y: number): Target | undefined {
  if (!current || view.help) return undefined;
  const { list, source, keys, scrollbar } = current;
  if (y === source.row && x >= source.from && view.snapshot) return { area: "source" };
  if (y >= list.top && y < list.top + list.height) {
    const index = list.first + (y - list.top);
    const hint = files().length > list.height && y === list.top + list.height - 1;
    return index < files().length && !hint ? { area: "file", index } : undefined;
  }
  if (keys && y === keys.row) {
    const item = keys.items.find((candidate) => x >= candidate.from && x < candidate.to);
    return item && { area: "key", key: item.key };
  }
  if (scrollbar && x === scrollbar.column && y >= scrollbar.top && y < scrollbar.top + scrollbar.height) return { area: "scrollbar" };
  return undefined;
}

/** Highlights what the pointer is over, and shows a hand where a click does something. */
function pointAt(target: Target | undefined) {
  if (sameTarget(target, view.hover)) return;
  const was = view.hover !== undefined;
  view.hover = target;
  if (was !== (target !== undefined)) out.write(`\x1b]22;${target ? "pointer" : "default"}\x1b\\`);
  draw();
}

let dragging = false;
function scrollTo(y: number) {
  const bar = current?.scrollbar;
  if (!bar) return;
  const share = Math.min(1, Math.max(0, (y - bar.top) / Math.max(1, bar.height - 1)));
  manual(() => { view.scroll = Math.round(share * maxScroll(current!.body.total, bar.height)); clampScroll(); });
  draw();
}

function mouse(button: number, column: number, row: number, press: boolean) {
  if (!current) return;
  const x = column - 1, y = row - 1;
  const motion = (button & 32) !== 0, code = button & ~32 & ~28; // Ignore shift, alt and ctrl.
  if (motion) {
    if (dragging && code === 0) scrollTo(y);
    else pointAt(hit(x, y));
    return;
  }
  if (!press) { dragging = false; return; }
  const inList = y >= current.list.top && y < current.list.top + current.list.height;
  if (code === 64 || code === 65) {
    const delta = code === 64 ? -3 : 3;
    if (inList) manual(() => select(view.selected + Math.sign(delta)));
    else manual(() => scrollBy(delta));
    draw();
    return;
  }
  if (code !== 0) return;
  const target = hit(x, y);
  if (target?.area === "source") cycleSource();
  else if (target?.area === "key") key(target.key);
  else if (target?.area === "scrollbar") { dragging = true; scrollTo(y); }
  else if (target?.area === "file") { manual(() => select(target.index)); draw(); }
}

const input = decoder({ key, mouse, background: (bg) => { palette = view.palette = { ...palette, bg }; draw(true); } });

// ── Start ───────────────────────────────────────────────────────────────────

mkdirSync(ipc, { recursive: true, mode: 0o700 });
writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
process.title = "pi-diff";
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => quit());
process.on("uncaughtException", (error) => {
  out.write(RESTORE);
  console.error(error);
  closing = true;
  try { rmSync(pidFile); } catch {}
  process.exit(1);
});

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", input);
out.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[2J\x1b]11;?\x1b\\");
// Rex passes a new pane through more than one size as it settles, so wait for
// the last one, and leave the screen alone if that is the size already drawn.
let resized: ReturnType<typeof setTimeout> | undefined;
out.on("resize", () => {
  clearTimeout(resized);
  resized = setTimeout(() => {
    if (out.columns === view.columns && out.rows === view.rows) return;
    clampScroll();
    draw(true);
  }, RESIZE_SETTLE_MS);
});
draw(true);

let tree = watchTree();
watch(ipc, (_event, name) => { if (String(name) === tickName) onTick(); });
setInterval(() => void refresh(), tree ? 10_000 : 3_000).unref();
// Pi says when it quits; this catches a Pi that crashed or was killed.
setInterval(() => {
  try { process.kill(piPid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") quit(); }
}, 250);
lastEdited = values.focus ? relativePath(values.focus) : undefined;
void refresh(lastEdited);
