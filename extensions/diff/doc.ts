// The document pane: a standalone terminal program that shows a Markdown file
// beside Pi, usually in the diff pane's place. See docs/diff.md.
// Usage: node doc.ts --file FILE --ipc DIR --pi-pid PID [--root DIR] [--anchor NAME]
//   [--palette JSON] [--highlighter FILE] [--marked FILE]
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { docUrl, parseDocUrl, resolveTarget } from "./links.ts";
import { docWidth, layoutDoc, loadMarked, plainLexer, renderDoc, type Doc, type DocLayout, type DocView } from "./markdown.ts";
import { DEFAULT_PALETTE, maxScroll, type Palette } from "./render.ts";
import { loadHighlighter } from "./syntax.ts";
import { decoder } from "./terminal.ts";
import { paint, width } from "./text.ts";

const { values } = parseArgs({ options: {
  file: { type: "string" }, ipc: { type: "string" }, "pi-pid": { type: "string" }, root: { type: "string" },
  anchor: { type: "string" }, palette: { type: "string" }, highlighter: { type: "string" }, marked: { type: "string" },
} });
if (!values.file || !values.ipc || !values["pi-pid"]) {
  console.error("Usage: doc.ts --file FILE --ipc DIR --pi-pid PID [--root DIR] [--anchor NAME]");
  process.exit(2);
}
const ipc = values.ipc;
const piPid = Number(values["pi-pid"]);
const messageName = `${piPid}.doc`;
const pidFile = join(ipc, `${piPid}.doc-viewer`);
const root = values.root;
const lexer = loadMarked(values.marked) ?? plainLexer;
const highlighter = loadHighlighter(values.highlighter);
let palette: Palette = { ...DEFAULT_PALETTE, ...(values.palette ? JSON.parse(values.palette) : {}) };

const out = process.stdout;
/** The document shown, and where each earlier one was scrolled to, for ⌫. */
let path = resolve(values.file);
const history: Array<{ path: string; scroll: number }> = [];
let source: string | undefined;
let error: string | undefined;
let rendered: { doc: Doc; key: string } | undefined;
const view: DocView = { title: "", scroll: 0, columns: out.columns || 80, rows: out.rows || 24, palette, help: false, back: false };
let current: DocLayout | undefined;
let screen: string[] = [];

const title = (file: string) => {
  const inside = root ? relative(root, file) : "";
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : file.replace(/^\/Users\/[^/]+/, "~");
};

/** Where a link in the document goes: Markdown opens here, anything else in its app. */
function linkFor(href: string): string | undefined {
  if (/^(https?|mailto):/i.test(href)) return href;
  if (href.startsWith("#")) return docUrl(piPid, path, href.slice(1));
  const target = resolveTarget(href, dirname(path));
  if (target) return docUrl(piPid, target.path, target.anchor);
  if (/^[a-z][\w+.-]*:/i.test(href)) return undefined;
  try { return pathToFileURL(resolve(dirname(path), decodeURIComponent(href.split("#")[0]))).href; } catch { return undefined; }
}

function doc(): Doc | undefined {
  if (source === undefined) return undefined;
  const key = `${docWidth(view.columns)}:${JSON.stringify(palette)}`;
  if (rendered?.key !== key) {
    let tokens;
    try { tokens = lexer(source); } catch { tokens = plainLexer(source); }
    rendered = { doc: renderDoc(tokens, { width: docWidth(view.columns), palette, highlighter, link: linkFor }), key };
  }
  return rendered.doc;
}

// ── Terminal ────────────────────────────────────────────────────────────────

function draw(full = false) {
  view.columns = out.columns || 80;
  view.rows = out.rows || 24;
  view.title = title(path);
  view.doc = doc();
  view.error = error;
  view.back = history.length > 0;
  clampScroll();
  current = layoutDoc(view);
  const lines = current.rows.map((row) => paint(row, view.columns));
  if (full) screen = [];
  let frame = "\x1b[?2026h";
  lines.forEach((line, i) => { if (screen[i] !== line) frame += `\x1b[${i + 1};1H${line}`; });
  frame += "\x1b[?2026l";
  screen = lines;
  out.write(frame);
}

