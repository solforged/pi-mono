import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  analyze, applyGroups, applyHunks, buildPrompt, checkMessages, createPlan, fitParts, formatPlan, loadStyle, parseGroups, parseHunks,
  parsePorcelainV2, planValid, snapshot, type FileState, type GitCtx, type Plan, type Unit,
} from "../extensions/workflows/commit.ts";
import { runProcess } from "../extensions/workflows/process.ts";
import { hash } from "../extensions/workflows/state.ts";
import { temporary } from "./helpers.ts";

const file = (path: string, digest = "d", extra: Partial<FileState> = {}): FileState => ({ path, digest, code: ".M", state: "changed", ...extra });

test("porcelain v2 parses modifications, renames, and untracked files", () => {
  const raw = [
    "1 .M N... 100644 100644 100644 abc abc keep.txt",
    "2 R. N... 100644 100644 100644 def def R100 new.txt",
    "old.txt",
    "? dir/u.txt",
    "? lone.txt",
  ].join("\0") + "\0";
  const files = parsePorcelainV2(raw);
  assert.deepEqual(files.map((item) => item.path), ["keep.txt", "new.txt", "old.txt", "dir/u.txt", "lone.txt"]);
  assert.equal(files[1].origPath, "old.txt");
  assert.equal(files[2].origPath, "new.txt");
  assert.equal(files[3].state, "untracked");
  assert.equal(parsePorcelainV2("u UU N... 100644 100644 100644 100644 a a a conflict.txt\0")[0].state, "unmerged");
  assert.throws(() => parsePorcelainV2("1 .M N... 100644 100644 100644 abc abc ../escape\0"), /Unsafe path/);
});

test("-U0 hunks apply in any subset, including EOF newline changes", () => {
  const diff = [
    "diff --git a/f b/f", "index 1..2 100644", "--- a/f", "+++ b/f",
    "@@ -0,0 +1 @@", "+top",
    "@@ -2 +3 @@ fn", "-b", "+B",
    "@@ -5 +6,2 @@", "-e", "\\ No newline at end of file", "+e", "+f",
  ].join("\n") + "\n";
  const hunks = parseHunks(diff)!;
  assert.equal(hunks.length, 3);
  const base = "a\nb\nc\nd\ne";
  assert.equal(applyHunks(base, hunks), "top\na\nB\nc\nd\ne\nf\n");
  assert.equal(applyHunks(base, [hunks[1]]), "a\nB\nc\nd\ne");
  assert.equal(applyHunks(base, [hunks[2], hunks[0]]), "top\na\nb\nc\nd\ne\nf\n");
  const noEol = parseHunks("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n")!;
  assert.equal(applyHunks("a\n", noEol), "b");
  assert.equal(parseHunks("diff --git a/f b/f\nnew file mode 100644\n@@ -0,0 +1 @@\n+x\n"), null);
  assert.equal(parseHunks("diff --git a/f b/f\nBinary files a/f and b/f differ\n"), null);
});

test("plans cover every unit once; bare file IDs expand to their hunks", () => {
  const units: Unit[] = [
    { id: "F1", paths: ["a.ts"] },
    { id: "F2.1", paths: ["b.ts"], hunk: 0 }, { id: "F2.2", paths: ["b.ts"], hunk: 1 },
    { id: "F3", paths: ["new.ts", "old.ts"] },
  ];
  const groups = parseGroups(JSON.stringify({
    groups: [
      { subject: " feat(cli): added parser ", body: "- Kept it.  \r\n", units: ["F1", "F2.2"] },
      { subject: "fix(cli): renamed helper", units: ["F2.1", "F3"] },
    ],
  }), units);
  assert.equal(groups[0].subject, "feat(cli): added parser");
  assert.equal(groups[0].body, "- Kept it.");
  assert.deepEqual(groups[1].units, ["F2.1", "F3"]);
  assert.deepEqual(parseGroups(JSON.stringify({ groups: [{ subject: "x", units: ["F1", "F2", "F3"] }] }), units)[0].units, ["F1", "F2.1", "F2.2", "F3"]);
  assert.throws(() => parseGroups(JSON.stringify({ groups: [{ subject: "x", units: ["F1", "F3"] }] }), units), /Unassigned units: F2.1, F2.2/);
  assert.throws(() => parseGroups(JSON.stringify({ groups: [{ subject: "x", units: ["F1", "F2", "F2.1", "F3"] }] }), units), /multiple groups/);
  assert.throws(() => parseGroups(JSON.stringify({ groups: [{ subject: "x", units: ["F9"] }] }), units), /Unknown unit/);
  assert.throws(() => parseGroups(JSON.stringify({ groups: [{ subject: "a\nb", units: ["F1", "F2", "F3"] }] }), units), /single/);
});

