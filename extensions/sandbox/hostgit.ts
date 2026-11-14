// Host-side Git in a repository that a sandbox guest can write to. Git takes
// its configuration, and the programs named there, from wherever the
// repository says, and a guest can say otherwise: a `commondir` file, a
// repository of its own nearer the working directory, or a submodule with its
// own config would all have the next host Git call run guest code. Calls
// prepared here name the repository themselves and stay out of submodules.
// Host jj in a colocated jj workspace is checked here too; see `jjRefusal`.
// No Pi imports: the diff viewer and the tests load it directly.
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface Layout {
  workTree: string; gitDir: string; commonDir: string;
  /** The jj repository folder when the work tree is also a jj workspace (colocated). */
  jj?: string;
}

const kind = (path: string) => {
  try { const s = statSync(path); return s.isDirectory() ? "dir" : s.isFile() ? "file" : undefined; } catch { return undefined; }
};
const present = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };
const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

/**
 * The repository Git would find from `cwd`, found without running Git or
 * reading its config. The common directory follows from where things are:
 * a `.git` directory is its own, and a linked worktree's is two levels above
 * `<common>/worktrees/<id>`. A `commondir` file never decides it.
 */
export function findLayout(cwd: string): Layout | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    const found = kind(dotGit);
    // Like Git, pass over a `.git` directory that holds no repository.
    if (found === "dir" && present(join(dotGit, "HEAD"))) return withJj({ workTree: dir, gitDir: dotGit, commonDir: dotGit });
    if (found === "file") {
      const target = /^gitdir: (.+)$/m.exec(read(dotGit))?.[1]?.trim();
      const gitDir = target ? resolve(dir, target) : undefined;
      if (!gitDir || !present(join(gitDir, "HEAD"))) return undefined;
      const linked = basename(dirname(gitDir)) === "worktrees" && present(join(gitDir, "commondir"));
      return withJj({ workTree: dir, gitDir, commonDir: linked ? dirname(dirname(gitDir)) : gitDir });
    }
    if (dir === dirname(dir)) return undefined;
  }
}

/**
 * The jj repository folder of the workspace at `workTree`: its `.jj/repo`
 * folder, or the one a secondary workspace's `.jj/repo` file names.
 */
export function jjRepository(workTree: string): string | undefined {
  const pointer = join(workTree, ".jj", "repo");
  const found = kind(pointer);
  const repo = found === "dir" ? pointer : found === "file" && read(pointer).trim() ? resolve(dirname(pointer), read(pointer).trim()) : undefined;
  return repo && kind(repo) === "dir" ? repo : undefined;
}
const withJj = (layout: Layout): Layout => {
  const jj = jjRepository(layout.workTree);
  return jj ? { ...layout, jj } : layout;
};

const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/**
 * Why host jj must not run in `layout`'s workspace, if it must not. jj keeps
 * a repository's config in the user's config folder, under the ID in the
 * repository's `config-id`, but where that file is missing it adopts the
 * repository's own `config.toml`, programs and all, the next time it runs:
 * a sandbox guest could write one. And jj follows `store/git_target` to the
 * Git repository it reads and writes, which must be this checkout's.
 */
export function jjRefusal(layout: Layout): string | undefined {
  const repo = layout.jj;
  if (!repo) return `${layout.workTree} is not a jj workspace`;
  if (present(join(repo, "config.toml")) && !present(join(repo, "config-id"))) {
    return `jj would adopt ${join(repo, "config.toml")} as this repository's config. Check it, then run jj there yourself`;
  }
  const target = read(join(repo, "store", "git_target")).trim();
  if (!target || canonical(resolve(repo, "store", target)) !== canonical(layout.commonDir)) {
    return `The jj repository ${repo} is not backed by this checkout's Git repository ${layout.commonDir}`;
  }
  return undefined;
}

// One per process, shared by every extension instance and kept across session switches.
const pinned: Map<string, Layout | null> = ((globalThis as { __piSolHostGit?: Map<string, Layout | null> }).__piSolHostGit ??= new Map());

