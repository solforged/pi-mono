import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedHunks, collect, gitRunner, parseDiff, unquote } from "../extensions/diff/git.ts";
import { bundledHighlighter, DEFAULT_SETTINGS, paneSize, readPanes, readSettings, registerDiff, run, tick, treeState, which } from "../extensions/diff/pane.ts";
import { body, DEFAULT_PALETTE, emphasis, fileBody, hunkAt, layout, type View } from "../extensions/diff/render.ts";
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

test("a refresh reads again only the untracked files that changed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diff-seen-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "tracked.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  await writeFile(join(root, "same.txt"), "same\n");
  await writeFile(join(root, "edited.txt"), "before\n");
  const seen = new Map();
  const file = (snapshot: { files: Array<{ path: string }> }, path: string) => snapshot.files.find((entry) => entry.path === path);

  const first = await collect(root, "uncommitted", undefined, seen);
  const again = await collect(root, "uncommitted", undefined, seen);
  assert.equal(again.signature, first.signature);
  assert.equal(file(again, "edited.txt"), file(first, "edited.txt"), "the same object: not read again");

  await writeFile(join(root, "edited.txt"), "before\nand after\n");
  const edited = await collect(root, "uncommitted", undefined, seen);
  assert.notEqual(edited.signature, first.signature);
  assert.equal(file(edited, "same.txt"), file(first, "same.txt"));
  assert.equal((file(edited, "edited.txt") as { added: number }).added, 2);

  // A change to a tracked file, and a file that goes away, both show.
  await writeFile(join(root, "tracked.txt"), "one\ntwo\n");
  await rm(join(root, "same.txt"));
  const last = await collect(root, "uncommitted", undefined, seen);
  assert.notEqual(last.signature, edited.signature);
  assert.deepEqual(last.files.map((entry) => entry.path), ["edited.txt", "tracked.txt"]);
  assert.deepEqual([...seen.keys()], ["edited.txt"]);
  assert.equal((await collect(root, "staged", undefined, seen)).signature === last.signature, false);
});

test("a refresh cannot stall on a pipe behind an untracked link, or on Git", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diff-stall-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "real.txt"), "one\ntwo\n");
  execFileSync("mkfifo", [join(root, "pipe")]);
  await symlink("pipe", join(root, "to-pipe"));
  await symlink("real.txt", join(root, "to-real"));
  // Opening the pipe to read would wait for a writer that never comes.
  const { files } = await collect(root, "uncommitted");
  assert.deepEqual(files.map((file) => [file.path, file.notes, file.hunks[0]?.lines.map((line) => line.text)]), [
    ["real.txt", [], ["one", "two"]],
    ["to-pipe", ["symbolic link"], ["pipe"]],
    ["to-real", ["symbolic link"], ["real.txt"]],
  ]);
  // `cat-file --batch` reads standard input, which never ends here.
  await assert.rejects(gitRunner(root, 100)(["cat-file", "--batch"]), /git cat-file timed out/);
});

