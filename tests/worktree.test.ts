import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { create, editsMainCheckout, followTitle, inside, inspect, land, owned, remove, slugify, worktreeRoot, worktrees } from "../extensions/worktree/git.ts";
import { copyIncluded, included } from "../extensions/worktree/include.ts";
import { relocate, repositorySessionDirs, sessionBucket, sessionChoices, sessionDirFor, sessionFileFor } from "../extensions/worktree/session.ts";
import { root, temporary } from "./helpers.ts";

// Fixture repositories get no user or sandbox Git config. The extension's own Git
// calls inherit process.env, so it is isolated too: otherwise a signing policy,
// such as the sandbox's, refuses the commits that landing's rebase makes.
const env = Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const noTrust = async () => undefined;

async function repo(t: any) {
  const dir = await temporary(t);
  const main = join(dir, "proj");
  await mkdir(main);
  sh(main, "init", "-q", "-b", "main");
  sh(main, "config", "core.hooksPath", "/dev/null");
  await writeFile(join(main, "a.txt"), "a\n");
  sh(main, "add", "."); sh(main, "commit", "-qm", "chore: init");
  return { dir, main, wt: join(dir, "wt") };
}

test("slugs keep three meaningful words, ASCII and kebab-case", () => {
  assert.equal(slugify("Assess a fullscreen diff extension"), "assess-fullscreen-diff");
  assert.equal(slugify("Add Worktree Sessions to Pi"), "add-worktree-sessions");
  assert.equal(slugify("Fix the login flow"), "fix-login-flow");
  assert.equal(slugify("  Café: über/fix!! "), "cafe-uber-fix");
  assert.equal(slugify("to the"), "to-the", "all filler is kept rather than dropped");
  assert.equal(slugify("Internationalization infrastructure overhaul"), "internationalization");
  assert.equal(slugify("x".repeat(40)), "x".repeat(28));
  assert.equal(slugify("!!!"), undefined);
});

test("the worktree root defaults to ~/.pi/wt and refuses a relative override", () => {
  assert.match(worktreeRoot({}), /\/\.pi\/wt$/);
  assert.equal(worktreeRoot({ PI_WORKTREE_DIR: "/abs/wt" }), "/abs/wt");
  assert.throws(() => worktreeRoot({ PI_WORKTREE_DIR: "rel/wt" }), /must be absolute/);
});

test("worktrees use the ga layout, branch from HEAD, avoid collisions and report dirt", async (t) => {
  const { main, wt } = await repo(t);
  const checkout = (await inspect(main))!;
  assert.deepEqual([checkout.top, checkout.main, checkout.repo, checkout.linked, checkout.branch], [main, main, "proj", false, "main"]);
  assert.equal(await inspect(join(main, "..")), undefined);

  await writeFile(join(main, "a.txt"), "changed\n");
  const first = await create(checkout, "task", "s1", { root: wt, trust: noTrust });
  assert.deepEqual(first, { path: join(wt, "proj--task"), branch: "pi/task", dirty: true });
  assert.equal(readFileSync(join(first.path, "a.txt"), "utf8"), "a\n");
  sh(main, "branch", "pi/task-2");
  const second = await create(checkout, "task", "s2", { root: wt, trust: noTrust });
  assert.deepEqual([second.path, second.branch], [join(wt, "proj--task-3"), "pi/task-3"]);

  const linked = (await inspect(join(first.path)))!;
  assert.deepEqual([linked.top, linked.main, linked.linked, linked.branch], [first.path, main, true, "pi/task"]);

  // The edit guard covers paths in the main checkout only.
  assert.equal(editsMainCheckout(checkout, main, "src/x.ts"), true);
  assert.equal(editsMainCheckout(checkout, main, `@${main}/x.ts`), true);
  assert.equal(editsMainCheckout(checkout, main, "../elsewhere.txt"), false);
  assert.equal(editsMainCheckout(checkout, main, "~/notes.md"), inside(main, join(homedir(), "notes.md")));
  assert.equal(editsMainCheckout(linked, first.path, "x.ts"), false);
  assert.equal(editsMainCheckout(undefined, main, "x.ts"), false);
  assert.equal(editsMainCheckout(checkout, main, undefined), false);
  assert.equal(await owned("pi/task", "s1", first.path), true);
  assert.equal(await owned("pi/task", "s2", first.path), false);
});

