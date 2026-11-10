// The diff pane: a standalone terminal program that Rex runs beside Pi.
// Usage: node viewer.ts --root DIR --ipc DIR --pi-pid PID [--palette JSON] [--source NAME] [--highlighter FILE] [--focus FILE]
import { mkdirSync, readFileSync, realpathSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { changedHunks, collect, SOURCES, type FileDiff, type Snapshot, type Source } from "./git.ts";
import { body, DEFAULT_PALETTE, layout, type Layout, type Palette, type View } from "./render.ts";
import { loadHighlighter } from "./syntax.ts";
import { paint } from "./text.ts";

const { values } = parseArgs({ options: {
  root: { type: "string" }, ipc: { type: "string" }, "pi-pid": { type: "string" },
  palette: { type: "string" }, source: { type: "string" }, highlighter: { type: "string" }, focus: { type: "string" },
} });
if (!values.root || !values.ipc || !values["pi-pid"]) {
  console.error("Usage: viewer.ts --root DIR --ipc DIR --pi-pid PID [--palette JSON] [--source NAME]");
  process.exit(2);
}
const root = realpathSync(values.root);
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

let closing = false;
function quit(code = 0) {
  if (closing) return;
  closing = true;
  out.write("\x1b[0m\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[?1049l");
  try { if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) rmSync(pidFile); } catch {}
  process.exit(code);
}

// ── Navigation ──────────────────────────────────────────────────────────────

const files = () => view.snapshot?.files ?? [];
const selectedFile = (): FileDiff | undefined => files()[view.selected];
const total = () => current?.body.total ?? 0;
const page = () => Math.max(1, current?.body.height ?? 10);

function clampScroll() {
  const file = selectedFile();
  const rows = file ? body(file, view.columns, view.wrap, palette, view.highlighter).rows.length : 0;
  view.scroll = Math.max(0, Math.min(view.scroll, rows - Math.max(1, page() - 2)));
}

function scrollBy(delta: number) {
  view.scroll += delta;
  clampScroll();
}

function select(index: number) {
  const count = files().length;
  if (!count) return;
  view.selected = (index + count) % count;
  view.scroll = 0;
}

function hunk(direction: 1 | -1) {
  const file = selectedFile();
  if (!file) return;
  const starts = body(file, view.columns, view.wrap, palette, view.highlighter).hunks;
  const target = direction > 0 ? starts.find((row) => row > view.scroll) : starts.findLast((row) => row < view.scroll);
  if (target !== undefined) view.scroll = target;
  else if (direction > 0) select(view.selected + 1);
  else if (view.selected > 0) { select(view.selected - 1); view.scroll = Number.MAX_SAFE_INTEGER; }
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
  if (changed.length) view.scroll = Math.max(0, body(file, view.columns, view.wrap, palette, view.highlighter).hunks[changed[0]] - 1);
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

async function refresh(focusPath?: string) {
  if (focusPath) queuedFocus = focusPath;
  if (running) { queued = true; return; }
  running = true;
  try {
    do {
      queued = false;
      const target = queuedFocus;
      queuedFocus = undefined;
      let next: Snapshot | undefined, error: string | undefined;
      try { next = await collect(root, source); }
      catch (failure) { error = (failure as Error).message; }
      const nextSignature = error ?? JSON.stringify(next);
      if (nextSignature === signature && !target) continue;
      signature = nextSignature;
      apply(next, error, target);
      draw();
    } while (queued);
  } finally {
    running = false;
  }
}

function apply(next: Snapshot | undefined, error: string | undefined, target?: string) {
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

function onTick() {
  let message: { event?: string; path?: string } = {};
  try { message = JSON.parse(readFileSync(join(ipc, tickName), "utf8")); } catch {}
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
    case "n": manual(() => hunk(1)); break;
    case "p": case "N": manual(() => hunk(-1)); break;
    case "w": view.wrap = !view.wrap; view.scroll = 0; break;
    case "f":
      view.follow = !view.follow;
      if (view.follow && lastEdited) focus(lastEdited);
      break;
    case "s": cycleSource(); return;
    case "r": signature = ""; void refresh(); return;
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

function mouse(button: number, column: number, row: number, press: boolean) {
  if (!current || !press) return;
  const y = row - 1;
  const inList = y >= current.list.top && y < current.list.top + current.list.height;
  if (button === 64 || button === 65) {
    const delta = button === 64 ? -3 : 3;
    if (inList) manual(() => select(view.selected + Math.sign(delta)));
    else manual(() => scrollBy(delta));
  } else if (button === 0) {
    if (y === current.source.row && column - 1 >= current.source.from) { cycleSource(); return; }
    if (inList) {
      const index = current.list.first + (y - current.list.top);
      if (index < files().length && (y < current.list.top + current.list.height - 1 || files().length <= current.list.height)) manual(() => select(index));
    } else return;
  } else return;
  draw();
}

const KEYS: Record<string, string> = {
  "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left", "\x1bOA": "up", "\x1bOB": "down",
  "\x1bOC": "right", "\x1bOD": "left", "\x1b[5~": "pageup", "\x1b[6~": "pagedown", "\x1b[H": "home", "\x1b[F": "end",
  "\x1b[1~": "home", "\x1b[4~": "end", "\x1bOH": "home", "\x1bOF": "end", "\x1b[Z": "shift-tab", "\t": "tab",
  "\x03": "ctrl-c", "\x04": "ctrl-d", "\x15": "ctrl-u", "\x06": "ctrl-f", "\x02": "ctrl-b", "\x05": "ctrl-e", "\x19": "ctrl-y",
};

function input(data: string) {
  for (let rest = data; rest.length;) {
    const color = /^\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(?:\x07|\x1b\\)/i.exec(rest);
    if (color) {
      const channel = (hex: string) => Math.round(parseInt(hex, 16) / (16 ** hex.length - 1) * 255).toString(16).padStart(2, "0");
      palette = view.palette = { ...palette, bg: `#${channel(color[1])}${channel(color[2])}${channel(color[3])}` };
      draw(true);
      rest = rest.slice(color[0].length);
      continue;
    }
    const pointer = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
    if (pointer) {
      mouse(Number(pointer[1]), Number(pointer[2]), Number(pointer[3]), pointer[4] === "M");
      rest = rest.slice(pointer[0].length);
      continue;
    }
    const sequence = /^(?:\x1b\[[0-9;?]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/.exec(rest);
    const token = sequence?.[0] ?? String.fromCodePoint(rest.codePointAt(0)!);
    rest = rest.slice(token.length);
    const name = KEYS[token] ?? (token.length === 1 && token >= " " ? token : undefined);
    if (name) key(name);
  }
}

// ── Start ───────────────────────────────────────────────────────────────────

mkdirSync(ipc, { recursive: true, mode: 0o700 });
writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
process.title = "pi-diff";
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => quit());
process.on("uncaughtException", (error) => {
  out.write("\x1b[0m\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[?1049l");
  console.error(error);
  closing = true;
  try { rmSync(pidFile); } catch {}
  process.exit(1);
});

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", input);
out.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[2J\x1b]11;?\x1b\\");
out.on("resize", () => { clampScroll(); draw(true); });
draw(true);

const tree = watchTree();
watch(ipc, (_event, name) => { if (String(name) === tickName) onTick(); });
setInterval(() => void refresh(), tree ? 10_000 : 3_000).unref();
setInterval(() => {
  try { process.kill(piPid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") quit(); }
}, 1_000);
lastEdited = values.focus ? relativePath(values.focus) : undefined;
void refresh(lastEdited);
