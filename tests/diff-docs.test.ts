import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerDocs } from "../extensions/diff/docs.ts";
import { docUrl, linkDocs, parseDocUrl, resolveTarget } from "../extensions/diff/links.ts";
import { bundledMarked, layoutDoc, loadMarked, plainLexer, renderDoc, slug, type DocView } from "../extensions/diff/markdown.ts";
import { DEFAULT_SETTINGS, ipcDir, which } from "../extensions/diff/pane.ts";
import { DEFAULT_PALETTE } from "../extensions/diff/render.ts";
import { paint } from "../extensions/diff/text.ts";

const plain = (text: string) => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");
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
const lexer = piBinary ? loadMarked(bundledMarked(piBinary)) : undefined;

test("pi-open URLs carry the Pi's process ID, an absolute path and an anchor", () => {
  const url = docUrl(42, "/tmp/a b/(notes).md", "two words");
  assert.equal(url, "pi-open://42/%2Ftmp%2Fa%20b%2F%28notes%29.md#two%20words");
  assert.deepEqual(parseDocUrl(url), { pid: 42, path: "/tmp/a b/(notes).md", anchor: "two words" });
  assert.equal(parseDocUrl("pi-open://42/relative.md"), undefined);
  assert.equal(parseDocUrl("pi-open://42/%2Fetc%2Fpasswd"), undefined);
  assert.equal(parseDocUrl("pi-open://x/%2Fa.md"), undefined);
  assert.equal(parseDocUrl("https://42/%2Fa.md"), undefined);
  assert.deepEqual(resolveTarget("file:///tmp/x.md#y", "/"), { path: "/tmp/x.md", anchor: "y" });
  assert.deepEqual(resolveTarget("../b%20c.md", "/a/d"), { path: "/a/b c.md" });
  assert.equal(resolveTarget("https://example.com/x.md", "/"), undefined);
  assert.equal(resolveTarget("notes.txt", "/"), undefined);
});

test("links Markdown files in messages, leaving code, URLs and missing files alone", () => {
  const files = new Set(["/repo/docs/a.md", "/repo/README.md", "/repo/docs/b.md"]);
  const url = (path: string, anchor?: string) => `pi-open://1${path}${anchor ? `#${anchor}` : ""}`;
  const out = linkDocs([
    "See docs/a.md, `README.md` and [B](docs/b.md#keys \"title\"); not missing.md or https://x.dev/docs/a.md.",
    "```md",
    "docs/a.md",
    "```",
    "![pic](docs/a.md) [already](https://x.dev) ./docs/a.md.",
  ].join("\n"), "/repo", url, (path) => files.has(path));
  assert.equal(out, [
    "See [docs/a.md](pi-open://1/repo/docs/a.md), [`README.md`](pi-open://1/repo/README.md) and [B](pi-open://1/repo/docs/b.md#keys \"title\"); not missing.md or https://x.dev/docs/a.md.",
    "```md",
    "docs/a.md",
    "```",
    "![pic](docs/a.md) [already](https://x.dev) [./docs/a.md](pi-open://1/repo/docs/a.md).",
  ].join("\n"));
  assert.equal(linkDocs("no documents here", "/repo", url, () => true), "no documents here");
});

test("links only prose: not indented or nested code, HTML tags, or labels of links it cannot read", () => {
  const url = (path: string) => `pi-open://1${path}`;
  const link = (lines: string[]) => linkDocs(lines.join("\n"), "/repo", url, () => true).split("\n");
  // Indented code needs a blank line before it, and is not what a list item's continuation is.
  assert.deepEqual(link(["Run this:", "", "    cat README.md", "    less docs/a.md", "", "then docs/a.md", "    and README.md"]),
    ["Run this:", "", "    cat README.md", "    less docs/a.md", "", "then [docs/a.md](pi-open://1/repo/docs/a.md)", "    and [README.md](pi-open://1/repo/README.md)"]);
  assert.deepEqual(link(["1. Step", "", "    read docs/a.md", "    ```sh", "    cat README.md", "    ```", "> ~~~", "> cat README.md", "> ~~~"]),
    ["1. Step", "", "    read [docs/a.md](pi-open://1/repo/docs/a.md)", "    ```sh", "    cat README.md", "    ```", "> ~~~", "> cat README.md", "> ~~~"]);
  assert.deepEqual(link(["<a href=\"docs/a.md\">guide</a> <img src='x.md' /> a<b README.md"]),
    ["<a href=\"docs/a.md\">guide</a> <img src='x.md' /> a<b [README.md](pi-open://1/repo/README.md)"]);
  // A URL with parentheses is still one link target, so its label is not linked a second time.
  assert.deepEqual(link(["[README.md](https://x.dev/a_(b)) and [notes](docs/a_(1).md)"]),
    ["[README.md](https://x.dev/a_(b)) and [notes](pi-open://1/repo/docs/a_(1).md)"]);
});

