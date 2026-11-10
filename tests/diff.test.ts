import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedHunks, collect, parseDiff, unquote } from "../extensions/diff/git.ts";
import { bundledHighlighter, DEFAULT_SETTINGS, readPanes, readSettings, registerDiff, tick, which } from "../extensions/diff/pane.ts";
import { body, DEFAULT_PALETTE, emphasis, layout, type View } from "../extensions/diff/render.ts";
import { createHighlighter, loadHighlighter, piecesFromHtml, tokenFor } from "../extensions/diff/syntax.ts";
import { paint, sanitize, width, wrapSpans } from "../extensions/diff/text.ts";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const SAMPLE = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,4 +10,5 @@ export function main() {",
  " const a = 1;",
  "-const b = oldName(a);",
  "+const b = newName(a);",
  "+const c = 3;",
  " return b;",
  "\\ No newline at end of file",
  "diff --git a/old name.txt b/new name.txt",
  "similarity index 100%",
  "rename from old name.txt",
  "rename to new name.txt",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/img.png b/img.png",
  "Binary files a/img.png and b/img.png differ",
  "diff --git a/run.sh b/run.sh",
  "old mode 100644",
  "new mode 100755",
  "diff --git \"a/caf\\303\\251 \\\"q\\\".txt\" \"b/caf\\303\\251 \\\"q\\\".txt\"",
  "new file mode 100644",
  "--- /dev/null",
  "+++ \"b/caf\\303\\251 \\\"q\\\".txt\"",
  "@@ -0,0 +1 @@",
  "+hi",
  "",
].join("\n");

test("parses modified, renamed, deleted, binary, mode-only and quoted files", () => {
  const files = parseDiff(SAMPLE);
  assert.deepEqual(files.map((file) => [file.path, file.status, file.added, file.removed]), [
    ["src/app.ts", "modified", 2, 1],
    ["new name.txt", "renamed", 0, 0],
    ["gone.txt", "deleted", 0, 1],
    ["img.png", "modified", 0, 0],
    ["run.sh", "modified", 0, 0],
    ["café \"q\".txt", "added", 1, 0],
  ]);
  const [app, renamed, , binary, mode] = files;
  assert.equal(app.hunks[0].context, "export function main() {");
  assert.deepEqual(app.hunks[0].lines.map((line) => [line.kind, line.old, line.new]), [
    [" ", 10, 10], ["-", 11, undefined], ["+", undefined, 11], ["+", undefined, 12], [" ", 12, 13],
  ]);
  assert.equal(renamed.oldPath, "old name.txt");
  assert.equal(binary.binary, true);
  assert.deepEqual(mode.notes, ["mode 100644 → 100755"]);
  assert.equal(unquote("\"tab\\there\""), "tab\there");
});

test("reports only hunks that are new since the previous snapshot", () => {
  const [before] = parseDiff(SAMPLE);
  const after = structuredClone(before);
  after.hunks.push({ oldStart: 40, newStart: 41, context: "", lines: [{ kind: "+", text: "added later", new: 41 }] });
  assert.deepEqual(changedHunks(before, after), [1]);
  assert.deepEqual(changedHunks(undefined, after), [0, 1]);
});

function git(cwd: string, ...args: string[]) {
  // Isolated from the user's Git configuration, templates and hooks.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env });
}

test("collects uncommitted, staged and branch diffs from a real repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diff-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "a.txt"), "one\ntwo\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  git(root, "switch", "-qc", "topic");
  await writeFile(join(root, "a.txt"), "one\n2\n");
  git(root, "commit", "-qam", "change");
  await writeFile(join(root, "staged.txt"), "s\n");
  git(root, "add", "staged.txt");
  await writeFile(join(root, "new.txt"), "fresh\nfile");
  await writeFile(join(root, "blob.bin"), Buffer.from([1, 0, 2]));

  const uncommitted = await collect(root, "uncommitted");
  assert.equal(uncommitted.label, "uncommitted");
  assert.deepEqual(uncommitted.files.map((file) => [file.path, file.status, file.added, file.binary]), [
    ["blob.bin", "untracked", 0, true], ["new.txt", "untracked", 2, false], ["staged.txt", "added", 1, false],
  ]);
  const staged = await collect(root, "staged");
  assert.deepEqual(staged.files.map((file) => file.path), ["staged.txt"]);
  const branch = await collect(root, "branch");
  assert.equal(branch.label, "since main");
  assert.deepEqual(branch.files.map((file) => file.path), ["a.txt", "blob.bin", "new.txt", "staged.txt"]);
});