test("cached plans survive partial commits and invalidate on edits or style changes", () => {
  const files = [file("a.ts", "1"), file("b.ts", "2")];
  const plan: Plan = {
    version: 2, repo: "/repo", base: "abc", head: "abc", style: hash("style"), files, hunks: {}, created: "now",
    units: [{ id: "F1", paths: ["a.ts"] }, { id: "F2", paths: ["b.ts"] }],
    groups: [
      { subject: "feat(cli): added a", body: "", units: ["F1"], status: "pending" },
      { subject: "feat(cli): added b", body: "", units: ["F2"], status: "pending" },
    ],
  };
  assert.equal(planValid(plan, "/repo", "abc", files, "style"), true);
  assert.equal(planValid(plan, "/repo", "abc", files, "new style"), false);
  assert.equal(planValid(plan, "/other", "abc", files, "style"), false);
  assert.equal(planValid(plan, "/repo", "def", files, "style"), false);
  assert.equal(planValid(plan, "/repo", "abc", [file("a.ts", "changed"), file("b.ts", "2")], "style"), false);
  assert.equal(planValid(plan, "/repo", "abc", [file("b.ts", "2")], "style"), false);
  plan.groups[0].status = "done";
  plan.head = "def";
  assert.equal(planValid(plan, "/repo", "def", [file("b.ts", "2")], "style"), true);
  assert.equal(planValid(plan, "/repo", "def", [file("a.ts", "edited"), file("b.ts", "2")], "style"), false);
  assert.match(formatPlan(plan), /added b/);
});

async function isolated(t: { after: (fn: () => Promise<unknown>) => unknown }) {
  const dir = await temporary(t);
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  const hooks = join(dir, "hooks");
  await mkdir(repo);
  await mkdir(hooks);
  await mkdir(join(home, "xdg", "git"), { recursive: true });
  const globalConfig = join(home, "gitconfig");
  await writeFile(globalConfig, `[user]\n  name = Test\n  email = test@example.invalid\n[commit]\n  gpgsign = false\n[core]\n  hooksPath = ${hooks}\n`);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "xdg"),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const signal = AbortSignal.timeout(15000);
  const git = async (...args: string[]) => {
    const result = await runProcess("git", args, { cwd: repo, signal, env });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  await git("init", "-q");
  const ctx: GitCtx = { repo, signal, env };
  const hook = async (name: string, body: string) => {
    await writeFile(join(hooks, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(hooks, name), 0o755);
  };
  return { repo, env, signal, git, ctx, hook, home };
}

const lines = (count: number, edit: Record<number, string> = {}) => Array.from({ length: count }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

test("style comes from the global file plus a repository addition", async (t) => {
  const { repo, env, home } = await isolated(t);
  assert.match(await loadStyle(repo, env), /No house style file/);
  await writeFile(join(home, "xdg", "git", "commit-style.md"), "Use past tense.\n");
  await writeFile(join(repo, ".commit-style.md"), "Scope is the top directory.\n");
  const style = await loadStyle(repo, env);
  assert.match(style, /Global house style:\nUse past tense\./);
  assert.match(style, /Repository house style.*:\nScope is the top directory\./);
});

test("hunks of one file land in separate commits", async (t) => {
  const { repo, git, ctx } = await isolated(t);
  await writeFile(join(repo, "app.txt"), lines(30));
  await git("add", ".");
  await git("commit", "-qm", "init");
  await writeFile(join(repo, "app.txt"), lines(30, { 2: "feature A", 25: "feature B" }));
  await writeFile(join(repo, "a.txt"), "helper for A\n");
  const current = await snapshot(ctx);
  const { units, sections } = await analyze(ctx, current.head, current.files);
  assert.deepEqual(units.map((unit) => unit.id).sort(), ["F1.1", "F1.2", "F2"]);
  assert.match(sections.join("\n"), /F1\.1 @@ -2 \+2 @@.*\n line 1\n-line 2\n\+feature A/);
  const plan = await createPlan(ctx, current, "style", async () => JSON.stringify({ groups: [
    { subject: "feat(app): added feature a", body: "- Added the helper.", units: ["F1.1", "F2"] },
    { subject: "feat(app): added feature b", units: ["F1.2"] },
  ] }));
  assert.match(formatPlan(plan), /app\.txt \(hunks 1 of 2\)/);
  const result = await applyGroups(ctx, plan, async () => {});
  assert.equal(result.error, undefined);
  assert.equal(await git("show", "HEAD~1:app.txt"), lines(30, { 2: "feature A" }));
  assert.match(await git("show", "--stat", "--format=%B", "HEAD~1"), /added feature a\n\n- Added the helper\.[\s\S]*a\.txt/);
  assert.equal(await git("show", "HEAD:app.txt"), lines(30, { 2: "feature A", 25: "feature B" }));
  assert.equal((await snapshot(ctx)).files.length, 0);
});

test("files that cannot be spliced exactly stay whole", async (t) => {
  const { repo, git, ctx } = await isolated(t);
  await writeFile(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3, 10, 0, 5]));
  await writeFile(join(repo, "mode.sh"), lines(20));
  await git("add", ".");
  await git("commit", "-qm", "init");
  await writeFile(join(repo, "bin.dat"), Buffer.from([0, 9, 2, 3, 10, 0, 6]));
  await writeFile(join(repo, "mode.sh"), lines(20, { 1: "x", 20: "y" }));
  await chmod(join(repo, "mode.sh"), 0o755);
  const current = await snapshot(ctx);
  const { units } = await analyze(ctx, current.head, current.files);
  assert.deepEqual(units.map((unit) => unit.id), ["F1", "F2"]);
});

