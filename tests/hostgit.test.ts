import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { findLayout, hostGit, jjRefusal, NO_REPOSITORY, pinLayout, submoduleNames, trustedLayout } from "../extensions/sandbox/hostgit.ts";
import { temporary } from "./helpers.ts";

const base = {
  PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const raw = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: base, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** One Git call as the extensions make it. */
const safe = (cwd: string, args: string[], env: NodeJS.ProcessEnv = base) => {
  const call = hostGit(cwd, args, env);
  return execFileSync("git", call.args, { cwd, env: call.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};

/** A repository with one commit, and a program that records being run, as a guest would plant one. */
async function fixture(t: TestContext) {
  const dir = realpathSync(await temporary(t));
  const repo = join(dir, "repo"), marker = join(dir, "ran"), trap = join(dir, "trap.sh");
  writeFileSync(trap, `#!/bin/sh\necho ran >> ${marker}\n`);
  chmodSync(trap, 0o755);
  mkdirSync(join(repo, "sub"), { recursive: true });
  raw(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  raw(repo, "add", ".");
  raw(repo, "commit", "-qm", "init");
  const sprung = () => { const ran = existsSync(marker); rmSync(marker, { force: true }); return ran; };
  return { dir, repo, trap, sprung };
}

test("the repository is found from the directory, and a commondir file never decides", async (t) => {
  const { dir, repo } = await fixture(t);
  const main = { workTree: repo, gitDir: join(repo, ".git"), commonDir: join(repo, ".git") };
  assert.deepEqual(findLayout(repo), main);
  assert.deepEqual(findLayout(join(repo, "sub")), main);
  assert.equal(findLayout(dir), undefined);
  // Like Git, a `.git` directory with no repository in it is passed over.
  mkdirSync(join(repo, "sub", ".git"));
  assert.deepEqual(findLayout(join(repo, "sub")), main);
  writeFileSync(join(repo, ".git", "commondir"), `${dir}/elsewhere\n`);
  assert.deepEqual(findLayout(repo), main);
  rmSync(join(repo, ".git", "commondir"));

  const linked = join(dir, "linked");
  raw(repo, "worktree", "add", "-q", linked, "-b", "task");
  const gitDir = join(repo, ".git", "worktrees", "linked");
  assert.deepEqual(findLayout(linked), { workTree: linked, gitDir, commonDir: join(repo, ".git") });
  writeFileSync(join(gitDir, "commondir"), `${dir}/elsewhere\n`);
  assert.equal(findLayout(linked)?.commonDir, join(repo, ".git"));
  // A Git directory kept elsewhere, as a submodule's is, is its own common directory.
  const apart = join(dir, "apart");
  raw(dir, "init", "-q", "--separate-git-dir", join(dir, "apart.git"), apart);
  assert.deepEqual(findLayout(apart), { workTree: apart, gitDir: join(dir, "apart.git"), commonDir: join(dir, "apart.git") });
  writeFileSync(join(apart, ".git"), "gitdir: /nonexistent\n");
  assert.equal(findLayout(apart), undefined);
});

test("a planted commondir does not redirect host Git to the guest's config", async (t) => {
  const { dir, repo, trap, sprung } = await fixture(t);
  // The guest's copy of the common directory: its own config, everything else the real thing.
  const evil = join(dir, "evil");
  mkdirSync(evil);
  writeFileSync(join(evil, "config"), `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${trap}\n`);
  for (const name of ["objects", "refs", "HEAD", "info"]) symlinkSync(join(repo, ".git", name), join(evil, name));
  writeFileSync(join(repo, ".git", "commondir"), `${evil}\n`);
  raw(repo, "status", "--porcelain");
  if (!sprung()) { t.skip("this Git does not run core.fsmonitor from a redirected config"); return; }

  writeFileSync(join(repo, "b.txt"), "b\n");
  assert.equal(safe(repo, ["status", "--porcelain"]), "?? b.txt\n");
  assert.equal(safe(join(repo, "sub"), ["rev-parse", "--show-toplevel"]).trim(), repo);
  safe(repo, ["add", "b.txt"]);
  safe(repo, ["commit", "-qm", "added b"]);
  assert.equal(safe(repo, ["log", "-1", "--format=%s"]).trim(), "added b");
  assert.equal(sprung(), false);
});

test("host Git does not run inside a planted submodule", async (t) => {
  const { repo, trap, sprung } = await fixture(t);
  const nested = join(repo, "nested");
  mkdirSync(nested);
  raw(nested, "init", "-q");
  writeFileSync(join(nested, "n.txt"), "n\n");
  raw(nested, "add", ".");
  raw(nested, "commit", "-qm", "n");
  raw(nested, "config", "core.fsmonitor", trap);
  raw(repo, "add", "nested");
  writeFileSync(join(nested, "n.txt"), "changed\n");
  sprung();
  raw(repo, "status", "--porcelain");
  if (!sprung()) { t.skip("this Git does not inspect submodules by running Git in them"); return; }
  // A .gitmodules entry outranks the config that says to stay out; the entry is the guest's to write.
  writeFileSync(join(repo, ".gitmodules"), '[submodule "odd \\"name\\""]\n\tpath = nested\n\turl = ./nested\n\tignore = none\n');
  raw(repo, "status", "--porcelain");
  assert.equal(sprung(), true);

  assert.match(safe(repo, ["--no-optional-locks", "status", "--porcelain=v2", "--branch"]), /^1 A\. S\S* .* nested$/m);
  safe(repo, ["-c", "core.quotePath=false", "diff", "HEAD"]);
  safe(repo, ["diff", "--numstat", "HEAD", "--", "nested"]);
  // Commands with no option for it rely on the config passed in the environment.
  writeFileSync(join(repo, "a.txt"), "edited\n");
  safe(repo, ["stash", "-q"]);
  safe(repo, ["stash", "pop", "-q"]);
  // `add` heeds neither, so a submodule is staged by its commit alone, and files by name.
  safe(repo, ["update-index", "--add", "--remove", "--", "nested"]);
  safe(repo, ["add", "-A", "--", "a.txt", ".gitmodules"]);
  safe(repo, ["commit", "-qm", "with nested"]);
  assert.equal(safe(repo, ["status", "--porcelain"]), "");
  assert.equal(sprung(), false);
});

test("calls say where the repository is, keep out of submodules, and add to config already in the environment", async (t) => {
  const { repo } = await fixture(t);
  writeFileSync(join(repo, ".gitmodules"), '[submodule "a"]\n\tpath = a\n [ submodule "b.c" ]\n[Submodule "a"]\n[core]\n');
  assert.deepEqual(submoduleNames('[submodule "x \\"y\\" \\\\z"]\n[submodule]\n[submodule "ok"] ; note\n'), ['x "y" \\z', "ok"]);
  const call = hostGit(join(repo, "sub"), ["-c", "core.quotePath=false", "-C", repo, "--no-optional-locks", "diff", "--stat", "HEAD"], { ...base, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "kept" });
  assert.deepEqual(call.args, ["-c", "core.quotePath=false", "-C", repo, "--no-optional-locks", "diff", "--ignore-submodules=dirty", "--stat", "HEAD"]);
  assert.deepEqual([call.env.GIT_DIR, call.env.GIT_WORK_TREE, call.env.GIT_COMMON_DIR], [join(repo, ".git"), repo, join(repo, ".git")]);
  const config = Array.from({ length: Number(call.env.GIT_CONFIG_COUNT) }, (_, i) => `${call.env[`GIT_CONFIG_KEY_${i}`]}=${call.env[`GIT_CONFIG_VALUE_${i}`]}`);
  assert.deepEqual(config, ["user.name=kept", "diff.ignoreSubmodules=dirty", "status.submoduleSummary=false", "submodule.recurse=false", "fetch.recurseSubmodules=false", "submodule.a.ignore=dirty", "submodule.b.c.ignore=dirty"]);
  // Only commands that look into submodules take the option.
  for (const args of [["status"], ["diff-index", "HEAD"], ["diff-files"]]) assert.equal(hostGit(repo, args, base).args[1], "--ignore-submodules=dirty");
  for (const args of [["commit", "-F", "-"], ["rev-parse", "status"], ["log", "--", "diff"], []]) assert.deepEqual(hostGit(repo, args, base).args, args);
  assert.equal(base.PATH, process.env.PATH, "the caller's environment is left alone");
});

test("while the sandbox is on, host Git keeps to the repository found first", async (t) => {
  const { dir, repo, trap, sprung } = await fixture(t);
  const on = { ...base, PI_SANDBOX: "on" };
  const sub = join(repo, "sub");
  assert.equal(pinLayout(sub)?.workTree, repo);
  // The guest makes a repository of its own nearer the working directory.
  raw(sub, "init", "-q");
  raw(sub, "config", "core.fsmonitor", trap);
  writeFileSync(join(sub, "s.txt"), "s\n");
  raw(sub, "add", ".");
  sprung();
  raw(sub, "status", "--porcelain");
  if (!sprung()) { t.skip("this Git does not run core.fsmonitor"); return; }
  assert.equal(trustedLayout(sub, on)?.workTree, repo);
  assert.equal(safe(sub, ["rev-parse", "--show-toplevel"], on).trim(), repo);
  safe(sub, ["status", "--porcelain"], on);
  assert.equal(sprung(), false);
  // With the sandbox off the model has the host anyway, and Git finds what is there.
  assert.equal(trustedLayout(sub, base)?.workTree, sub);

  // A directory with no repository at the start gets none later.
  const empty = join(dir, "empty");
  mkdirSync(empty);
  assert.equal(pinLayout(empty), undefined);
  raw(empty, "init", "-q");
  assert.equal(trustedLayout(empty, on), undefined);
  assert.equal(hostGit(empty, ["status"], on).env.GIT_DIR, NO_REPOSITORY);
  assert.throws(() => safe(empty, ["status"], on), /not a git repository/);
  assert.equal(safe(empty, ["rev-parse", "--is-inside-work-tree"]).trim(), "true");
});

test("a colocated jj workspace is part of the layout, pinned like the rest", async (t) => {
  const { repo } = await fixture(t);
  const on = { ...base, PI_SANDBOX: "on" };
  assert.equal(pinLayout(repo)?.jj, undefined);
  // The guest makes a jj repository after the sandbox started.
  mkdirSync(join(repo, ".jj", "repo", "store"), { recursive: true });
  writeFileSync(join(repo, ".jj", "repo", "store", "git_target"), "../../../.git");
  assert.equal(trustedLayout(repo, on)?.jj, undefined);
  const layout = findLayout(repo)!;
  assert.equal(layout.jj, join(repo, ".jj", "repo"));
  assert.equal(jjRefusal(layout), undefined);
  // jj would adopt a config.toml as the repository's config where there is no config-id.
  writeFileSync(join(repo, ".jj", "repo", "config.toml"), "[ui]\npager = \"/tmp/x\"\n");
  assert.match(jjRefusal(layout)!, /would adopt .*config\.toml/);
  writeFileSync(join(repo, ".jj", "repo", "config-id"), "0123456789abcdef0123");
  assert.equal(jjRefusal(layout), undefined);
  // Its Git target must be this checkout's repository.
  writeFileSync(join(repo, ".jj", "repo", "store", "git_target"), "/elsewhere/.git");
  assert.match(jjRefusal(layout)!, /not backed by this checkout's Git repository/);
});