test("measures wide characters and wraps styled text without losing content", () => {
  assert.equal(width("abc"), 3);
  assert.equal(width("新しい"), 6);
  assert.equal(width("🎉"), 2);
  assert.equal(width("e\u0301"), 1);
  assert.equal(sanitize("a\tb"), "a   b");
  assert.equal(sanitize("x\x1b"), "x␛");
  const rows = wrapSpans([{ text: "alpha beta gamma delta" }], 11);
  assert.deepEqual(rows.map((row) => row.map((span) => span.text).join("")), ["alpha beta ", "gamma delta"]);
  assert.deepEqual(wrapSpans([{ text: "" }], 5), [[]]);
});

test("emphasizes only the words that changed in a paired line", () => {
  const result = emphasis("const b = oldName(a);", "const b = newName(a);");
  assert.ok(result);
  const [, changed, , tokens] = result;
  assert.deepEqual(tokens.filter((_, i) => changed[i]), ["newName"]);
  assert.equal(emphasis("completely different", "nothing alike here"), undefined);
});

const view = (overrides: Partial<View> = {}): View => ({
  loading: false, selected: 0, scroll: 0, wrap: true, follow: true, help: false,
  columns: 40, rows: 20, palette: DEFAULT_PALETTE, ...overrides,
});

test("paints every row to exactly the pane width", () => {
  const files = parseDiff(SAMPLE);
  files[0].hunks[0].lines.push({ kind: "+", text: `${"wide 新しい行 🎉 ".repeat(6)}\tend`, new: 14 });
  for (const columns of [12, 25, 40, 79]) {
    for (const wrap of [true, false]) {
      const screen = layout(view({ snapshot: { source: "uncommitted", label: "uncommitted", files }, columns, wrap }));
      assert.equal(screen.rows.length, 20);
      for (const row of screen.rows) assert.equal(width(plain(paint(row, columns))), columns, `${columns} ${wrap}`);
    }
  }
});

test("lays out the summary, a scrolling file list and the selected diff", () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ ...parseDiff(SAMPLE)[0], path: `dir/file${i}.ts` }));
  const screen = layout(view({ snapshot: { source: "uncommitted", label: "uncommitted", files }, selected: 6, rows: 24, columns: 60 }));
  const text = screen.rows.map((row) => plain(paint(row, 60)));
  assert.match(text[0], /^ 12 files changed \+24 −12 .*uncommitted ▾ $/);
  assert.equal(screen.list.height, 8);
  assert.match(text[screen.list.top + screen.list.height - 1], /↓ \d+ more {2}↑ \d+ above/);
  assert.ok(text.some((line) => line.includes("dir/file6.ts") && line.includes("7/12")));
  const rows = body(files[6], 40, true, DEFAULT_PALETTE);
  assert.equal(rows.hunks[0], 0);
  assert.match(plain(paint(rows.rows[0], 40)), /⋯ {3}export function main/);

  const empty = layout(view({ snapshot: { source: "staged", label: "staged", files: [] } })).rows.map((row) => plain(paint(row, 40)));
  assert.match(empty[0], /No changes/);
  assert.ok(empty.some((line) => line.includes("Nothing is staged.")));
  const help = layout(view({ help: true })).rows.map((row) => plain(paint(row, 40)));
  assert.ok(help.some((line) => line.includes("follow Pi's edits")));
});