const RESIZE_SETTLE_MS = 120;
const RESTORE = "\x1b]8;;\x1b\\\x1b[0m\x1b]22;default\x1b\\\x1b[?1004l\x1b[?1003l\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[?1049l";
let closing = false;
function quit(code = 0) {
  if (closing) return;
  closing = true;
  out.write(RESTORE);
  try { if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) rmSync(pidFile); } catch {}
  process.exit(code);
}

// ── Document ────────────────────────────────────────────────────────────────

const page = () => Math.max(1, current?.body.height ?? 10);
function clampScroll() {
  view.scroll = Math.max(0, Math.min(view.scroll, maxScroll(view.doc?.rows.length ?? 0, page())));
}

function load() {
  try { source = readFileSync(path, "utf8"); error = undefined; }
  catch (failure) { source = undefined; error = `Cannot read ${basename(path)}: ${(failure as NodeJS.ErrnoException).code ?? (failure as Error).message}`; }
  rendered = undefined;
}

function jump(anchor: string | undefined) {
  const row = anchor !== undefined ? doc()?.anchors.get(anchor.toLowerCase()) : undefined;
  if (row !== undefined) view.scroll = row;
}

let file: FSWatcher | undefined;
let reloading: ReturnType<typeof setTimeout> | undefined;
/** Editors often replace a file rather than write it, so watch its directory. */
function watchFile() {
  file?.close();
  const name = basename(path);
  try {
    file = watch(dirname(path), (_event, changed) => {
      if (changed !== null && String(changed) !== name) return;
      clearTimeout(reloading);
      reloading = setTimeout(() => { load(); draw(); }, 100);
    });
  } catch {
    file = undefined;
  }
}

function setTitle() {
  out.write(`\x1b]2;${basename(path).replace(/[\x00-\x1f\x7f-\x9f]/g, "")}\x1b\\`);
}

/** Shows another document, or another place in this one. */
function navigate(next: string, anchor?: string, remember = true) {
  if (next === path) {
    load();
    if (anchor) jump(anchor);
    draw();
    return;
  }
  if (remember) history.push({ path, scroll: view.scroll });
  path = next;
  view.scroll = 0;
  view.help = false;
  load();
  jump(anchor);
  watchFile();
  setTitle();
  draw();
}

function back() {
  const previous = history.pop();
  if (!previous) return;
  navigate(previous.path, undefined, false);
  view.scroll = previous.scroll;
  draw();
}

function follow(url: string) {
  const request = url.startsWith("pi-open:") ? parseDocUrl(url) : undefined;
  if (request) { navigate(request.path, request.anchor); return; }
  if (process.platform === "darwin") execFile("open", [url], () => {});
}

function onMessage() {
  let message: { event?: string; path?: string; anchor?: string } = {};
  try { message = JSON.parse(readFileSync(join(ipc, messageName), "utf8")); } catch {}
  if (message.event === "quit") { quit(); return; }
  if (message.event === "open" && message.path) navigate(resolve(message.path), message.anchor);
}

// ── Input ───────────────────────────────────────────────────────────────────

function scrollBy(delta: number) {
  view.scroll += delta;
  clampScroll();
}

function heading(direction: 1 | -1) {
  const starts = view.doc?.headings ?? [];
  const target = direction > 0 ? starts.find((row) => row > view.scroll) : starts.findLast((row) => row < view.scroll);
  if (target !== undefined) view.scroll = target;
  clampScroll();
}

function key(name: string) {
  if (view.help && name !== "?" && name !== "q" && name !== "ctrl-c") { view.help = false; draw(); return; }
  switch (name) {
    case "q": case "ctrl-c": quit(); return;
    case "?": view.help = !view.help; break;
    case "j": case "down": case "ctrl-e": scrollBy(1); break;
    case "k": case "up": case "ctrl-y": scrollBy(-1); break;
    case "d": case "ctrl-d": scrollBy(Math.floor(page() / 2)); break;
    case "u": case "ctrl-u": scrollBy(-Math.floor(page() / 2)); break;
    case " ": case "pagedown": case "ctrl-f": scrollBy(page() - 2); break;
    case "b": case "pageup": case "ctrl-b": scrollBy(-(page() - 2)); break;
    case "g": case "home": view.scroll = 0; break;
    case "G": case "end": view.scroll = Number.MAX_SAFE_INTEGER; clampScroll(); break;
    case "n": case "]": heading(1); break;
    case "p": case "[": heading(-1); break;
    case "backspace": case "left": case "h": back(); return;
    case "o": if (process.platform === "darwin") execFile("open", [path], () => {}); return;
    case "r": load(); break;
    case "blur": pointAt(undefined); return;
    default: return;
  }
  draw();
}