test("an owned, unpushed branch follows the session title", async (t) => {
  const { main, wt } = await repo(t);
  const made = await create((await inspect(main))!, "session-1234", "s1", { root: wt, trust: noTrust });
  const at = async () => (await inspect(made.path))!;
  assert.equal(await followTitle(await at(), "other", "Some title here"), undefined);
  assert.equal(await followTitle(await at(), "s1", "Fix the login flow"), "pi/fix-login-flow");
  assert.equal(sh(made.path, "branch", "--show-current"), "pi/fix-login-flow");
  assert.equal(await followTitle(await at(), "s1", "Fix the login flow"), undefined);
  // Ownership moves with the branch.
  assert.equal(await owned("pi/fix-login-flow", "s1", made.path), true);
  sh(main, "branch", "pi/taken");
  assert.equal(await followTitle(await at(), "s1", "Taken"), "pi/taken-2");
  sh(main, "remote", "add", "origin", main);
  sh(made.path, "config", "branch.pi/taken-2.remote", "origin");
  sh(made.path, "config", "branch.pi/taken-2.merge", "refs/heads/pi/taken-2");
  sh(made.path, "update-ref", "refs/remotes/origin/pi/taken-2", "HEAD");
  assert.equal(await followTitle(await at(), "s1", "Pushed already"), undefined, "a branch with an upstream keeps its name");
});

test("removal keeps dirty worktrees and unmerged branches", async (t) => {
  const { main, wt } = await repo(t);
  const checkout = (await inspect(main))!;
  const dirty = await create(checkout, "dirty", "s1", { root: wt, trust: noTrust });
  await writeFile(join(dirty.path, "new.txt"), "x\n");
  assert.match(await remove(dirty.path, dirty.branch, "s1", main), /Kept .*uncommitted/);
  assert.ok(existsSync(dirty.path));

  const merged = await create(checkout, "merged", "s1", { root: wt, trust: noTrust });
  assert.match(await remove(merged.path, merged.branch, "s1", main), /Removed .* and pi\/merged\./);
  assert.ok(!existsSync(merged.path));
  assert.equal(sh(main, "branch", "--list", "pi/merged"), "");

  const ahead = await create(checkout, "ahead", "s1", { root: wt, trust: noTrust });
  await writeFile(join(ahead.path, "b.txt"), "b\n");
  sh(ahead.path, "add", "."); sh(ahead.path, "commit", "-qm", "feat: b");
  assert.match(await remove(ahead.path, ahead.branch, "s1", main), /kept pi\/ahead because it is not merged/);
  assert.notEqual(sh(main, "branch", "--list", "pi/ahead"), "");

  const foreign = await create(checkout, "foreign", "s1", { root: wt, trust: noTrust });
  assert.match(await remove(foreign.path, foreign.branch, "s2", main), /^Removed [^ ]+\.$/);
  assert.notEqual(sh(main, "branch", "--list", "pi/foreign"), "", "another session's branch is never deleted");
});

test("landing fast-forwards or rebases, and refuses unsafe cases without changing anything", async (t) => {
  const { main, wt } = await repo(t);
  const commit = async (cwd: string, file: string) => { await writeFile(join(cwd, file), `${file}\n`); sh(cwd, "add", file); sh(cwd, "commit", "-qm", `feat: ${file}`); };
  const made = await create((await inspect(main))!, "land", "s1", { root: wt, trust: noTrust });
  const at = async () => (await inspect(made.path))!;
  await assert.rejects(land(await at()), /no commits that main lacks/);
  await commit(made.path, "one.txt");
  await writeFile(join(made.path, "loose.txt"), "x\n");
  await assert.rejects(land(await at()), /Commit or discard/);
  sh(made.path, "clean", "-qf");
  assert.deepEqual(await land(await at()), { target: "main", commits: 1, rebased: false });
  assert.equal(sh(main, "rev-parse", "main"), sh(made.path, "rev-parse", "HEAD"));

  // A conflicting rebase is aborted and nothing moves.
  await writeFile(join(made.path, "a.txt"), "worktree\n"); sh(made.path, "commit", "-qam", "feat: worktree a");
  await writeFile(join(main, "a.txt"), "main\n"); sh(main, "commit", "-qam", "feat: main a");
  const [before, mainBefore] = [sh(made.path, "rev-parse", "HEAD"), sh(main, "rev-parse", "HEAD")];
  await assert.rejects(land(await at()), /conflicts\. Run git rebase main/);
  assert.deepEqual([sh(made.path, "rev-parse", "HEAD"), sh(main, "rev-parse", "HEAD")], [before, mainBefore]);
  assert.equal(sh(made.path, "status", "--porcelain"), "");

  // A pushed branch is not rewritten.
  sh(made.path, "reset", "-q", "--hard", "HEAD~1"); await commit(made.path, "two.txt");
  sh(main, "remote", "add", "origin", main);
  sh(made.path, "config", "branch.pi/land.remote", "origin"); sh(made.path, "config", "branch.pi/land.merge", "refs/heads/pi/land");
  sh(made.path, "update-ref", "refs/remotes/origin/pi/land", "HEAD");
  await assert.rejects(land(await at()), /has an upstream/);
  sh(made.path, "branch", "--unset-upstream");
  assert.deepEqual(await land(await at()), { target: "main", commits: 1, rebased: true });
  assert.equal(sh(main, "log", "--merges", "--format=%H"), "");
  assert.deepEqual((await worktrees(main)).map((tree) => [tree.path, tree.branch]), [[main, "main"], [made.path, "pi/land"]]);
});

