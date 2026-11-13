import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import {
  clip, diffExcerpt, diffStats, DIVIDER, displayPath, formatDuration, frame, grepStats, listedEntries, readLines, row, shellResult, splitCommand, wrapTail, type Measure,
} from "../extensions/tool-frames/layout.ts";
import { noModel, root } from "./helpers.ts";

const measure: Measure = {
  width: (text) => [...text].length,
  truncate: (text, width) => [...text].length <= width ? text : [...text].slice(0, Math.max(0, width - 1)).join("") + "…",
  wrap: (text, width) => { const chars = [...text]; const out = []; for (let i = 0; i < chars.length; i += width) out.push(chars.slice(i, i + width).join("")); return out; },
};
const same = (s: string) => s;

test("a frame carries the title and meta on its top rule and pads every row to the width", () => {
  const lines = frame(measure, { width: 30, title: "$ ls", meta: "✓ 0.1s", body: ["a", DIVIDER, "b".repeat(40)], paint: same });
  assert.deepEqual(lines, [
    `╭─ $ ls ${"─".repeat(12)} ✓ 0.1s ─╮`,
    `│ a${" ".repeat(25)} │`,
    `├${"╌".repeat(28)}┤`,
    `│ ${"b".repeat(25)}… │`,
    `╰${"─".repeat(28)}╯`,
  ]);
  for (const line of lines) assert.equal(measure.width(line), 30, line);
});

test("a long title gives way to the meta, and a narrow row drops the frame", () => {
  const [top] = frame(measure, { width: 30, title: "x".repeat(80), meta: "exit 1", body: [], paint: same });
  assert.equal(measure.width(top), 30);
  assert.match(top, /^╭─ x+… ─+ exit 1 ─╮$/);
  assert.deepEqual(frame(measure, { width: 20, title: "edit a.ts", meta: "+1 −0", body: ["+1 x", DIVIDER], paint: same }), ["edit a.ts      +1 −0", "+1 x"]);
});

test("a row right-aligns its outcome and drops it before the subject", () => {
  assert.equal(row(measure, 20, "● read a.ts", "3 lines"), "● read a.ts  3 lines");
  assert.equal(row(measure, 16, "● read a.ts", "300 lines"), "● read a.ts", "no room for both");
  assert.equal(row(measure, 22, "● read some/long/path.ts", "3 lines"), "● read some/l… 3 lines");
});

test("clips from either end and formats durations", () => {
  assert.deepEqual(clip([1, 2, 3, 4], 2), { shown: [1, 2], hidden: 2 });
  assert.deepEqual(clip([1, 2, 3, 4], 2, "end"), { shown: [3, 4], hidden: 2 });
  assert.deepEqual(clip([1], 2), { shown: [1], hidden: 0 });
  assert.deepEqual([40, 1234, 61_000, 3_725_000].map(formatDuration), ["0.0s", "1.2s", "1m 1s", "1h 2m"]);
});

test("a collapsed tail wraps only the lines its rows come from", () => {
  const wrapped: string[] = [];
  const counting: Measure = { ...measure, wrap: (text, width) => { wrapped.push(text); return measure.wrap(text, width); } };
  const lines = [...Array.from({ length: 2000 }, (_, i) => `line ${i}`), "x".repeat(25), "", "end"];
  assert.deepEqual(wrapTail(counting, lines, 10, 4), { shown: ["xxxxxxxxxx", "xxxxx", "", "end"], hidden: 1999 + 2 });
  assert.deepEqual(wrapped, ["line 1999", "x".repeat(25), "end"]);
  assert.deepEqual(wrapTail(counting, ["a", "b"], 10, 4), { shown: ["a", "b"], hidden: 0 });
  assert.deepEqual(wrapTail(counting, [], 10, 4), { shown: [], hidden: 0 });
});

test("paths read relative to the working directory, then home", () => {
  assert.equal(displayPath("/h/src/repo/a/b.ts", "/h/src/repo", "/h"), "a/b.ts");
  assert.equal(displayPath("a/b.ts", "/h/src/repo", "/h"), "a/b.ts");
  assert.equal(displayPath("/h/src/repo", "/h/src/repo", "/h"), ".");
  assert.equal(displayPath("/h/src/other/x", "/h/src/repo", "/h"), "~/src/other/x");
  assert.equal(displayPath("~/notes.md", "/h/src/repo", "/h"), "~/notes.md");
  assert.equal(displayPath("/tmp/x", "/h/src/repo", "/h"), "/tmp/x");
  assert.equal(displayPath("/h/src/repo-two/x", "/h/src/repo", "/h"), "~/src/repo-two/x", "a sibling sharing the prefix is outside");
});

const DIFF = [
  "  8 import a;",
  "  9 import b;",
  " 10 ",
  "-11 const x = 1;",
  "+11 const x = 2;",
  "+12 const y = 3;",
  " 13 ",
  " 14 a();",
  " 15 b();",
  " 16 c();",
  "-17 d();",
  " 18 e();",
  " 19 f();",
].join("\n");