type Hit = { area: "key"; key: string } | { area: "scrollbar" } | { area: "link"; url: string };

/** What is under a cell, by 0-based column and row. */
function hit(x: number, y: number): Hit | undefined {
  if (!current) return undefined;
  const { keys, scrollbar, body } = current;
  if (keys && y === keys.row) {
    const item = keys.items.find((candidate) => x >= candidate.from && x < candidate.to);
    return item && { area: "key", key: item.key };
  }
  if (scrollbar && x === scrollbar.column && y >= scrollbar.top && y < scrollbar.top + scrollbar.height) return { area: "scrollbar" };
  if (view.help || y < body.top || y >= body.top + body.height) return undefined;
  const row = view.doc?.rows[view.scroll + y - body.top];
  if (!row) return undefined;
  let column = 1; // The left margin.
  for (const span of row.spans) {
    const cells = width(span.text);
    if (x >= column && x < column + cells) return span.style?.link ? { area: "link", url: span.style.link } : undefined;
    column += cells;
  }
  return undefined;
}

let hovering: Hit | undefined;
function pointAt(target: Hit | undefined) {
  if (JSON.stringify(target) === JSON.stringify(hovering)) return;
  const was = hovering !== undefined;
  hovering = target;
  view.hover = target?.area === "link" ? undefined : target;
  if (was !== (target !== undefined)) out.write(`\x1b]22;${target ? "pointer" : "default"}\x1b\\`);
  draw();
}

let dragging = false;
function scrollTo(y: number) {
  const bar = current?.scrollbar;
  if (!bar) return;
  const share = Math.min(1, Math.max(0, (y - bar.top) / Math.max(1, bar.height - 1)));
  view.scroll = Math.round(share * maxScroll(current!.body.total, bar.height));
  clampScroll();
  draw();
}

function mouse(button: number, column: number, row: number, press: boolean) {
  if (!current) return;
  const x = column - 1, y = row - 1;
  const motion = (button & 32) !== 0, code = button & ~32 & ~28;
  if (motion) {
    if (dragging && code === 0) scrollTo(y);
    else pointAt(hit(x, y));
    return;
  }
  if (!press) { dragging = false; return; }
  if (code === 64 || code === 65) { scrollBy(code === 64 ? -3 : 3); draw(); return; }
  if (code !== 0) return;
  const target = hit(x, y);
  if (target?.area === "key") key(target.key);
  else if (target?.area === "scrollbar") { dragging = true; scrollTo(y); }
  else if (target?.area === "link") follow(target.url);
}

const input = decoder({ key, mouse, background: (bg) => { palette = view.palette = { ...palette, bg }; draw(true); } });

// ── Start ───────────────────────────────────────────────────────────────────

mkdirSync(ipc, { recursive: true, mode: 0o700 });
writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
process.title = "pi-doc";
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => quit());
process.on("uncaughtException", (failure) => {
  out.write(RESTORE);
  console.error(failure);
  closing = true;
  try { rmSync(pidFile); } catch {}
  process.exit(1);
});

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", input);
out.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[2J\x1b]11;?\x1b\\");
let resized: ReturnType<typeof setTimeout> | undefined;
out.on("resize", () => {
  clearTimeout(resized);
  resized = setTimeout(() => {
    if (out.columns === view.columns && out.rows === view.rows) return;
    draw(true);
  }, RESIZE_SETTLE_MS);
});

load();
jump(values.anchor);
watchFile();
setTitle();
draw(true);
watch(ipc, (_event, name) => { if (String(name) === messageName) onMessage(); });
// Pi says when it quits; this catches a Pi that crashed or was killed.
setInterval(() => {
  try { process.kill(piPid, 0); }
  catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ESRCH") quit(); }
}, 250);
