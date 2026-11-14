// jj helpers for the worktree extension: a colocated jj repository gets jj
// workspaces, each with its own Git worktree, instead of branches. See
// docs/worktree.md.
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { jjRefusal, trustedLayout } from "../sandbox/hostgit.ts";
import { exists, git, slugify, trustMise, worktreeRoot, type Checkout, type Created, type Landed, type Run, type Worktree } from "./git.ts";

const isDir = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** The nearest jj workspace root at or above `cwd`, found by reading the folder. */
export function jjRoot(cwd: string): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (isDir(join(dir, ".jj"))) return canonical(dir);
    if (dir === dirname(dir)) return undefined;
  }
}

/**
 * Runs jj in the colocated workspace that holds `cwd`, named with -R so jj
 * does not search: the one Git's pinned layout points at while the sandbox
 * is on. It refuses where jj would take config from the working tree or act
 * on another Git repository (see `jjRefusal`).
 */
export const jj: Run = (args, cwd) => new Promise((done, fail) => {
  const layout = trustedLayout(cwd);
  if (!layout?.jj) return fail(new Error(`${cwd} is not in a colocated jj workspace`));
  const refusal = jjRefusal(layout);
  if (refusal) return fail(new Error(refusal));
  execFile("jj", ["--no-pager", "--color=never", "-R", layout.workTree, ...args], { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => error ? fail(new Error((stderr || error.message).trim())) : done(stdout.replace(/\n+$/, "")));
});

const lines = (text: string) => text.split("\n").filter(Boolean);
// A quoted name is a revset symbol whatever it contains.
const symbol = (name: string) => JSON.stringify(name);
const at = (workspace: string) => `${symbol(workspace)}@`;
const count = async (revset: string, cwd: string, run: Run) => lines(await run(["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\n"'], cwd)).length;
// Ownership is kept in the colocated Git config, as for Git branches.
const OWNER = (workspace: string) => `piWorkspace.${workspace}.session`;

/** Every workspace of the repository, the main one, which holds the repository, first. */
export async function workspaces(cwd: string, run = jj): Promise<Worktree[]> {
  const out = await run(["--ignore-working-copy", "workspace", "list", "-T", 'name ++ "\\t" ++ root ++ "\\n"'], cwd);
  const all = lines(out).map((line) => { const [branch, path] = line.split("\t"); return { path, branch, bare: false }; });
  const main = (tree: Worktree) => isDir(join(tree.path, ".jj", "repo"));
  return [...all.filter(main), ...all.filter((tree) => !main(tree))];
}

/** The Git checkout as a jj one: its workspace name stands in for the branch. */
export async function inspectJj(checkout: Checkout, run = jj): Promise<Checkout> {
  const top = canonical(checkout.top);
  const here = (await workspaces(top, run)).find((tree) => canonical(tree.path) === top);
  return { ...checkout, vcs: "jj", branch: here?.branch };
}

/** Whether the working-copy commit of the workspace at `cwd` has changes; this snapshots it. */
export const dirtyJj = async (cwd: string, run = jj) => await run(["log", "--no-graph", "-r", "@", "-T", 'if(empty, "", "dirty")'], cwd) !== "";

/** Adds `<root>/<repo>--<slug>` as workspace `pi/<slug>` beside the main workspace's @, owned by `sessionId`. */
export async function createJj(from: Checkout, slug: string, sessionId: string, options: { root?: string; run?: Run; vcs?: Run; trust?: (path: string) => Promise<unknown> } = {}): Promise<Created> {
  const run = options.run ?? git, vcs = options.vcs ?? jj;
  const root = options.root ?? worktreeRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const taken = new Set((await workspaces(from.top, vcs)).map((tree) => tree.branch));
  let path = "", name = "";
  for (let n = 1; ; n++) {
    const suffix = n > 1 ? `-${n}` : "";
    path = join(root, `${from.repo}--${slug}${suffix}`);
    name = `pi/${slug}${suffix}`;
    if (!await exists(path) && !taken.has(name)) break;
  }
  const dirty = await dirtyJj(from.top, vcs);
  // Its working-copy commit starts on the parents of the main workspace's, as a worktree starts from HEAD.
  await vcs(["workspace", "add", "--name", name, "--colocate", path], from.top);
  await run(["config", "--local", OWNER(name), sessionId], path);
  await (options.trust ?? trustMise)(path).catch(() => undefined);
  return { path: await realpath(path), branch: name, dirty };
}

/** Whether workspace `name` was created for `sessionId`. */
export async function ownedJj(name: string | undefined, sessionId: string, cwd: string, run = git) {
  if (!name?.startsWith("pi/")) return false;
  return await run(["config", "--get", OWNER(name)], cwd).catch(() => "") === sessionId;
}

/** Renames an owned workspace to follow the session title; returns the new name if renamed. */
export async function followTitleJj(checkout: Checkout, sessionId: string, title: string, run = git, vcs = jj): Promise<string | undefined> {
  const slug = slugify(title);
  const name = checkout.branch;
  if (!slug || !name || !await ownedJj(name, sessionId, checkout.top, run)) return undefined;
  if (new RegExp(`^pi/${slug}(-\\d+)?$`).test(name)) return undefined;
  const taken = new Set((await workspaces(checkout.top, vcs)).map((tree) => tree.branch));
  let next = "";
  for (let n = 1; ; n++) { next = `pi/${slug}${n > 1 ? `-${n}` : ""}`; if (!taken.has(next)) break; }
  await vcs(["workspace", "rename", next], checkout.top);
  await run(["config", "--local", OWNER(next), sessionId], checkout.top);
  await run(["config", "--local", "--remove-section", `piWorkspace.${name}`], checkout.top).catch(() => undefined);
  return next;
}

/**
 * Lands a workspace's work on the bookmark at the main workspace's @-: its
 * @ when that is described, as with `jj describe`, else its @- when @ is
 * empty, as after `jj commit`. Rebases the work there when the bookmark has
 * moved on, moves the bookmark forward to it, starts a new empty @ on a
 * landed @, then moves the main workspace's @ onto the bookmark so its files
 * follow, as a fast-forward updates the main checkout's. A rebase that fails
 * or leaves conflicts is undone with `jj op restore`.
 */
export async function landJj(checkout: Checkout, run = jj): Promise<Landed> {
  const { top, main, branch } = checkout;
  if (!checkout.linked || !branch) throw new Error("Land from a jj workspace other than the main one");
  const home = (await workspaces(top, run))[0];
  if (!home || canonical(home.path) !== canonical(main)) throw new Error(`Could not find the main workspace at ${main}`);
  const marks = [...new Set(lines(await run(["log", "--no-graph", "-r", `${at(home.branch!)}-`, "-T", 'local_bookmarks.map(|b| b.name() ++ "\\n").join("")'], top)))];
  if (marks.length !== 1) throw new Error(marks.length
    ? `The main workspace's @- carries ${marks.join(", ")}; leave one bookmark there to land on`
    : `The main workspace's @- has no bookmark to land on; set one there with jj bookmark set, or move the main workspace onto one`);
  const [target] = marks;
  const state = await run(["log", "--no-graph", "-r", "@", "-T", 'if(empty, "empty", if(description, "described", "bare"))'], top);
  if (state === "bare") throw new Error("@ has changes but no description; describe it with jj describe, commit it with jj commit, or discard it with jj restore");
  const tip = state === "described" ? "@" : "@-";
  const onto = symbol(target);
  const commits = await count(`${onto}..${tip}`, top, run);
  if (!commits) throw new Error(`${branch} has no commits that ${target} lacks`);
  const behind = await count(`${tip}..${onto}`, top, run);
  const operation = (cwd: string) => run(["--ignore-working-copy", "op", "log", "-n1", "--no-graph", "-T", "id"], cwd);
  if (behind) {
    if (await count(`(${onto}..${tip}) & ::remote_bookmarks()`, top, run)) throw new Error(`${branch} has pushed commits and ${target} has moved on; rebase it yourself, then land`);
    const before = await operation(top);
    const undo = () => run(["op", "restore", before], top).catch(() => undefined);
    try { await run(["rebase", "-b", "@", "-d", onto], top); }
    catch (error) { await undo(); throw new Error(`Rebasing ${branch} onto ${target} failed: ${(error as Error).message}`); }
    if (await count(`(${onto}..@) & conflicts()`, top, run)) {
      await undo();
      throw new Error(`Rebasing ${branch} onto ${target} conflicts. Run jj rebase -b @ -d ${target} in ${top}, resolve it, then land again`);
    }
  }
  await run(["bookmark", "set", target, "-r", tip], top);
  // Later edits would otherwise amend the landed commit.
  if (tip === "@") await run(["new"], top);
  // Run in the main workspace, so jj updates its files too.
  const landed = await operation(main);
  let note: string | undefined;
  const kept = `The main workspace stays on the old ${target}; run jj rebase -s @ -d ${target} there`;
  try {
    await run(["rebase", "-s", "@", "-d", onto], main);
    if (await count("@ & conflicts()", main, run)) { await run(["op", "restore", landed], main); note = `${kept} once its changes are ready to meet the landed ones.`; }
  } catch (error) {
    await run(["op", "restore", landed], main).catch(() => undefined);
    note = `${kept}: ${(error as Error).message}`;
  }
  return { target, commits, rebased: behind > 0, note };
}

/**
 * Removes a workspace whose @ is empty, with its Git worktree and folder.
 * Its commits stay in the repository, visible in jj log until abandoned.
 */
export async function removeJj(path: string, name: string | undefined, main: string, run = git, vcs = jj): Promise<string> {
  if (await dirtyJj(path, vcs)) return `Kept ${path}: it has uncommitted changes.`;
  const all = await workspaces(main, vcs);
  name ??= all.find((tree) => canonical(tree.path) === canonical(path))?.branch;
  if (!name) throw new Error(`${path} is not a workspace of ${main}`);
  const home = all[0]?.branch ?? "default";
  const unlanded = await count(`${at(home)}..${at(name)}-`, main, vcs).catch(() => 0);
  await vcs(["workspace", "remove", name], main);
  await run(["config", "--local", "--remove-section", `piWorkspace.${name}`], main).catch(() => undefined);
  return unlanded
    ? `Removed ${path}; its ${unlanded} commit(s) that the main workspace lacks stay in jj log.`
    : `Removed ${path} and workspace ${name}.`;
}
