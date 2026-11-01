import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyGroups, fingerprint, formatPlan, parseGroups, parsePorcelainV2, planValid, snapshot, validateMessage, wrapParagraph,
  type FileState, type GitCtx, type Plan,
} from "../extensions/workflows/commit.ts";
import { runProcess } from "../extensions/workflows/process.ts";
import { temporary } from "./helpers.ts";

const file = (path: string, digest = "d", extra: Partial<FileState> = {}): FileState => ({ path, digest, code: "M", state: "changed", ...extra });

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

test("commit messages use omp headers and wrapped bullet bodies", () => {
  assert.equal(wrapParagraph("one two three four", 10), "one two\nthree four");
  assert.equal(validateMessage("feat(zsh): added foo.", "").subject, "feat(zsh): added foo");
  assert.equal(validateMessage("chore: removed old config", "").body, "");
  assert.equal(validateMessage("fix(git/hooks): fixed validation", "- Rejected invalid input.").body, "- Rejected invalid input.");
  assert.throws(() => validateMessage("x".repeat(73), ""), /72/);
  for (const subject of ["fix(git): Updated hooks", "plain subject", "fix(A): fixed hooks", "fix(a/b/c): fixed hooks"]) {
    assert.throws(() => validateMessage(subject, ""), /lowercase summary/);
  }
  for (const body of ["A prose paragraph.", "1. Added a thing.", "* Added a thing.", "- Added a thing", "- One.\n\nA paragraph."]) {
    assert.throws(() => validateMessage("fix(git): fixed hooks", body), /bullets|sentence/);
  }
  assert.throws(() => validateMessage("fix(git): fixed hooks", Array(7).fill("- Added a check.").join("\n")), /six bullets/);
  const body = "- Replaced the old policy with the current global commit style so generated messages passed the same checks as manual commits.\n- Kept existing hooks active.\n  Preserved their failure messages.";
  const wrapped = validateMessage("fix(git): aligned commit rules", body).body;
  assert.ok(wrapped.split("\n").every((line) => line.length <= 72));
  assert.ok(wrapped.split("\n").every((line) => /^(?:- | {2})\S/.test(line)));
  assert.equal(validateMessage("fix(git): aligned commit rules", wrapped).body, wrapped);
});

test("commit plans cover every path once and keep renames together", () => {
  const files = [file("a.ts"), file("b.ts"), file("new.ts", "n", { state: "renamed", origPath: "old.ts" }), file("old.ts", "deleted", { state: "renamed", origPath: "new.ts" })];
  const groups = parseGroups(JSON.stringify({
    groups: [
      { subject: "feat(cli): added parser", files: ["a.ts"] },
      { subject: "fix(cli): renamed helper.", body: "- Kept the old path with the new file.", files: ["b.ts", "new.ts", "old.ts"] },
    ],
  }), files);
  assert.equal(groups[0].files[0], "a.ts");
  assert.equal(groups[1].subject, "fix(cli): renamed helper");
  assert.match(groups[1].body, /Kept the old path/);
  assert.throws(() => parseGroups(JSON.stringify({ groups: [{ subject: "feat(cli): added parser", files: ["a.ts"] }] }), files), /Unassigned/);
  assert.throws(() => parseGroups(JSON.stringify({
    groups: [
      { subject: "feat(cli): added parser", files: ["a.ts", "new.ts"] },
      { subject: "fix(cli): left the rename", files: ["b.ts", "old.ts"] },
    ],
  }), files), /Rename must stay together/);
  assert.match(formatPlan(groups), /added parser/);
});