test("paints hyperlinks and closes them at the end of each row", () => {
  const row = paint({ spans: [{ text: "a " }, { text: "link", style: { fg: "#ff0000", underline: true, link: "pi-open://1/%2Fa.md" } }] }, 10);
  assert.match(row, /\x1b\]8;;pi-open:\/\/1\/%2Fa\.md\x1b\\\x1b\[0m\x1b\[4;38;2;255;0;0mlink/);
  assert.ok(row.endsWith("link\x1b]8;;\x1b\\\x1b[0m    \x1b[0m"));
  assert.equal(plain(row), "a link    ");
});

test("lays out Markdown: headings with anchors, lists, tasks, quotes, code and tables", { skip: !lexer }, () => {
  const source = [
    "# Guide", "", "Intro with **bold**, `code` and a [link](other.md#part).", "",
    "## Steps", "", "- one", "  - nested", "- [x] done", "", "1. first", "2. second", "",
    "> quoted", "", "```ts", "const a = 1;", "```", "", "| Key | Action |", "|---|--:|", "| q | close |", "",
    "## Steps",
  ].join("\n");
  const links: string[] = [];
  const doc = renderDoc(lexer!(source), { width: 40, palette: DEFAULT_PALETTE, link: (href) => { links.push(href); return `pi-open://1/${href}`; } });
  const text = doc.rows.map((row) => plain(paint(row, 40)).trimEnd());
  assert.deepEqual(text.slice(0, 4), ["Guide", "─".repeat(40), "", "Intro with bold, code and a link."]);
  assert.ok(text.includes("• one") && text.includes("  ◦ nested") && text.includes("☑ done"));
  assert.ok(text.includes("1. first") && text.includes("│ quoted") && text.includes(" const a = 1;"));
  assert.deepEqual(text.filter((line) => /^[┌│├└]/.test(line) && !line.includes("quoted")), [
    "┌─────┬────────┐", "│ Key │ Action │", "├─────┼────────┤", "│ q   │  close │", "└─────┴────────┘",
  ]);
  assert.deepEqual([...doc.anchors.keys()], ["guide", "steps", "steps-1"]);
  assert.equal(text[doc.anchors.get("steps")!], "Steps");
  assert.equal(doc.headings.length, 3);
  assert.deepEqual(links, ["other.md#part"]);
  const link = doc.rows[3].spans.find((span) => span.style?.link);
  assert.equal(link?.style?.link, "pi-open://1/other.md#part");
  // Code rows carry the block's background to the pane's edge.
  assert.ok(doc.rows.find((row) => plain(paint(row, 40)).includes("const a"))?.fill);
  assert.equal(slug("Hello, World! (v2)"), "hello-world-v2");
});

test("reads a document without marked as paragraphs, headings and fenced code", () => {
  const tokens = plainLexer("# Title\n\nSome text\nmore\n\n```sh\necho hi\n```\n");
  assert.deepEqual(tokens.map((token) => token.type), ["heading", "paragraph", "code"]);
  const doc = renderDoc(tokens, { width: 30, palette: DEFAULT_PALETTE, link: () => undefined });
  const text = (rows: typeof doc.rows) => rows.map((row) => plain(paint(row, 30)).trimEnd()).filter(Boolean);
  assert.deepEqual(text(doc.rows), ["Title", "─".repeat(30), "Some text more", " echo hi"]);
  // Windows line endings: the heading is still one, and no ␍ shows.
  const crlf = plainLexer("# Title\r\n\r\nSome text\r\nmore\r\n\r\n```sh\r\necho hi\r\n```\r\n");
  assert.deepEqual(text(renderDoc(crlf, { width: 30, palette: DEFAULT_PALETTE, link: () => undefined }).rows), text(doc.rows));
});

test("frames the document with a title, position, scrollbar and key bar", () => {
  const doc = renderDoc(plainLexer(Array.from({ length: 40 }, (_, i) => `Paragraph ${i}`).join("\n\n")), { width: 37, palette: DEFAULT_PALETTE, link: () => undefined });
  const view: DocView = { title: "docs/guide.md", doc, scroll: 10, columns: 40, rows: 20, palette: DEFAULT_PALETTE, help: false, back: true };
  const layout = layoutDoc(view);
  const text = layout.rows.map((row) => plain(paint(row, 40)));
  assert.match(text[0], /^ docs\/guide\.md +\d+% $/);
  assert.match(text[2], /^ Paragraph 5 /);
  assert.ok(layout.scrollbar && layout.scrollbar.column === 39);
  assert.match(text[19], /⌫ +back +p +n heading/);
  assert.ok(layout.keys!.items.some((item) => item.key === "backspace"));
});

type DocState = { blocks: Set<string>; waits: Array<() => void> };
function harness(dir: string, options: { diff?: string; placed?: boolean; handler?: boolean; state?: DocState } = {}) {
  const commands = new Map<string, any>(), handlers = new Map<string, Function>();
  let transformer: ((markdown: string, context: object) => string) | undefined;
  const calls: Array<[string, string, any]> = [], notes: string[] = [];
  const state: DocState = options.state ?? { blocks: new Set<string>(options.placed === false ? [] : [options.diff ?? ""]), waits: [] };
  const run = async (command: string, args: string[]) => {
    if (args[0] === "--version") return "v26.1.0\n";
    if (args[0] === "block") { calls.push([command, "size", args]); return JSON.stringify({ columns: 70, rows: 50 }); }
    const method = args[4], request = JSON.parse(args[5]);
    calls.push([command, method, request]);
    if (method === "session.view") return JSON.stringify({ windows: [{ blocks: [...state.blocks].map((id) => ({ block_id: id })) }] });
    if (method === "session.new_split") { state.blocks.add("block:doc"); return JSON.stringify({ block_ids: ["block:doc"] }); }
    if (method === "session.detach_block") state.blocks.delete(request.block_id);
    if (method === "session.move_block") state.blocks.add(request.block_id);
    return "{}";
  };
  const pi = {
    registerCommand: (name: string, c: any) => commands.set(name, c),
    on: (name: string, h: Function) => handlers.set(name, h),
    registerMarkdownTransformer: (fn: any) => { transformer = fn; },
  };
  const bin = join(dir, "bin");
  registerDocs(pi as any, {
    palette: () => ({}), diff: { block: () => options.diff }, run, dir: join(dir, "ipc"), pid: 4242,
    env: { PATH: bin, REX_SESSION: "session:s", REX_BLOCK: "block:pi" },
    settings: () => DEFAULT_SETTINGS, handler: () => options.handler ?? true,
    wait: () => { let done!: () => void; const promise = new Promise<void>((resolve) => { done = resolve; }); state.waits.push(done); return { done: promise, stop: () => {} }; },
    sleep: async () => {},
  });
  const ctx = { mode: "tui", cwd: dir, ui: { notify: (m: string) => notes.push(m) } };
  return { command: commands.get("md"), handlers, calls, notes, ctx, state, transform: (md: string) => transformer!(md, {}) };
}

async function setup(t: test.TestContext) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "diff-docs-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "bin"));
  for (const name of ["rex", "node"]) await writeFile(join(dir, "bin", name), "", { mode: 0o755 });
  await writeFile(join(dir, "guide.md"), "# Guide\n");
  return dir;
}