test(".worktreeinclude copies only ignored, untracked matches and never overwrites", async (t) => {
  const { main, wt } = await repo(t);
  assert.deepEqual(await included(main), [], "no include file, nothing copied");
  await writeFile(join(main, ".gitignore"), ".env\nconfig/local.json\nlink\ncache/\nbuild/\n");
  await writeFile(join(main, ".worktreeinclude"), ".env\nconfig/\nlink\n*.local\ncache/\na.txt\n");
  sh(main, "add", ".gitignore"); sh(main, "commit", "-qm", "chore: ignore");
  await mkdir(join(main, "config")); await mkdir(join(main, "cache", "deep"), { recursive: true }); await mkdir(join(main, "build"));
  await writeFile(join(main, ".env"), "SECRET=1\n");
  await writeFile(join(main, "config", "local.json"), "{}\n");
  await writeFile(join(main, "config", "untracked.json"), "{}\n");   // matches, but not ignored
  await writeFile(join(main, "notes.local"), "x\n");                  // matches, but not ignored
  await writeFile(join(main, "cache", "deep", " spaced.bin"), "c\n");
  await writeFile(join(main, "build", "out.js"), "b\n");              // ignored, not listed
  await symlink(".env", join(main, "link"));
  assert.deepEqual(await included(main), [".env", "cache/deep/ spaced.bin", "config/local.json", "link"]);

  const made = await create((await inspect(main))!, "inc", "s1", { root: wt, trust: noTrust });
  await writeFile(join(made.path, ".env"), "KEEP=1\n");
  assert.deepEqual(await copyIncluded(main, made.path), ["cache/deep/ spaced.bin", "config/local.json", "link"]);
  assert.equal(await readFile(join(made.path, ".env"), "utf8"), "KEEP=1\n");
  assert.equal(await readFile(join(made.path, "config", "local.json"), "utf8"), "{}\n");
  assert.ok((await lstat(join(made.path, "link"))).isSymbolicLink());
  assert.equal(await readlink(join(made.path, "link")), ".env");
  assert.ok(!existsSync(join(made.path, "notes.local")) && !existsSync(join(made.path, "build")) && !existsSync(join(made.path, "config", "untracked.json")));
});

test("resume choices are newest first, skip empty sessions and stay unique", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  const at = (minutes: number) => new Date(now - minutes * 60_000);
  const base = { firstMessage: "Fix the login\nflow please", messageCount: 2, worktree: "/wt/proj--login", branch: "pi/login" };
  const choices = sessionChoices([
    { ...base, path: "/a", modified: at(5) },
    { ...base, path: "/b", modified: at(90), name: "Named session" },
    { ...base, path: "/c", modified: at(3 * 1440), branch: undefined },
    { ...base, path: "/d", modified: at(1), messageCount: 0 },
    { ...base, path: "/e", modified: at(5) },
  ], now);
  assert.deepEqual(choices.map((choice) => [choice.label, choice.session.path]), [
    ["Fix the login flow please · pi/login · 5m ago", "/a"],
    ["Fix the login flow please · pi/login · 5m ago (2)", "/e"],
    ["Named session · pi/login · 2h ago", "/b"],
    ["Fix the login flow please · proj--login · 3d ago", "/c"],
  ]);
  assert.equal(sessionDirFor("/agent/sessions/--r-main--", "/r/main", "/w/x"), "/agent/sessions/--w-x--");
  assert.equal(sessionDirFor("/custom", "/r/main", "/w/x"), "/custom");
  assert.deepEqual(repositorySessionDirs("/agent/sessions/--r-main--", ["/r/main", "/w/x"]), ["/agent/sessions/--r-main--", "/agent/sessions/--w-x--"]);
  assert.deepEqual(repositorySessionDirs("/agent/sessions/--r-main--", ["/r/main", "/w/x", "/r/main"]).length, 2);
  assert.deepEqual(repositorySessionDirs("/custom", ["/r/main", "/w/x"]), ["/custom"]);
});