test("commit-msg hook failures are fed back to the planner", async (t) => {
  const { repo, git, ctx, hook } = await isolated(t);
  await git("commit", "--allow-empty", "-qm", "init");
  await hook("commit-msg", "grep -q '^[a-z]*: ' \"$1\" || { echo 'header must be type: summary' >&2; exit 1; }");
  await writeFile(join(repo, "x.txt"), "x\n");
  assert.equal((await checkMessages(ctx, [{ subject: "chore: added x", body: "", units: [], status: "pending" }])).length, 0);
  const prompts: string[] = [];
  const current = await snapshot(ctx);
  const plan = await createPlan(ctx, current, "style", async (_system, prompt) => {
    prompts.push(prompt);
    return JSON.stringify({ groups: [{ subject: prompts.length === 1 ? "Added x" : "chore: added x", units: ["F1"] }] });
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Group 1 \("Added x"\) failed the commit-msg hook:\nheader must be type: summary/);
  assert.equal(plan.groups[0].subject, "chore: added x");
});

test("applyGroups retries remaining groups after a hook failure", async (t) => {
  const { repo, git, ctx, hook } = await isolated(t);
  await writeFile(join(repo, "app.txt"), lines(30));
  await git("add", ".");
  await git("commit", "-qm", "init");
  await writeFile(join(repo, "app.txt"), lines(30, { 3: "ok", 27: "secret" }));
  await hook("pre-commit", "git diff --cached | grep -q '^+secret' && { echo gitleaks >&2; exit 1; }\nexit 0");
  const current = await snapshot(ctx);
  const plan = await createPlan(ctx, current, "style", async () => JSON.stringify({ groups: [
    { subject: "feat: added ok", units: ["F1.1"] },
    { subject: "feat: added secret", units: ["F1.2"] },
  ] }));
  const first = await applyGroups(ctx, plan, async () => {});
  assert.deepEqual(first.committed, ["feat: added ok"]);
  assert.match(first.error ?? "", /gitleaks/);
  const retryTree = await snapshot(ctx);
  assert.equal(planValid(plan, repo, retryTree.head, retryTree.files, "style"), true);
  await hook("pre-commit", "exit 0");
  const second = await applyGroups(ctx, plan, async () => {});
  assert.equal(second.error, undefined);
  assert.deepEqual(second.committed, ["feat: added secret"]);
  assert.equal(await git("show", "HEAD~1:app.txt"), lines(30, { 3: "ok" }));
  assert.equal((await snapshot(ctx)).files.length, 0);
});

test("a prompt over its budget cuts the longest units and still names every one", async (t) => {
  assert.deepEqual(fitParts(["a".repeat(50), "b".repeat(60)], 200), ["a".repeat(50), "b".repeat(60)]);
  const parts = fitParts(["F1 small.txt\nx", `F2 big.txt\n${"y".repeat(5000)}`, `F3 other.txt\n${"z".repeat(900)}`], 1500);
  assert.equal(parts[0], "F1 small.txt\nx");
  assert.match(parts[1], /^F2 big\.txt\ny+\n\[truncated\]$/);
  assert.match(parts[2], /^F3 other\.txt\nz+\n\[truncated\]$/);
  assert(parts.join("").length <= 1500 + 2 * "\n[truncated]".length);
  // Too many units for the budget: each keeps enough to be recognised.
  const many = fitParts(Array.from({ length: 50 }, (_, i) => `F${i + 1} file-${i + 1}.txt\n${"x".repeat(1000)}`), 1000);
  many.forEach((part, i) => assert(part.startsWith(`F${i + 1} file-${i + 1}.txt\n`) && part.length < 300, part.slice(0, 40)));

  const { repo, git, ctx } = await isolated(t);
  await git("commit", "--allow-empty", "-qm", "init");
  for (let i = 1; i <= 40; i++) await writeFile(join(repo, `new-${i}.txt`), `${"content ".repeat(240)}\n`);
  const current = await snapshot(ctx);
  const { units, sections } = await analyze(ctx, current.head, current.files);
  const prompt = await buildPrompt(ctx, sections);
  assert(Buffer.byteLength(sections.join("\n\n")) < 120000);
  for (const unit of units) assert.match(prompt, new RegExp(`^${unit.id} new-\\d+\\.txt \\(new file\\)$`, "m"));
});

test("a diff far larger than the planner reads does not stop planning", async (t) => {
  const { repo, git, ctx } = await isolated(t);
  const big = Array.from({ length: 6000 }, (_, i) => `generated line ${i} ${"x".repeat(40)}`).join("\n") + "\n";
  await writeFile(join(repo, "lock.json"), big);
  await writeFile(join(repo, "gone.txt"), big.replaceAll("generated", "obsolete"));
  await git("add", ".");
  await git("commit", "-qm", "init");
  // One hunk each, so both stay whole files: a rewrite and a deletion of about 300 KB.
  await writeFile(join(repo, "lock.json"), big.replaceAll("generated", "rewritten"));
  await git("rm", "-q", "gone.txt");
  const current = await snapshot(ctx);
  const { units, sections } = await analyze(ctx, current.head, current.files);
  assert.equal(units.length, 2);
  for (const section of sections) assert(Buffer.byteLength(section) < 7000, section.slice(0, 60));
  assert.match(sections.find((section) => section.includes("gone.txt"))!, /^F\d gone\.txt \(D\.\)\ndiff --git[\s\S]*-obsolete line 0 [\s\S]*\n\[truncated\]$/);
  assert.match(sections.find((section) => section.includes("lock.json"))!, /^F\d lock\.json \(\.M\)\ndiff --git[\s\S]*-generated line 0 [\s\S]*\n\[truncated\]$/);
  const plan = await createPlan(ctx, current, "style", async () => JSON.stringify({ groups: [{ subject: "chore: regenerated", units: units.map((unit) => unit.id) }] }));
  assert.equal((await applyGroups(ctx, plan, async () => {})).error, undefined);
  assert.equal((await snapshot(ctx)).files.length, 0);
});

test("files staged before the first commit are split like any others", async (t) => {
  const { repo, git, ctx } = await isolated(t);
  await writeFile(join(repo, "a.txt"), "alpha\n");
  await writeFile(join(repo, "b.txt"), "beta\n");
  await git("add", ".");
  const current = await snapshot(ctx);
  assert.equal(current.head, "unborn");
  const { sections } = await analyze(ctx, current.head, current.files);
  assert.deepEqual(sections, ["F1 a.txt (new file)\nalpha\n", "F2 b.txt (new file)\nbeta\n"]);
  const plan = await createPlan(ctx, current, "style", async () => JSON.stringify({ groups: [
    { subject: "feat: added a", units: ["F1"] }, { subject: "feat: added b", units: ["F2"] },
  ] }));
  const result = await applyGroups(ctx, plan, async () => {});
  assert.equal(result.error, undefined);
  assert.deepEqual(result.committed, ["feat: added a", "feat: added b"]);
  assert.equal((await git("show", "--stat", "--format=", "HEAD~1")).includes("b.txt"), false);
  assert.match(await git("show", "--stat", "--format=", "HEAD"), /b\.txt/);
});