test("cached plans reuse the same remaining tree and invalidate on edits", () => {
  const files = [file("a.ts", "1"), file("b.ts", "2")];
  const plan: Plan = {
    version: 1, repo: "/repo", head: "abc", fingerprint: fingerprint("abc", files),
    files, created: "now",
    groups: [
      { subject: "feat(cli): added a", body: "", files: ["a.ts"], status: "pending" },
      { subject: "feat(cli): added b", body: "", files: ["b.ts"], status: "pending" },
    ],
  };
  assert.equal(planValid(plan, "/repo", "abc", files), true);
  const outdated = structuredClone(plan);
  outdated.groups[0].subject = "feat(cli): Added a";
  assert.equal(planValid(outdated, "/repo", "abc", files), false);
  outdated.groups[0].subject = plan.groups[0].subject;
  outdated.groups[0].body = "Used the old prose-paragraph policy.";
  assert.equal(planValid(outdated, "/repo", "abc", files), false);
  assert.equal(planValid(plan, "/other", "abc", files), false);
  assert.equal(planValid(plan, "/repo", "def", files), false);
  assert.equal(planValid(plan, "/repo", "abc", [file("a.ts", "changed"), file("b.ts", "2")]), false);
  plan.groups[0].status = "done";
  const remaining = [file("b.ts", "2")];
  plan.head = "def";
  plan.fingerprint = fingerprint("def", remaining);
  assert.equal(planValid(plan, "/repo", "def", remaining), true);
  assert.equal(planValid(plan, "/repo", "def", files), false);
});

async function isolated(t: { after: (fn: () => Promise<unknown>) => unknown }) {
  const dir = await temporary(t);
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  const hooks = join(dir, "hooks");
  await mkdir(repo);
  await mkdir(hooks);
  await mkdir(join(home, "xdg"), { recursive: true });
  const globalConfig = join(home, "gitconfig");
  await writeFile(globalConfig, "[user]\n  name = Test\n  email = test@example.invalid\n[commit]\n  gpgsign = false\n");
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
  await git("commit", "--allow-empty", "-qm", "init");
  const ctx: GitCtx = { repo, signal, env };
  return { repo, env, signal, git, ctx, hooks };
}

test("applyGroups commits in order and retries remaining groups after a hook failure", async (t) => {
  const { repo, git, ctx, hooks } = await isolated(t);
  await writeFile(join(repo, "ok.txt"), "ok\n");
  await writeFile(join(repo, "secret.txt"), "secret\n");
  const hook = join(hooks, "pre-commit");
  await writeFile(hook, "#!/bin/sh\ngit diff --cached --name-only | grep -q secret.txt && { echo gitleaks >&2; exit 1; }\nexit 0\n");
  await chmod(hook, 0o755);
  await git("config", "core.hooksPath", hooks);
  const current = await snapshot(ctx);
  assert.deepEqual(current.files.map((file) => file.path).sort(), ["ok.txt", "secret.txt"]);
  const plan: Plan = {
    version: 1, repo, head: current.head, fingerprint: fingerprint(current.head, current.files),
    files: current.files, created: "now",
    groups: [
      { subject: "feat(cli): added ok file", body: "", files: ["ok.txt"], status: "pending" },
      { subject: "feat(cli): added secret file", body: "", files: ["secret.txt"], status: "pending" },
    ],
  };
  const saved: Plan[] = [];
  const first = await applyGroups(ctx, plan, async (next) => { saved.push(structuredClone(next)); });
  assert.equal(first.committed.length, 1);
  assert.match(first.error ?? "", /gitleaks/);
  assert.equal(plan.groups[0].status, "done");
  assert.equal(plan.groups[1].status, "pending");
  const retryTree = await snapshot(ctx);
  assert.equal(planValid(plan, repo, retryTree.head, retryTree.files), true);
  await writeFile(hook, "#!/bin/sh\nexit 0\n");
  const second = await applyGroups(ctx, plan, async (next) => { saved.push(structuredClone(next)); });
  assert.equal(second.error, undefined);
  assert.deepEqual(second.committed, ["feat(cli): added secret file"]);
  const log = await git("log", "--format=%s");
  assert.match(log, /added ok file/);
  assert.match(log, /added secret file/);
  const clean = await snapshot(ctx);
  assert.equal(clean.files.length, 0);
  assert.ok(saved.length >= 2);
});