const methods = (calls: Array<[string, string, any]>) => calls.map(([, method]) => method).filter((method) => method !== "session.view" && method !== "size");

test("a document takes the diff pane's place, and closing it brings the diff back", async (t) => {
  const dir = await setup(t);
  const h = harness(dir, { diff: "block:diff" });
  h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
  await h.command.handler("guide.md#intro", h.ctx);
  assert.deepEqual(h.notes, []);
  assert.deepEqual(methods(h.calls), ["session.new_split", "session.detach_block"]);
  const [, , split] = h.calls.find(([, method]) => method === "session.new_split")!;
  assert.equal(split.anchor_id, "block:diff");
  assert.equal(split.layout.block.label, "guide.md");
  assert.deepEqual(split.layout.block.options.size, { columns: 70, rows: 50 });
  const command: string[] = split.layout.block.options.command;
  assert.match(command[1], /extensions\/diff\/doc\.ts$/);
  assert.deepEqual(command.slice(2, 8), ["--file", join(dir, "guide.md"), "--ipc", join(dir, "ipc"), "--pi-pid", "4242"]);
  assert.deepEqual(command.slice(-2), ["--anchor", "intro"]);

  // The document closes: once Rex drops its block, the diff goes back beside Pi at a third.
  h.state.blocks.delete("block:doc");
  h.calls.length = 0;
  h.state.waits[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(methods(h.calls), ["session.move_block", "session.resize_pane"]);
  assert.deepEqual(h.calls.find(([, method]) => method === "session.move_block")![2], {
    session_id: "session:s", block_id: "block:diff", anchor_block_id: "block:pi", direction: "horizontal", side: "after", ratio: 0.6667,
  });
});

test("a document left open across a session switch still gives the diff its place back", async (t) => {
  const dir = await setup(t);
  const h = harness(dir, { diff: "block:diff" });
  h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
  await h.command.handler("guide.md", h.ctx);
  // /new: Pi shuts this instance down and builds another in the same process, with a new context.
  h.handlers.get("session_shutdown")!({ reason: "new" });
  const next = harness(dir, { diff: "block:diff", state: h.state });
  next.handlers.get("session_start")!({ reason: "new" }, next.ctx);
  assert.equal(h.state.waits.length, 2, "the new instance follows the open document");

  h.state.blocks.delete("block:doc");
  h.calls.length = 0;
  h.state.waits[0]();
  h.state.waits[1]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(methods(h.calls), [], "the replaced instance does nothing with its stale context");
  assert.deepEqual(methods(next.calls), ["session.move_block", "session.resize_pane"]);
  assert.deepEqual([h.notes, next.notes], [[], []]);
});

test("without a diff pane, a document opens beside Pi and leaves nothing to restore", async (t) => {
  const dir = await setup(t);
  const h = harness(dir, { diff: "block:diff", placed: false });
  h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
  await h.command.handler("guide.md", h.ctx);
  assert.deepEqual(methods(h.calls), ["session.new_split", "session.resize_pane"]);
  assert.equal(h.calls.find(([, method]) => method === "session.new_split")![2].anchor_id, "block:pi");
  h.calls.length = 0;
  h.state.waits[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(methods(h.calls), []);

  await h.command.handler("missing.md", h.ctx);
  assert.match(h.notes.at(-1)!, /No such file: missing\.md/);
  await h.command.handler("", h.ctx);
  assert.match(h.notes.at(-1)!, /Usage: \/md PATH/);
});

test("an open document pane switches documents in place", async (t) => {
  const dir = await setup(t);
  const h = harness(dir, { diff: "block:diff" });
  h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
  await h.command.handler("guide.md", h.ctx);
  const child = spawn("sleep", ["30"]);
  t.after(() => child.kill());
  await writeFile(join(dir, "ipc", "4242.doc-viewer"), String(child.pid));
  await writeFile(join(dir, "other.md"), "# Other\n");
  h.calls.length = 0;
  await h.command.handler("other.md", h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(methods(h.calls), ["session.set_block_label"]);
  const message = JSON.parse(await readFile(join(dir, "ipc", "4242.doc"), "utf8"));
  assert.deepEqual({ event: message.event, path: message.path }, { event: "open", path: join(dir, "other.md") });
});

test("opens what the handler app drops for this Pi, and links only with the app installed", async (t) => {
  const dir = await setup(t);
  const h = harness(dir);
  h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
  assert.match(h.transform("see guide.md"), /^see \[guide\.md\]\(pi-open:\/\/4242\/.*guide\.md\)$/);
  await writeFile(join(dir, "ipc", "4242.open.abc"), docUrl(4242, join(dir, "guide.md")));
  await writeFile(join(dir, "ipc", "4242.open.def"), docUrl(9999, join(dir, "guide.md")));
  for (let i = 0; i < 50 && !h.calls.some(([, method]) => method === "session.new_split"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(h.calls.some(([, method]) => method === "session.new_split"));
  assert.deepEqual(readdirSync(join(dir, "ipc")).filter((name) => name.includes(".open.")), []);
  h.handlers.get("session_shutdown")!({ reason: "quit" });

  const without = harness(dir, { handler: false });
  without.handlers.get("session_start")!({ reason: "startup" }, without.ctx);
  assert.equal(without.transform("see guide.md"), "see guide.md");
});

test("the handler script hands a link to a running Pi's IPC directory", { skip: process.platform !== "darwin" }, async (t) => {
  const dir = ipcDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const script = join(import.meta.dirname, "../extensions/diff/handler/open.sh");
  const url = docUrl(process.pid, "/tmp/x.md");
  t.after(() => { for (const name of readdirSync(dir)) if (name.startsWith(`${process.pid}.open.`)) rm(join(dir, name), { force: true }); });
  execFileSync("/bin/sh", [script, url]);
  const written = readdirSync(dir).filter((name) => name.startsWith(`${process.pid}.open.`));
  assert.equal(written.length, 1);
  assert.equal(await readFile(join(dir, written[0]), "utf8"), url);
  // Malformed links and processes that are gone write nothing.
  assert.throws(() => execFileSync("/bin/sh", [script, "pi-open://abc/x"], { stdio: "ignore" }));
  execFileSync("/bin/sh", [script, docUrl(99_999_999, "/tmp/x.md")]);
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("99999999.")).length, 0);
});

/** Replays the viewer's frames into rows of plain text. */
function replay(output: string, rows = 24): string[] {
  const screen = Array<string>(rows).fill("");
  for (const match of output.matchAll(/\x1b\[(\d+);1H(.*?)(?=\x1b\[\d+;1H|\x1b\[\?2026l|$)/gs)) screen[Number(match[1]) - 1] = plain(match[2]);
  return screen;
}

test("the document viewer scrolls, follows links in place, goes back and reloads", { skip: !piBinary || !bundledMarked(piBinary) }, async (t) => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "diff-doc-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filler = Array.from({ length: 30 }, (_, i) => `Line ${i}.`).join("\n\n");
  await writeFile(join(dir, "a.md"), `# Alpha\n\nGo to [beta](b.md#later).\n\n${filler}\n\n## End\n`);
  await writeFile(join(dir, "b.md"), `# Beta\n\n${filler}\n\n## Later\n\nHere.\n`);
  const ipc = join(dir, "ipc");
  const viewer = spawn(process.execPath, [join(import.meta.dirname, "../extensions/diff/doc.ts"), "--file", join(dir, "a.md"), "--ipc", ipc,
    "--pi-pid", String(process.pid), "--root", dir, "--marked", bundledMarked(piBinary)!], { stdio: ["pipe", "pipe", "pipe"] });
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
  const has = (text: string) => (screen: string[]) => screen.some((line) => line.includes(text));

  let screen = await until(has("Go to beta."), "the first document");
  assert.match(screen[0], /^ a\.md +top $/);
  assert.equal(existsSync(join(ipc, `${process.pid}.doc-viewer`)), true);
  viewer.stdin.write("G");
  await until(has("End"), "G goes to the end");
  viewer.stdin.write("g");

  // A plain click on the link opens it here, at its anchor.
  screen = await until(has("Go to beta."), "back at the top");
  const row = screen.findIndex((line) => line.includes("Go to beta")) + 1;
  const column = screen[row - 1].indexOf("beta") + 2;
  viewer.stdin.write(`\x1b[<0;${column};${row}M\x1b[<0;${column};${row}m`);
  await until((s) => s[0].startsWith(" b.md") && has("Later")(s) && !has("Beta")(s), "the linked document at its heading");

  viewer.stdin.write("\x7f");
  await until((s) => s[0].startsWith(" a.md"), "⌫ goes back");

  // Pi asks for another document; edits to the file show up.
  await writeFile(join(ipc, `${process.pid}.doc`), JSON.stringify({ event: "open", path: join(dir, "b.md"), at: 1 }));
  await until((s) => s[0].startsWith(" b.md"), "Pi's request");
  await writeFile(join(dir, "b.md"), "# Beta, edited\n");
  await until(has("Beta, edited"), "a live reload");

  viewer.stdin.write("q");
  assert.equal(await new Promise((resolve) => viewer.on("exit", resolve)), 0);
  assert.equal(existsSync(join(ipc, `${process.pid}.doc-viewer`)), false);
});