test("the pane's own Git calls find the working tree and its state", async (t) => {
  // Every other pane test injects `run`, so only this one runs the real thing.
  const root = realpathSync(await mkdtemp(join(tmpdir(), "diff-run-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "new.txt"), "fresh\n");
  assert.equal((await run("git", ["rev-parse", "--show-toplevel"], join(root, "sub"))).trim(), root);
  assert.match(await treeState(run, root), /^\?\? sub\/new\.txt\t6\t[\d.]+$/);
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

test("a file added in one very large hunk still lays out", () => {
  // Past roughly 125,000 lines, spreading a hunk into Math.max overflows the call stack.
  const lines = Array.from({ length: 150_000 }, (_, i) => ({ kind: "+" as const, text: "x", new: i + 1 }));
  const file = { ...parseDiff(SAMPLE)[0], status: "added" as const, hunks: [{ oldStart: 0, newStart: 1, context: "", lines }] };
  const big = body(file, 40, false, DEFAULT_PALETTE);
  assert.ok(big.rows.length >= lines.length);
  assert.match(plain(paint(big.rows.at(-1)!, 40)), /150000/);
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

test("shows hover, a key bar, a change counter and a scrollbar", () => {
  const files = parseDiff(SAMPLE);
  const long = { ...files[0], hunks: [{ ...files[0].hunks[0], lines: Array.from({ length: 40 }, (_, i) => ({ kind: "+" as const, text: `line ${i}`, new: i + 1 })) }, files[0].hunks[0]] };
  const base = view({ snapshot: { source: "uncommitted", label: "uncommitted", files: [long, files[1] ?? files[0]] }, rows: 24, columns: 60 });
  const screen = layout(base);
  const text = screen.rows.map((row) => plain(paint(row, 60)));
  assert.match(text[23], /← +→ file +p +n change +s source +f follow +\? help/);
  assert.ok(screen.keys && screen.keys.items.some((item) => item.key === "n"));
  assert.ok(text.some((line) => /change 1\/2 · file 1\/2 $/.test(line)));
  assert.ok(screen.scrollbar);
  assert.equal(screen.scrollbar.column, 59);
  const bar = text.slice(screen.body.top, screen.body.top + screen.body.height).map((line) => line.at(-1));
  assert.equal(bar[0], "┃");
  assert.equal(bar.at(-1), "│");

  // Scrolled to the end, the thumb sits at the bottom and the counter moves on.
  const starts = fileBody(long, base).hunks;
  const end = layout({ ...base, scroll: starts[1] }).rows.map((row) => plain(paint(row, 60)));
  assert.equal(hunkAt(starts, 0, 60, 15), 1);
  assert.equal(hunkAt(starts, starts[1] - 1, 200, 15), 2);
  assert.equal(hunkAt(starts, 45, 60, 15), 2); // At the end, the last change in view.
  assert.ok(end.some((line) => line.includes("change 2/2")));
  assert.equal(end[screen.body.top + screen.body.height - 1].at(-1), "┃");

  // Hovering a file row tints it, and paused following is called out.
  const hovered = layout({ ...base, hover: { area: "file", index: 1 }, follow: false });
  assert.notDeepEqual(hovered.rows[screen.list.top + 1], screen.rows[screen.list.top + 1]);
  assert.notEqual(paint(hovered.rows[23], 60), paint(screen.rows[23], 60));
});

/** Replays the viewer's frames into rows of plain text. */
function replay(output: string, rows = 24): string[] {
  const screen = Array<string>(rows).fill("");
  for (const match of output.matchAll(/\x1b\[(\d+);1H(.*?)(?=\x1b\[\d+;1H|\x1b\[\?2026l|$)/gs)) screen[Number(match[1]) - 1] = plain(match[2]);
  return screen;
}

test("the viewer answers keys, hovering, clicks and scrollbar drags", async (t) => {
  const repo = realpathSync(await mkdtemp(join(tmpdir(), "diff-viewer-")));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const original = Array.from({ length: 80 }, (_, i) => `line ${i}`);
  await writeFile(join(repo, "a.ts"), `${original.join("\n")}\n`);
  git(repo, "init", "-q", "-b", "main"); git(repo, "add", "."); git(repo, "commit", "-qm", "init");
  const changed = original.map((line, i) => (i < 20 ? `${line} early` : i === 70 ? `${line} late` : line));
  await writeFile(join(repo, "a.ts"), `${changed.join("\n")}\n`);
  await writeFile(join(repo, "b.ts"), "export const b = 1;\n");

  const viewer = spawn(process.execPath, [join(import.meta.dirname, "../extensions/diff/viewer.ts"), "--root", repo, "--ipc", join(repo, ".git", "ipc"), "--pi-pid", String(process.pid)], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => viewer.kill());
  let output = "";
  viewer.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  const until = async (check: (screen: string[]) => boolean, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (check(replay(output))) return replay(output);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.fail(`${what}:\n${replay(output).join("\n")}`);
  };
  const send = (data: string) => viewer.stdin.write(data);
  const has = (text: string) => (screen: string[]) => screen.some((line) => line.includes(text));

  let screen = await until(has("change 1/2 · file 1/2"), "first change of a.ts");
  assert.match(screen[23], /← +→ file/);
  send("\x1b[1;2B");
  await until(has("change 2/2 · file 1/2"), "shift-down moves to the next change");
  send("\x1b[1;2B");
  await until(has("file 2/2"), "and on into the next file");
  send("\x1b[1;2A");
  await until(has("change 2/2 · file 1/2"), "shift-up comes back to the last change");

  // Hovering b.ts asks for a hand pointer; clicking selects it.
  screen = replay(output);
  const row = screen.findIndex((line) => line.includes("U b.ts")) + 1;
  send(`\x1b[<35;6;${row}M`);
  await until(() => output.includes("\x1b]22;pointer"), "a hand over a file row");
  send(`\x1b[<0;6;${row}M\x1b[<0;6;${row}m`);
  await until(has("file 2/2"), "a click selects the file");

  // Clicking ← in the key bar goes back; scroll position there is kept.
  screen = replay(output);
  send(`\x1b[<0;${screen[23].indexOf("←") + 1};24M`);
  await until(has("change 2/2 · file 1/2"), "the ← key in the bar");

  // Dragging the scrollbar to the top shows the first lines again.
  send("\x1b[<0;80;20M\x1b[<32;80;5M");
  await until(has("change 1/2 · file 1/2"), "dragging the scrollbar up");
  send("\x1b[<0;80;5m\x1b[O");
  await until(() => output.endsWith("\x1b]22;default\x1b\\") || output.includes("\x1b]22;default"), "the pointer resets when focus leaves");

  send("q");
  assert.equal(await new Promise((resolve) => viewer.on("exit", resolve)), 0);
});

test("the viewer moves to the worktree Pi's session moved to", async (t) => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "diff-move-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const main = join(base, "main"), tree = join(base, "tree"), ipc = join(base, "ipc");
  await mkdir(main);
  await writeFile(join(main, "a.ts"), "one\n");
  git(main, "init", "-q", "-b", "main"); git(main, "add", "."); git(main, "commit", "-qm", "init");
  git(main, "worktree", "add", "-q", "-b", "pi/task", tree);
  await writeFile(join(main, "in-main.ts"), "main\n");
  await writeFile(join(tree, "in-tree.ts"), "tree\n");

  const pid = process.pid;
  const viewer = spawn(process.execPath, [join(import.meta.dirname, "../extensions/diff/viewer.ts"), "--root", main, "--ipc", ipc, "--pi-pid", String(pid)], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => viewer.kill());
  let output = "";
  viewer.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  const until = async (check: (screen: string[]) => boolean, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (check(replay(output))) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.fail(`${what}:\n${replay(output).join("\n")}`);
  };
  const shows = (text: string) => (screen: string[]) => screen.some((line) => line.includes(text));
  await until(shows("in-main.ts"), "the main checkout's change");

  // Pi says its session moved into the worktree.
  output = "";
  await writeFile(join(ipc, `${pid}.tick`), JSON.stringify({ event: "root", root: tree, seq: 1 }));
  await until((screen) => shows("in-tree.ts")(screen) && !shows("in-main.ts")(screen), "the worktree's change only");

  // Edits there are followed, and the watcher is on the new tree.
  await writeFile(join(tree, "later.ts"), "later\n");
  await until(shows("later.ts"), "a new file in the worktree");

  viewer.stdin.write("q");
  assert.equal(await new Promise((resolve) => viewer.on("exit", resolve)), 0);
});

function harness(env: NodeJS.ProcessEnv, dir: string, options: { auto?: boolean; reopen?: boolean; columns?: number; pid?: number; sizeError?: boolean; resizeError?: string } = {}) {
  const commands = new Map<string, any>(), handlers = new Map<string, Function>();
  const calls: Array<[string, string[]]> = [], notes: string[] = [];
  const state = { status: "", columns: options.columns ?? 200, root: "/repo" };
  const pi = { registerCommand: (name: string, c: any) => commands.set(name, c), on: (name: string, h: Function) => handlers.set(name, h) };
  const run = async (command: string, args: string[]) => {
    calls.push([command, args]);
    if (args[0] === "--version") return "v26.1.0\n";
    if (args[0] === "rev-parse") return `${state.root}\n`;
    if (args[0] === "status") return state.status;
    if (args[0] === "block" && args.at(-1) === "size") {
      if (options.sizeError) throw new Error("no such block");
      return JSON.stringify({ columns: 239, rows: 63, owner: "client:c" });
    }
    if (args[4] === "session.new_split") return JSON.stringify({ block_ids: ["block:pane"] });
    if (args[4] === "session.resize_pane" && options.resizeError) throw new Error(options.resizeError);
    return "{}";
  };
  const diff = registerDiff(pi as any, {
    palette: () => ({ accent: "#ff00ff" }), run, dir, env, pid: options.pid ?? 4242, isViewer: () => true,
    settings: () => ({ autoOpen: options.auto ?? false, reopen: options.reopen ?? false, minColumns: 150 }), columns: () => state.columns,
    panes: join(dir, "panes.json"),
  });
  const ctx = { mode: "tui", cwd: "/repo/sub", ui: { notify: (m: string) => notes.push(m) } };
  /** Each new_split call as the rex binary and the viewer's command line. */
  const splits = () => calls.filter(([, args]) => args[4] === "session.new_split")
    .map(([rex, args]): [string, string[]] => [rex, JSON.parse(args[5]).layout.block.options.command]);
  return { command: commands.get("diff"), handlers, calls, notes, ctx, state, splits, diff };
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
  assert.equal(args[0], join(bin, "node"));
  assert.match(args[1], /extensions\/diff\/viewer\.ts$/);
  assert.deepEqual(args.slice(-8), ["--ipc", dir, "--pi-pid", "4242", "--palette", "{\"accent\":\"#ff00ff\"}", "--source", "staged"]);
  // The pane starts at about its final size, then moves to a third.
  const [, call] = h.calls.at(-2)!;
  assert.deepEqual(call.slice(0, 5), ["api", "call", "--session", "session:s", "session.new_split"]);
  const request = JSON.parse(call[5]);
  assert.deepEqual({ ...request, layout: undefined }, {
    session_id: "session:s", anchor_id: "block:b", direction: "horizontal", side: "after", focus: false, ratio: 0.6667, layout: undefined,
  });
  const { command: _, ...block } = request.layout.block.options;
  assert.equal(request.layout.block.label, "Diff");
  assert.deepEqual(block, { shell: "none", cwd: "/repo", size: { columns: 78, rows: 63 } });
  // Rex ignores new_split's ratio, so the border is moved afterwards.
  const [, resize] = h.calls.at(-1)!;
  assert.deepEqual(resize.slice(0, 5), ["api", "call", "--session", "session:s", "session.resize_pane"]);
  assert.deepEqual(JSON.parse(resize[5]), { session_id: "session:s", direction: "horizontal", before_block_id: "block:b", after_block_id: "block:pane", ratio: 0.6667 });

  await h.command.handler("bogus", h.ctx);
  assert.match(h.notes.at(-1)!, /Usage: \/diff/);
});

test("sizes the new pane from Pi's, or leaves it to Rex", async (t) => {
  assert.deepEqual(paneSize({ columns: 239, rows: 63 }), { columns: 78, rows: 63 });
  assert.deepEqual(paneSize({ columns: 40, rows: 10 }), { columns: 20, rows: 10 });
  assert.equal(paneSize({ columns: 0, rows: 63 }), undefined);
  assert.equal(paneSize({}), undefined);

  const dir = await mkdtemp(join(tmpdir(), "diff-ipc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = await mkdtemp(join(tmpdir(), "diff-bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const name of ["rex", "node"]) await writeFile(join(bin, name), "", { mode: 0o755 });
  const h = harness({ PATH: bin, REX_SESSION: "session:s", REX_BLOCK: "block:b" }, dir, { sizeError: true });
  await h.command.handler("", h.ctx);
  assert.deepEqual(h.notes, []);
  assert.equal(JSON.parse(h.calls.at(-2)![1][5]).layout.block.options.size, undefined);
});

test("warns when the pane cannot be narrowed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diff-ipc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = await mkdtemp(join(tmpdir(), "diff-bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const name of ["rex", "node"]) await writeFile(join(bin, name), "", { mode: 0o755 });
  const h = harness({ PATH: bin, REX_SESSION: "session:s", REX_BLOCK: "block:b" }, dir, { resizeError: "not in the same window" });
  await h.command.handler("", h.ctx);
  assert.equal(h.splits().length, 1);
  assert.match(h.notes.at(-1)!, /default width: not in the same window/);
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
  await writeFile(join(agent, "settings.json"), JSON.stringify({ diff: { autoOpen: false, minColumns: 180, links: false } }));
  assert.deepEqual(readSettings(agent), { autoOpen: false, reopen: true, minColumns: 180, links: false });
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

/**
 * The installed Pi's binary, which has the bundled libraries beside it. Some
 * installs put a wrapper script on PATH; follow its `exec` line to the binary.
 */
const piBinary = (() => {
  try {
    let file = realpathSync(which("pi") ?? "");
    for (let hops = 0; hops < 5 && statSync(file).size < 65_536; hops++) {
      const target = /^\s*exec\s+(?:-a\s+\S+\s+)?["']?(\/[^"'\s]+)/m.exec(readFileSync(file, "utf8"))?.[1];
      if (!target) break;
      file = realpathSync(target);
    }
    return file;
  } catch {
    return undefined;
  }
})();
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
      // The viewer is told to close at once instead of polling for Pi's exit.
      assert.equal(JSON.parse(await readFile(join(dir, `${pid}.tick`), "utf8")).event, "quit");
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

  // Opened, closed, then /new before quitting: the instance that quits never saw the pane, and still forgets it.
  const earlier = await start(9, true);
  await earlier.command.handler("", earlier.ctx);
  assert.equal(readPanes(join(dir, "panes.json"))["/repo"].pid, 9);
  await quit(await start(9, true, "new"), 9, false);
  assert.deepEqual(readPanes(join(dir, "panes.json")), {});
});

test("the pane's block outlives the session that opened it, for a document to take its place", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diff-ipc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = await mkdtemp(join(tmpdir(), "diff-bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const name of ["rex", "node"]) await writeFile(join(bin, name), "", { mode: 0o755 });
  const env = { PATH: bin, REX_SESSION: "session:s", REX_BLOCK: "block:b" };
  const h = harness(env, dir);
  await h.command.handler("", h.ctx);
  assert.equal(h.diff.block(), undefined, "no block while the viewer is not running");
  const viewer = spawn("sleep", ["30"]);
  t.after(() => viewer.kill());
  await writeFile(join(dir, "4242.viewer"), String(viewer.pid));
  assert.equal(h.diff.block(), "block:pane");
  // /new, /resume, /fork and /reload build a new instance of the extension in the same Pi.
  const next = harness(env, dir);
  next.handlers.get("session_start")!({ reason: "new" }, next.ctx);
  await settle();
  assert.equal(next.diff.block(), "block:pane");
  next.handlers.get("session_shutdown")!({ reason: "quit" });
  await assert.rejects(readFile(join(dir, "4242.block")));
});

test("an open pane follows the session into another worktree", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diff-ipc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const panes = join(dir, "panes.json");
  await writeFile(panes, JSON.stringify({ "/repo": { pid: 4242, at: Date.now() }, "/other": { pid: 7, at: Date.now() } }));
  const viewer = spawn("sleep", ["30"]);
  t.after(() => viewer.kill());
  await writeFile(join(dir, "4242.viewer"), String(viewer.pid));

  // A switch rebinds extensions: a fresh instance sees the session in the worktree.
  const h = harness({}, dir);
  h.state.root = "/wt/repo--task";
  h.handlers.get("session_start")!({ reason: "resume" }, { ...h.ctx, cwd: "/wt/repo--task" });
  await settle();
  const { seq: _, ...moved } = JSON.parse(await readFile(join(dir, "4242.tick"), "utf8"));
  assert.deepEqual(moved, { event: "root", root: "/wt/repo--task" });
  // The memory of open panes moves with it; other Pis' entries stay.
  assert.deepEqual(Object.keys(readPanes(panes)).sort(), ["/other", "/wt/repo--task"]);
  h.handlers.get("session_shutdown")!({ reason: "quit" });
  assert.equal(readPanes(panes)["/wt/repo--task"].pid, 4242);

  // Not at startup, when no earlier session can have opened this Pi's pane.
  await rm(join(dir, "4242.tick"));
  const fresh = harness({}, dir);
  fresh.handlers.get("session_start")!({ reason: "startup" }, fresh.ctx);
  await settle();
  await assert.rejects(readFile(join(dir, "4242.tick")));
});