/**
 * The repository of `cwd` as first seen by this process. While the sandbox is
 * on, later calls keep to it: a repository the guest creates or swaps in
 * afterwards is not used. The sandbox pins the session's directory before any
 * tool runs.
 */
export function pinLayout(cwd: string): Layout | undefined {
  const key = resolve(cwd);
  if (!pinned.has(key)) pinned.set(key, findLayout(key) ?? null);
  return pinned.get(key) ?? undefined;
}

export const sandboxOn = (env: NodeJS.ProcessEnv = process.env) => env.PI_SANDBOX === "on";

/** The repository host Git may use for `cwd`: the pinned one while the sandbox is on, else what is there now. */
export const trustedLayout = (cwd: string, env: NodeJS.ProcessEnv = process.env) => sandboxOn(env) ? pinLayout(cwd) : findLayout(cwd);

/** Names of the submodules a `.gitmodules` file declares. */
export function submoduleNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/^[ \t]*\[[ \t]*submodule[ \t]+"((?:[^"\\\n]|\\.)*)"[ \t]*\]/gim)) names.add(match[1].replace(/\\(.)/g, "$1"));
  return [...names].slice(0, 200);
}

// Commands that look inside submodules for changes, by running Git there under the submodule's own config.
const INSPECTS = new Set(["status", "diff", "diff-index", "diff-files"]);
const IGNORE = "dirty"; // Still reports a submodule whose commit changed, which needs no Git run inside it.
/** Where GIT_DIR points when the sandbox is on and `cwd` had no repository at the start. */
export const NO_REPOSITORY = "/dev/null/no-repository-when-the-sandbox-started";

function isolate(args: string[]): string[] {
  let at = 0;
  while (at < args.length && args[at].startsWith("-")) at += args[at] === "-c" || args[at] === "-C" ? 2 : 1;
  return INSPECTS.has(args[at] ?? "") ? [...args.slice(0, at + 1), `--ignore-submodules=${IGNORE}`, ...args.slice(at + 1)] : args;
}

/**
 * Arguments and environment for one host Git call made from `cwd`.
 *
 * - The repository is named in the environment, so Git neither searches for
 *   one nor follows a `commondir` file.
 * - `status` and `diff` are told not to run Git inside submodules. Config in
 *   the environment says the same to commands that heed it, such as `stash`,
 *   and to Git run by hooks; it names each `.gitmodules` entry, which could
 *   otherwise turn the inspection back on.
 * - `add` heeds neither. Given a submodule whose commit is unchanged, it runs
 *   Git inside to look for edits, so never call it without paths, and stage a
 *   submodule with `update-index --add --remove`, which reads its commit only.
 */
export function hostGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): { args: string[]; env: NodeJS.ProcessEnv } {
  const next = { ...env };
  const layout = trustedLayout(cwd, env);
  if (layout) Object.assign(next, { GIT_DIR: layout.gitDir, GIT_WORK_TREE: layout.workTree, GIT_COMMON_DIR: layout.commonDir });
  else if (sandboxOn(env)) next.GIT_DIR = NO_REPOSITORY;
  const config: Array<[string, string]> = [
    ["diff.ignoreSubmodules", IGNORE], ["status.submoduleSummary", "false"],
    ["submodule.recurse", "false"], ["fetch.recurseSubmodules", "false"],
    ...(layout ? submoduleNames(read(join(layout.workTree, ".gitmodules"))) : []).map((name): [string, string] => [`submodule.${name}.ignore`, IGNORE]),
  ];
  let count = Number(next.GIT_CONFIG_COUNT) || 0;
  for (const [key, value] of config) { next[`GIT_CONFIG_KEY_${count}`] = key; next[`GIT_CONFIG_VALUE_${count}`] = value; count++; }
  next.GIT_CONFIG_COUNT = String(count);
  return { args: isolate(args), env: next };
}