test("relocation rewrites only the header and keeps the file in the main checkout's folder", async (t) => {
  const dir = await temporary(t);
  assert.equal(sessionBucket("/Users/me/src/proj"), "--Users-me-src-proj--");
  const sessions = join(dir, "sessions");
  const from = join(sessions, sessionBucket("/r/main"), "s.jsonl");
  assert.equal(sessionFileFor(from, "/r/main", "/w/x"), join(sessions, sessionBucket("/w/x"), "s.jsonl"));
  assert.equal(sessionFileFor(join(dir, "flat", "s.jsonl"), "/r/main", "/w/x"), join(dir, "flat", "s.jsonl"));

  const header = { type: "session", version: 3, id: "id1", timestamp: "t", cwd: "/r/main" };
  const body = '{"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"hi"}}\n';
  await mkdir(join(sessions, sessionBucket("/r/main")), { recursive: true });
  await writeFile(from, `${JSON.stringify(header)}\n${body}`);
  const saved = { getSessionFile: () => from, getHeader: () => header, getEntries: () => [] };
  const moved = await relocate(saved, "/w/x", "/r/main");
  assert.equal(moved.file, from, "pi --resume in the main checkout still lists it");
  assert.equal(await readFile(from, "utf8"), `${JSON.stringify({ ...header, cwd: "/w/x" })}\n${body}`);
  await moved.undo();
  assert.equal(await readFile(from, "utf8"), `${JSON.stringify(header)}\n${body}`);

  // A file left in a worktree's folder by an earlier move returns to the main checkout's.
  const legacy = join(sessions, sessionBucket("/w/x"), "l.jsonl");
  await mkdir(join(sessions, sessionBucket("/w/x")), { recursive: true });
  await writeFile(legacy, `${JSON.stringify({ ...header, cwd: "/w/x" })}\n${body}`);
  const returned = await relocate({ ...saved, getSessionFile: () => legacy }, "/r/main", "/r/main");
  assert.equal(returned.file, join(sessions, sessionBucket("/r/main"), "l.jsonl"));
  assert.ok(!existsSync(legacy));
  assert.equal(await readFile(returned.file, "utf8"), `${JSON.stringify(header)}\n${body}`);
  await returned.undo();
  assert.ok(!existsSync(returned.file));
  assert.ok(existsSync(legacy));

  // An unsaved session (no reply yet) is written from memory under a custom session directory.
  const flat = join(dir, "flat", "u.jsonl");
  const unsaved = { getSessionFile: () => flat, getHeader: () => header, getEntries: () => [{ type: "model_change", id: "m" }] };
  const written = await relocate(unsaved, "/w/y", "/r/main");
  assert.equal(written.file, flat);
  assert.deepEqual((await readFile(flat, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [{ ...header, cwd: "/w/y" }, { type: "model_change", id: "m" }]);
  await written.undo();
  assert.ok(!existsSync(flat));
  await assert.rejects(relocate({ ...saved, getSessionFile: () => undefined }, "/w", "/r/main"), /no file/);
});

test("Pi moves a session into a worktree, renames its branch and returns", async (t) => {
  if (spawnSync("pi", ["--version"]).error) { t.skip("Pi is not installed"); return; }
  const { dir, main, wt } = await repo(t);
  const agentDir = join(dir, "agent");
  const pi = (cwd: string, ...args: string[]) => {
    const result = spawnSync("pi", ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
      "-e", join(root, "extensions/worktree/index.ts"), "-e", join(root, "tests/fixtures/worktree-provider.ts"),
      "--provider", "worktree-smoke", "--model", "worktree-smoke/fixture", ...args],
    { cwd, encoding: "utf8", timeout: 60_000, env: { ...env, PI_CODING_AGENT_DIR: agentDir, PI_WORKTREE_DIR: wt, PI_REX_CHILD: "", PI_WORKFLOW_CHILD_CONFIG: "" } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const sessionsIn = (cwd: string) => { try { return readdirSync(join(agentDir, "sessions", sessionBucket(cwd))); } catch { return []; } };
  const header = (name: string) => JSON.parse(readFileSync(join(agentDir, "sessions", sessionBucket(main), name), "utf8").split("\n")[0]);
  const sessionFor = (cwd: string) => sessionsIn(main).map(header).find((entry) => entry.cwd === cwd)?.id as string;

  await writeFile(join(main, ".gitignore"), ".env\n");
  await writeFile(join(main, ".worktreeinclude"), ".env\n");
  await writeFile(join(main, ".env"), "TOKEN=local\n");
  sh(main, "add", ".gitignore", ".worktreeinclude"); sh(main, "commit", "-qm", "chore: setup files");

  // The scripted model calls enter_worktree, then writes a relative path after the move.
  assert.match(pi(main, "-p", "Start the worktree fixture"), /Worktree fixture done after toolResult/);
  const path = join(wt, "proj--fixture-task");
  assert.equal(readFileSync(join(path, ".env"), "utf8"), "TOKEN=local\n");
  assert.equal(readFileSync(join(path, "made.txt"), "utf8"), "from the worktree\n");
  assert.ok(!existsSync(join(main, "made.txt")));
  assert.equal(sh(path, "branch", "--show-current"), "pi/fixture-task");
  assert.deepEqual([sessionsIn(main).length, sessionsIn(path).length], [1, 0], "the session file stays where pi --resume in the main checkout lists it");
  const file = join(agentDir, "sessions", sessionBucket(main), sessionsIn(main)[0]);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].cwd, path);
  assert.equal(lines.filter((entry) => entry.type === "session").length, 1);
  assert.match(lines.find((entry) => entry.customType === "worktree")?.content ?? "", /Copied 1 file\(s\) listed in \.worktreeinclude\./);

  // Opening it by ID from the main checkout runs it in the worktree; a title renames the branch.
  const id = lines[0].id;
  pi(main, "--session", id, "-p", "/fixture-name Polish the fixture flow");
  assert.equal(sh(path, "branch", "--show-current"), "pi/polish-fixture-flow");
  // `pi -c` runs it in the main checkout instead, and says so.
  assert.match(pi(main, "-c", "-p", "/wt"), /This session works in .*proj--fixture-task on pi\/polish-fixture-flow but is running in /);

  // Exiting with uncommitted work returns the session but keeps the worktree.
  pi(main, "--session", id, "-p", "/wt exit remove");
  assert.ok(existsSync(path));
  assert.deepEqual([sessionsIn(main).length, sessionsIn(path).length], [1, 0]);
  assert.equal(JSON.parse(readFileSync(join(agentDir, "sessions", sessionBucket(main), sessionsIn(main)[0]), "utf8").split("\n")[0]).cwd, main);

  // An edit batched with the move is blocked, and the move still happens.
  pi(main, "-p", "Start the batched fixture");
  const batched = join(wt, "proj--batched");
  assert.ok(!existsSync(join(main, "early.txt")));
  assert.ok(existsSync(join(batched, "made.txt")));

  // The main checkout lists sessions in other worktrees, including files an earlier
  // version moved into a worktree's folder; the returned one is not among them.
  const old = join(agentDir, "sessions", sessionBucket(batched), "old.jsonl");
  await mkdir(join(old, ".."), { recursive: true });
  await writeFile(old, [{ type: "session", version: 3, id: "01a1c407-0000-7000-8000-000000000001", timestamp: new Date().toISOString(), cwd: batched },
    { type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "Older worktree session", timestamp: Date.now() } }]
    .map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const listed = pi(main, "-p", "/wt resume");
  assert.match(listed, /Start the batched fixture · pi\/batched · \d+m ago/);
  assert.match(listed, /Older worktree session · pi\/batched/);
  assert.doesNotMatch(listed, /Polish/);

  // Landing rebases onto the moved-on main branch, fast-forwards it, and cleans up.
  sh(batched, "add", "."); sh(batched, "commit", "-qm", "feat: made");
  await writeFile(join(main, "b.txt"), "b\n");
  sh(main, "add", "b.txt"); sh(main, "commit", "-qm", "feat: b");
  pi(main, "--session", sessionFor(batched), "-p", "/wt land remove");
  const reports = sessionsIn(main).flatMap((name) => readFileSync(join(agentDir, "sessions", sessionBucket(main), name), "utf8").trim().split("\n"))
    .map((line) => JSON.parse(line)).filter((entry) => entry.customType === "worktree").map((entry) => entry.content);
  assert.ok(reports.some((text) => /^Landed 1 commit\(s\) from pi\/batched on main after rebasing\. Session returned to the main checkout .*\. Removed .* and pi\/batched\.$/.test(text)), reports.join("\n"));
  assert.ok(reports.some((text) => /Session returned to the main checkout .*\. Kept .*proj--fixture-task: it has uncommitted changes\.$/.test(text)), reports.join("\n"));
  assert.deepEqual(sh(main, "log", "--format=%s").split("\n"), ["feat: made", "feat: b", "chore: setup files", "chore: init"]);
  assert.ok(!existsSync(batched));
  assert.equal(sh(main, "branch", "--list", "pi/batched"), "");
});