function harness(env: NodeJS.ProcessEnv, dir: string, options: { auto?: boolean; reopen?: boolean; columns?: number; pid?: number } = {}) {
  const commands = new Map<string, any>(), handlers = new Map<string, Function>();
  const calls: Array<[string, string[]]> = [], notes: string[] = [];
  const state = { status: "", columns: options.columns ?? 200 };
  const pi = { registerCommand: (name: string, c: any) => commands.set(name, c), on: (name: string, h: Function) => handlers.set(name, h) };
  const run = async (command: string, args: string[]) => {
    calls.push([command, args]);
    if (args[0] === "--version") return "v26.1.0\n";
    if (args[0] === "rev-parse") return "/repo\n";
    if (args[0] === "status") return state.status;
    if (args[0] === "split") return JSON.stringify({ block_ids: ["block:pane"] });
    return "{}";
  };
  registerDiff(pi as any, {
    palette: () => ({ accent: "#ff00ff" }), run, dir, env, pid: options.pid ?? 4242, isViewer: () => true,
    settings: () => ({ autoOpen: options.auto ?? false, reopen: options.reopen ?? false, minColumns: 150 }), columns: () => state.columns,
    panes: join(dir, "panes.json"),
  });
  const ctx = { mode: "tui", cwd: "/repo/sub", ui: { notify: (m: string) => notes.push(m) } };
  const splits = () => calls.filter(([, args]) => args[0] === "split");
  return { command: commands.get("diff"), handlers, calls, notes, ctx, state, splits };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("opens the viewer in a Rex split beside Pi's own pane", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diff-ipc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = await mkdtemp(join(tmpdir(), "diff-bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const name of ["rex", "node"]) await writeFile(join(bin, name), "", { mode: 0o755 });
  assert.equal(which("rex", bin), join(bin, "rex"));

  const outside = harness({ PATH: bin }, dir);
  await outside.command.handler("", outside.ctx);
  assert.match(outside.notes[0], /needs Pi running in a Rex pane/);

  const h = harness({ PATH: bin, REX_SESSION: "session:s", REX_BLOCK: "block:b" }, dir);
  await h.command.handler("staged", h.ctx);
  assert.deepEqual(h.notes, []);
  const [rex, args] = h.splits()[0];
  assert.equal(rex, join(bin, "rex"));
  assert.deepEqual(args.slice(0, 16), ["split", "-s", "session:s", "-b", "block:b", "--split=right", "--ratio", "33", "--focus=false", "--label", "Diff", "--shell=none", "-c", "/repo", "--json", "--"]);
  assert.equal(args[16], join(bin, "node"));
  assert.match(args[17], /extensions\/diff\/viewer\.ts$/);
  // Rex ignores --ratio, so the border is moved to give the pane a third.
  const [, resize] = h.calls.at(-1)!;
  assert.deepEqual(resize.slice(0, 5), ["api", "call", "--session", "session:s", "session.resize_pane"]);
  assert.deepEqual(JSON.parse(resize[5]), { session_id: "session:s", direction: "horizontal", before_block_id: "block:b", after_block_id: "block:pane", ratio: 0.6667 });
  assert.deepEqual(args.slice(-8), ["--ipc", dir, "--pi-pid", "4242", "--palette", "{\"accent\":\"#ff00ff\"}", "--source", "staged"]);

  await h.command.handler("bogus", h.ctx);
  assert.match(h.notes.at(-1)!, /Usage: \/diff/);
});

test("closes an open viewer and sends it the files Pi edits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diff-ipc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness({}, dir);
  const tickFile = join(dir, "4242.tick");

  // Without a live viewer, nothing is written.
  h.handlers.get("tool_execution_start")!({ toolCallId: "1", toolName: "edit", args: { path: "src/a.ts" } }, h.ctx);
  h.handlers.get("tool_execution_end")!({ toolCallId: "1", toolName: "edit", isError: false });
  await assert.rejects(readFile(tickFile));

  // A sleeping child stands in for the viewer process.
  const { spawn } = await import("node:child_process");
  const child = spawn("sleep", ["30"]);
  t.after(() => child.kill());
  await writeFile(join(dir, "4242.viewer"), String(child.pid));
  h.handlers.get("tool_execution_start")!({ toolCallId: "2", toolName: "write", args: { path: "src/b.ts" } }, h.ctx);
  h.handlers.get("tool_execution_end")!({ toolCallId: "2", toolName: "write", isError: false });
  assert.deepEqual(JSON.parse(await readFile(tickFile, "utf8")), { event: "edit", path: "/repo/sub/src/b.ts", seq: 1 });
  h.handlers.get("tool_execution_end")!({ toolCallId: "3", toolName: "bash", isError: false });
  assert.equal(JSON.parse(await readFile(tickFile, "utf8")).event, "refresh");
  h.handlers.get("agent_start")!();
  assert.equal(JSON.parse(await readFile(tickFile, "utf8")).event, "agent_start");
  tick(dir, 9999, { event: "refresh" });
  await assert.rejects(readFile(join(dir, "9999.tick")));

  const exited = new Promise((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
  await h.command.handler("", h.ctx);
  assert.equal(await exited, "SIGTERM");
  assert.equal(h.calls.length, 0);
});

test("opens on its own once Pi changes the working tree, once per session", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diff-ipc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = await mkdtemp(join(tmpdir(), "diff-bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const name of ["rex", "node"]) await writeFile(join(bin, name), "", { mode: 0o755 });
  const env = { PATH: bin, REX_SESSION: "session:s", REX_BLOCK: "block:b" };
  const end = (h: ReturnType<typeof harness>, id: string, toolName: string, path?: string) => {
    if (path) h.handlers.get("tool_execution_start")!({ toolCallId: id, toolName, args: { path } }, h.ctx);
    h.handlers.get("tool_execution_end")!({ toolCallId: id, toolName, isError: false }, h.ctx);
  };

  const h = harness(env, dir, { auto: true, columns: 120 });
  h.state.status = " M already-dirty.ts\0";
  h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
  await settle();
  end(h, "1", "read");
  end(h, "2", "bash"); // Ran, but changed nothing.
  await settle();
  assert.equal(h.splits().length, 0);
  h.state.status = " M already-dirty.ts\0?? src/new.ts\0";
  end(h, "3", "write", "src/new.ts");
  await settle();
  assert.equal(h.splits().length, 0, "too narrow: stays armed");
  h.state.columns = 200;
  end(h, "4", "edit", "src/new.ts");
  await settle();
  assert.equal(h.splits().length, 1);
  assert.deepEqual(h.splits()[0][1].slice(-4), ["--source", "uncommitted", "--focus", "/repo/sub/src/new.ts"]);
  h.state.status += " M more.ts\0";
  end(h, "5", "bash");
  await settle();
  assert.equal(h.splits().length, 1, "opens at most once per session");

  // A new session re-arms with a fresh baseline.
  h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
  await settle();
  h.state.status += " M again.ts\0";
  end(h, "6", "bash");
  await settle();
  assert.equal(h.splits().length, 2);

  // Your own edits between prompts are not Pi's changes.
  const yours = harness(env, dir, { auto: true });
  yours.handlers.get("session_start")!({ reason: "startup" }, yours.ctx);
  await settle();
  yours.state.status = " M edited-by-you.ts\0";
  yours.handlers.get("agent_start")!();
  end(yours, "1", "bash");
  await settle();
  assert.equal(yours.splits().length, 0);
  yours.state.status += " M edited-by-pi.ts\0";
  end(yours, "2", "bash");
  await settle();
  assert.equal(yours.splits().length, 1);

  // Running /diff yourself takes over for the session.
  const manual = harness(env, dir, { auto: true });
  manual.handlers.get("session_start")!({ reason: "startup" }, manual.ctx);
  await settle();
  await manual.command.handler("close", manual.ctx);
  manual.state.status = " M x.ts\0";
  end(manual, "1", "bash");
  await settle();
  assert.equal(manual.splits().length, 0);

  // Never in child agents, outside the TUI, or when turned off.
  for (const [extra, mode, auto] of [[{ PI_REX_CHILD: "1" }, "tui", true], [{}, "print", true], [{}, "tui", false]] as const) {
    const off = harness({ ...env, ...extra }, dir, { auto });
    off.ctx.mode = mode;
    off.handlers.get("session_start")!({ reason: "startup" }, off.ctx);
    await settle();
    off.state.status = " M x.ts\0";
    end(off, "1", "bash");
    await settle();
    assert.equal(off.calls.filter(([, args]) => args[0] === "status").length, 0);
    assert.equal(off.splits().length, 0);
  }
});

test("reads diff settings with defaults", async (t) => {
  const agent = await mkdtemp(join(tmpdir(), "diff-agent-"));
  t.after(() => rm(agent, { recursive: true, force: true }));
  assert.deepEqual(readSettings(agent), DEFAULT_SETTINGS);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ diff: { autoOpen: false, minColumns: 180 } }));
  assert.deepEqual(readSettings(agent), { autoOpen: false, reopen: true, minColumns: 180 });
  await writeFile(join(agent, "settings.json"), JSON.stringify({ diff: { autoOpen: "yes", minColumns: -1 } }));
  assert.deepEqual(readSettings(agent), DEFAULT_SETTINGS);
});

test("splits highlight.js markup into per-line Pi syntax tokens", () => {
  const html = '<span class="hljs-keyword">const</span> s = <span class="hljs-string">`a<span class="hljs-subst">${b}</span>\nc`</span> <span class="hljs-comment">// x &amp; &lt;y&gt;</span>';
  assert.deepEqual(piecesFromHtml(html), [
    [{ text: "const", token: "keyword" }, { text: " s = " }, { text: "`a", token: "string" }, { text: "${b}" }],
    [{ text: "c`", token: "string" }, { text: " " }, { text: "// x & <y>", token: "comment" }],
  ]);
  assert.equal(tokenFor("hljs-title function_"), "function");
  assert.equal(tokenFor("hljs-title class_"), "type");
  assert.equal(tokenFor("hljs-variable language_"), "keyword");
  assert.equal(tokenFor("hljs-params"), null);
  assert.equal(tokenFor("hljs-unknown"), undefined);
});

test("colors diff lines with syntax and keeps word emphasis on top", () => {
  const fake = createHighlighter({
    getLanguage: (name: string) => name === "typescript" ? {} : undefined,
    highlight: (code: string) => ({ value: code.split("\n").map((line) => line.replace(/\b(const)\b/g, '<span class="hljs-keyword">$1</span>')).join("\n") }),
  });
  assert.equal(fake.language("src/a.ts"), "typescript");
  assert.equal(fake.language("Makefile"), undefined);
  const [file] = parseDiff(SAMPLE);
  const palette = { ...DEFAULT_PALETTE, syntax: { keyword: "#0000ff" } };
  const rows = body(file, 60, true, palette, fake).rows;
  const spans = (n: number) => rows[n].spans.slice(2);
  // Context: toned toward the background. Added: full keyword color.
  assert.equal(spans(1)[0].text, "const");
  assert.notEqual(spans(1)[0].style?.fg, "#0000ff");
  assert.equal(spans(3)[0].style?.fg, "#0000ff");
  // The renamed call stays emphasized: a brighter background than the rest of the line.
  const renamed = spans(3).find((span) => span.text.includes("newName"))!;
  assert.notEqual(renamed.style?.bg, spans(3)[0].style?.bg);
  assert.equal(spans(3).map((span) => span.text).join(""), "const b = newName(a);");
});

const piBinary = (() => { try { return realpathSync(which("pi") ?? ""); } catch { return undefined; } })();
test("loads the highlight.js build bundled with the installed Pi", { skip: !piBinary || !bundledHighlighter(piBinary) }, () => {
  const highlighter = loadHighlighter(bundledHighlighter(piBinary!));
  assert.ok(highlighter);
  const [line] = highlighter.highlight(["fn main() { let x = 1; }"], "rust");
  assert.ok(line.some((piece) => piece.token === "keyword" && piece.text === "fn"));
  assert.equal(line.map((piece) => piece.text).join(""), "fn main() { let x = 1; }");
});

test("reopens the pane Pi quit with when changes remain", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diff-ipc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = await mkdtemp(join(tmpdir(), "diff-bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const name of ["rex", "node"]) await writeFile(join(bin, name), "", { mode: 0o755 });
  const env = { PATH: bin, REX_SESSION: "session:s", REX_BLOCK: "block:b" };
  const { spawn } = await import("node:child_process");
  const start = async (pid: number, dirty: boolean, reason = "startup") => {
    const h = harness(env, dir, { reopen: true, pid });
    h.state.status = dirty ? " M a.ts\0" : "";
    h.handlers.get("session_start")!({ reason }, h.ctx);
    await settle();
    return h;
  };
  /** Opens the pane in a Pi with `pid`, then quits with the viewer alive or closed. */
  const quit = async (h: ReturnType<typeof harness>, pid: number, open: boolean) => {
    if (open) {
      const viewer = spawn("sleep", ["30"]);
      t.after(() => viewer.kill());
      await writeFile(join(dir, `${pid}.viewer`), String(viewer.pid));
      h.handlers.get("session_shutdown")!({ reason: "quit" });
      viewer.kill();
      await new Promise((resolve) => viewer.on("exit", resolve));
    } else h.handlers.get("session_shutdown")!({ reason: "quit" });
  };

  // Nothing remembered: a fresh Pi does not open the pane.
  assert.equal((await start(1, true)).splits().length, 0);

  // Opened with /diff and still open at quit: the next Pi reopens it.
  const first = await start(2, true);
  await first.command.handler("", first.ctx);
  await quit(first, 2, true);
  const second = await start(3, true);
  assert.equal(second.splits().length, 1);
  assert.equal(readPanes(join(dir, "panes.json"))["/repo"].pid, 3);

  // Not on /new, /resume or /reload in a running Pi, nor with a clean tree.
  assert.equal((await start(4, true, "new")).splits().length, 0);
  assert.equal((await start(5, false)).splits().length, 0);

  // Closed before quitting: forgotten.
  await quit(second, 3, false);
  assert.deepEqual(readPanes(join(dir, "panes.json")), {});
  assert.equal((await start(6, true)).splits().length, 0);

  // Another Pi that never opened a pane leaves the memory alone.
  const owner = await start(7, true);
  await owner.command.handler("", owner.ctx);
  await quit(owner, 7, true);
  const bystander = harness(env, dir, { pid: 8 });
  bystander.handlers.get("session_shutdown")!({ reason: "quit" });
  assert.equal(readPanes(join(dir, "panes.json"))["/repo"].pid, 7);
});
