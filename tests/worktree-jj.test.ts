import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { create, dirty, followTitle, inspect, land, remove, uncolocated, worktrees } from "../extensions/worktree/vcs.ts";
import { sessionBucket } from "../extensions/worktree/session.ts";
import { root, temporary } from "./helpers.ts";

// jj keeps repository and workspace config under the user's config folder, so the
// fixtures get their own; Git is isolated as in worktree.test.ts.
const config = mkdtempSync(join(tmpdir(), "pi-jj-config-"));
after(() => rmSync(config, { recursive: true, force: true }));
writeFileSync(join(config, "jj.toml"), '[user]\nname = "t"\nemail = "t@t"\n[ui]\nconflict-marker-style = "git"\n');
const env = Object.assign(process.env, {
  JJ_CONFIG: join(config, "jj.toml"), XDG_CONFIG_HOME: config,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
});
const missing = !!spawnSync("jj", ["--version"]).error;
const jj = (cwd: string, ...args: string[]) => execFileSync("jj", ["--no-pager", "--color=never", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const log = (cwd: string, revset: string, template = 'description.first_line() ++ "\\n"') => jj(cwd, "log", "--no-graph", "-r", revset, "-T", template);
const noTrust = async () => undefined;

async function repo(t: any) {
  const dir = await temporary(t);
  const main = join(dir, "proj");
  jj(dir, "git", "init", "--colocate", main);
  await writeFile(join(main, "a.txt"), "a\n");
  jj(main, "commit", "-m", "chore: init");
  jj(main, "bookmark", "create", "main", "-r", "@-");
  return { dir, main, wt: join(dir, "wt") };
}
const commit = async (cwd: string, file: string, text = `${file}\n`) => { await writeFile(join(cwd, file), text); jj(cwd, "commit", "-m", `feat: ${file}`); };

test("a colocated jj repository gets workspaces named pi/<slug> beside the main @", { skip: missing && "jj is not installed" }, async (t) => {
  const { dir, main, wt } = await repo(t);
  const checkout = (await inspect(main))!;
  assert.deepEqual([checkout.vcs, checkout.top, checkout.main, checkout.repo, checkout.linked, checkout.branch], ["jj", main, main, "proj", false, "default"]);

  await writeFile(join(main, "a.txt"), "changed\n");
  assert.equal(await dirty(checkout), true);
  const first = await create(checkout, "task", "s1", { root: wt, trust: noTrust });
  assert.deepEqual(first, { path: join(wt, "proj--task"), branch: "pi/task", dirty: true });
  assert.equal(readFileSync(join(first.path, "a.txt"), "utf8"), "a\n", "uncommitted changes stay behind");
  assert.ok(existsSync(join(first.path, ".git")), "the workspace is colocated");
  const second = await create(checkout, "task", "s2", { root: wt, trust: noTrust });
  assert.deepEqual([second.path, second.branch], [join(wt, "proj--task-2"), "pi/task-2"]);

  const linked = (await inspect(join(first.path)))!;
  assert.deepEqual([linked.vcs, linked.top, linked.main, linked.linked, linked.branch], ["jj", first.path, main, true, "pi/task"]);
  assert.equal(await dirty(linked), false);
  assert.deepEqual((await worktrees(linked)).map((tree) => [tree.path, tree.branch]), [[main, "default"], [first.path, "pi/task"], [second.path, "pi/task-2"]]);

  // Only the owner renames, and ownership follows the new name.
  assert.equal(await followTitle(linked, "s2", "Some title here"), undefined);
  assert.equal(await followTitle(linked, "s1", "Fix the login flow"), "pi/fix-login-flow");
  const renamed = (await inspect(first.path))!;
  assert.equal(renamed.branch, "pi/fix-login-flow");
  assert.equal(await followTitle(renamed, "s1", "Fix the login flow"), undefined);
  assert.equal(await followTitle(renamed, "s1", "Task 2"), "pi/task-2-2", "a taken name gets a suffix");

  // A jj repository that Git cannot see is refused with a hint.
  const plain = join(dir, "plain");
  jj(dir, "git", "init", "--no-colocate", plain);
  assert.equal(await inspect(plain), undefined);
  assert.match((await uncolocated(plain))!, /without its own Git checkout.*jj git colocation enable/);
  assert.equal(await uncolocated(main), undefined);
});

test("landing moves the main workspace's bookmark, rebasing when it moved on and undoing conflicts", { skip: missing && "jj is not installed" }, async (t) => {
  const { main, wt } = await repo(t);
  const made = await create((await inspect(main))!, "land", "s1", { root: wt, trust: noTrust });
  const at = async () => (await inspect(made.path))!;
  await assert.rejects(land(await at()), /no commits that main lacks/);
  await writeFile(join(made.path, "one.txt"), "one\n");
  await assert.rejects(land(await at()), /@ has changes but no description; describe it with jj describe/);
  jj(made.path, "commit", "-m", "feat: one.txt");

  // The bookmark to land on sits on the main workspace's @-.
  jj(main, "new", "main", "--quiet");
  jj(main, "new", "--quiet");
  await assert.rejects(land(await at()), /no bookmark to land on/);
  jj(main, "edit", "@-", "--quiet");
  assert.deepEqual(await land(await at()), { target: "main", commits: 1, rebased: false, note: undefined });
  assert.equal(log(main, "main"), "feat: one.txt");
  assert.equal(readFileSync(join(main, "one.txt"), "utf8"), "one\n", "the main workspace's files follow");

  // A conflicting rebase is undone, leaving both sides as they were.
  await commit(made.path, "a.txt", "workspace\n");
  await commit(main, "a.txt", "main\n");
  jj(main, "bookmark", "set", "main", "-r", "@-");
  const before = [log(made.path, "@-", "commit_id"), log(main, "main", "commit_id")];
  await assert.rejects(land(await at()), /conflicts\. Run jj rebase -b @ -d main/);
  assert.deepEqual([log(made.path, "@-", "commit_id"), log(main, "main", "commit_id")], before);
  assert.equal(log(made.path, "conflicts()"), "");

  // Without the conflict it rebases, then moves the bookmark forward: no merge commit.
  jj(made.path, "abandon", "@-", "--quiet");
  await commit(made.path, "two.txt");
  assert.deepEqual(await land(await at()), { target: "main", commits: 1, rebased: true, note: undefined });
  assert.deepEqual(log(main, "::main ~ root()").split("\n"), ["feat: two.txt", "feat: a.txt", "feat: one.txt", "chore: init"]);
  assert.equal(log(main, "merges()"), "");
  assert.ok(existsSync(join(main, "two.txt")));

  // A described @ lands itself, and later edits go to a new @ on top of it.
  await writeFile(join(made.path, "three.txt"), "three\n");
  jj(made.path, "describe", "-m", "feat: three.txt");
  await commit(main, "four.txt");
  jj(main, "bookmark", "set", "main", "-r", "@-");
  assert.deepEqual(await land(await at()), { target: "main", commits: 1, rebased: true, note: undefined });
  assert.equal(log(main, "main"), "feat: three.txt");
  assert.equal(log(made.path, "@-"), "feat: three.txt");
  assert.equal(log(made.path, "@", 'if(empty, "empty")'), "empty");
  assert.ok(existsSync(join(main, "three.txt")) && existsSync(join(made.path, "four.txt")));
});

test("removal keeps a workspace with changes and reports commits it leaves behind", { skip: missing && "jj is not installed" }, async (t) => {
  const { main, wt } = await repo(t);
  const checkout = (await inspect(main))!;
  const changed = await create(checkout, "dirty", "s1", { root: wt, trust: noTrust });
  await writeFile(join(changed.path, "new.txt"), "x\n");
  assert.match(await remove(checkout, changed.path, changed.branch, "s1"), /Kept .*uncommitted/);
  assert.ok(existsSync(changed.path));

  const clean = await create(checkout, "clean", "s1", { root: wt, trust: noTrust });
  assert.match(await remove(checkout, clean.path, clean.branch, "s1"), /^Removed .*proj--clean and workspace pi\/clean\.$/);
  assert.ok(!existsSync(clean.path));
  assert.ok(!jj(main, "workspace", "list").includes("pi/clean"));

  const ahead = await create(checkout, "ahead", "s1", { root: wt, trust: noTrust });
  await commit(ahead.path, "b.txt");
  assert.match(await remove(checkout, ahead.path, ahead.branch, "s1"), /its 1 commit\(s\) that the main workspace lacks stay in jj log/);
  assert.equal(log(main, 'description(exact:"feat: b.txt\n")'), "feat: b.txt");
});

test("Pi moves a session into a jj workspace and lands it", { skip: (missing && "jj is not installed") || (!!spawnSync("pi", ["--version"]).error && "Pi is not installed") }, async (t) => {
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
  const entries = () => readdirSync(join(agentDir, "sessions", sessionBucket(main)))
    .flatMap((name) => readFileSync(join(agentDir, "sessions", sessionBucket(main), name), "utf8").trim().split("\n")).map((line) => JSON.parse(line));

  assert.match(pi(main, "-p", "Start the worktree fixture"), /Worktree fixture done after toolResult/);
  const path = join(wt, "proj--fixture-task");
  assert.equal(readFileSync(join(path, "made.txt"), "utf8"), "from the worktree\n");
  assert.ok(!existsSync(join(main, "made.txt")));
  assert.match(jj(main, "workspace", "list"), /pi\/fixture-task/);
  const moved = entries().find((entry) => entry.customType === "worktree")?.content ?? "";
  assert.match(moved, /jj workspace pi\/fixture-task, created on the parent of @ .*commit or describe with jj; \/wt land lands @ once described/);
  const id = entries().find((entry) => entry.type === "session").id;
  assert.match(pi(main, "--session", id, "-p", "/wt"), /jj workspace pi\/fixture-task at .*proj--fixture-task; main workspace /);

  // The model commits; landing moves main, returns, and removes the workspace.
  jj(path, "commit", "-m", "feat: made");
  await commit(main, "b.txt");
  jj(main, "bookmark", "set", "main", "-r", "@-");
  pi(main, "--session", id, "-p", "/wt land remove");
  const reports = entries().filter((entry) => entry.customType === "worktree").map((entry) => entry.content);
  assert.ok(reports.some((text) => /^Landed 1 commit\(s\) from pi\/fixture-task on main after rebasing\. Session returned to the main checkout .*\. Removed .* and workspace pi\/fixture-task\.$/.test(text)), reports.join("\n"));
  assert.deepEqual(log(main, "::main ~ root()").split("\n"), ["feat: made", "feat: b.txt", "chore: init"]);
  assert.ok(!existsSync(path));
  assert.ok(existsSync(join(main, "made.txt")));
});