test("counts an edit diff and keeps one line of context around each change in its excerpt", () => {
  assert.deepEqual(diffStats(DIFF), { added: 2, removed: 2 });
  assert.deepEqual(diffStats(""), { added: 0, removed: 0 });
  assert.deepEqual(diffExcerpt(DIFF, 50), {
    shown: [" 10 ", "-11 const x = 1;", "+11 const x = 2;", "+12 const y = 3;", " 13 ", "   ⋯", " 16 c();", "-17 d();", " 18 e();"],
    hidden: 0,
  });
  assert.deepEqual(diffExcerpt(DIFF, 3), { shown: [" 10 ", "-11 const x = 1;", "+11 const x = 2;"], hidden: 2 });
});

test("separates shell output from how the command ended", () => {
  assert.deepEqual(shellResult("ok\n", false), { output: "ok", status: { kind: "ok" }, fullOutputPath: undefined });
  assert.deepEqual(shellResult("(no output)", false).output, "");
  assert.deepEqual(shellResult("boom\n\nCommand exited with code 101", true), { output: "boom", status: { kind: "exit", code: 101 }, fullOutputPath: undefined });
  assert.deepEqual(shellResult("Command exited with code 2", true).output, "");
  assert.deepEqual(shellResult("x\nCommand timed out after 60 seconds. The shell exited with code 0 after 1.2 seconds, but background processes it started kept writing output until the timeout.", true).status, { kind: "timeout", seconds: 60 });
  assert.deepEqual(shellResult("x\nCommand aborted", true).status, { kind: "aborted" });
  assert.deepEqual(shellResult("something odd", true).status, { kind: "failed" });
  assert.deepEqual(shellResult("log says:\nCommand exited with code 3\n", false), { output: "log says:\nCommand exited with code 3", status: { kind: "ok" }, fullOutputPath: undefined });
  assert.deepEqual(shellResult("a\n[Showing lines 3-4 of 4. Full output: /tmp/pi-bash-2.log]", false), { output: "a", status: { kind: "ok" }, fullOutputPath: "/tmp/pi-bash-2.log" });
  assert.deepEqual(shellResult("a\nb\n[Showing lines 3-4 of 4. Full output: /tmp/pi-bash-1.log]\nCommand exited with code 1", true),
    { output: "a\nb", status: { kind: "exit", code: 1 }, fullOutputPath: "/tmp/pi-bash-1.log" });
});

test("long runs of spaces inside output or a command are trimmed in linear time", () => {
  const spaces = " ".repeat(200_000);
  const started = performance.now();
  assert.equal(shellResult(`a${spaces}b \n`, false).output, `a${spaces}b`);
  assert.equal(splitCommand(` echo a${spaces}b \n`, "/h").title, `echo a${spaces}b`);
  // The trimming regular expressions this replaced took seconds on each of these.
  assert.ok(performance.now() - started < 500);
});

test("a command's title drops a cd into the working directory and keeps the rest", () => {
  assert.deepEqual(splitCommand("cd /h/src/repo && git status", "/h/src/repo", "/h"), { title: "git status", rest: [] });
  assert.deepEqual(splitCommand("cd '/h/src/repo'; ls", "/h/src/repo", "/h"), { title: "ls", rest: [] });
  assert.deepEqual(splitCommand("cd ~/src/repo && ls", "/h/src/repo", "/h"), { title: "ls", rest: [] });
  assert.deepEqual(splitCommand("cd /elsewhere && ls", "/h/src/repo", "/h"), { title: "cd /elsewhere && ls", rest: [] });
  assert.deepEqual(splitCommand("python3 - <<'EOF'\nprint(1)\nEOF\n", "/h", "/h"), { title: "python3 - <<'EOF'", rest: ["print(1)", "EOF"] });
});

test("summarizes lookups from their output", () => {
  assert.equal(readLines("a\nb\nc\n\n[47 more lines in file. Use offset=4 to continue.]"), 3);
  assert.equal(readLines("a\nb\n"), 2);
  assert.equal(readLines(""), 0);
  assert.equal(readLines("[a]\nb = 1\n[tool.x]"), 3, "a file's own bracketed last line is content");
  assert.deepEqual(grepStats("a.ts:3: x\na.ts-4- ctx\nb/c.ts:10: y\na.ts:9: z\n\n[100 matches limit reached]"), { hits: 3, files: 2 });
  assert.deepEqual(grepStats("No matches found"), { hits: 0, files: 0 });
  assert.equal(listedEntries("a.ts\nb/\n\n[1000 results limit reached]"), 2);
  assert.equal(listedEntries("No files found matching pattern"), 0);
  assert.equal(listedEntries("(empty directory)"), 0);
});

// The status lines are Pi's own wording, which only a run of its bash tool pins.
test("installed Pi's bash results are read and drawn as framed rows", (t) => {
  const check = spawnSync("pi", ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", "-e", join(root, "tests/fixtures/tool-frames-smoke.ts"), ...noModel, "-p", "/tool-frames-smoke"], { cwd: root, encoding: "utf8", timeout: 30000 });
  if (check.error && (check.error as any).code === "ENOENT") { t.skip("Pi is not installed"); return; }
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /tool-frames integration:.*passed/);
});
