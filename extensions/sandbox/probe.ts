// Gathers host facts for the plan: the worktree root, its Git common
// directory, identity for guest Git, and read-only context directories.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findLayout, hostGit } from "./hostgit.ts";
import type { ContextView, Probe } from "./plan.ts";

// Git is asked only for the identity. The repository itself is found by
// reading the directory, which cannot run anything the guest left there.
const git = (cwd: string, args: string[]) => new Promise<string | undefined>((resolve) => {
  const call = hostGit(cwd, args);
  execFile("git", ["-C", cwd, ...call.args], { timeout: 10000, env: call.env }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
});
const real = (path: string | undefined) => {
  if (!path || !existsSync(path)) return undefined;
  try { return realpathSync(path); } catch { return undefined; }
};
export const kind = (path: string) => {
  try { const s = statSync(path); return s.isDirectory() ? "dir" as const : s.isFile() ? "file" as const : undefined; } catch { return undefined; }
};

const readText = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

const subdirs = (path: string) => {
  try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name)).sort(); } catch { return []; }
};

const COPY_LIMIT = 1024 * 1024;
/** What `dir` holds, with links resolved. Entries that lead nowhere, and files too large to be worth copying, are left out. */
function entriesOf(dir: string, keep: (name: string, kind: "file" | "dir") => boolean = () => true): ContextView["entries"] {
  const entries: ContextView["entries"] = [];
  let names: string[] = [];
  try { names = readdirSync(dir).sort(); } catch {}
  for (const name of names) {
    const source = real(join(dir, name));
    const found = source && kind(source);
    if (!source || !found || !keep(name, found)) continue;
    if (found === "file" && statSync(source).size > COPY_LIMIT) continue;
    entries.push({ name, source, kind: found });
  }
  return entries;
}
const isLink = (path: string) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };

/**
 * How one context folder reaches the guest: as it is (`dir`), or entry by
 * entry (`view`) when it or something in it is a link, since Pi names skills
 * by the linked path and the guest cannot follow a link out of its mounts.
 */
export function contextOf(path: string): { dir?: string; view?: ContextView } {
  if (kind(path) !== "dir") return {};
  let names: string[] = [];
  try { names = readdirSync(path); } catch {}
  if (!isLink(path) && !names.some((name) => isLink(join(path, name)))) return { dir: real(path) };
  return { view: { target: path, entries: entriesOf(path) } };
}

/**
 * The user's Git folder holds the ignore and attributes files guest Git reads,
 * and notes such as a commit style. Only its files are shown, and never
 * `credentials`, where Git's store helper keeps passwords.
 */
export const gitContext = (path: string): ContextView | undefined => kind(path) === "dir"
  ? { target: path, entries: entriesOf(path, (name, found) => found === "file" && !/^credentials/.test(name)) } : undefined;

export function cacheRoot(env = process.env) {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-sandbox");
}

// The Git top level of the working directory, or the directory itself.
export async function findRoot(cwd: string) {
  const start = real(cwd) ?? cwd;
  return real(findLayout(start)?.workTree) ?? start;
}

/** The Git directory shared by every checkout of the repository at `root`, if it is one. */
export const commonDirOf = async (root: string) => real(findLayout(root)?.commonDir);

export async function probe(cwd: string, agentDir: string, packageDir: string, env = process.env): Promise<Probe> {
  const home = real(homedir()) ?? homedir();
  const root = await findRoot(cwd);
  const commonDir = await commonDirOf(root);
  const [name, email] = await Promise.all([git(root, ["config", "user.name"]), git(root, ["config", "user.email"])]);
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const context = [join(home, ".agents", "skills"), join(agentDir, "skills"), packageDir].map(contextOf);
  const contextDirs = context.map((c) => c.dir).filter((dir): dir is string => !!dir);
  const contextViews = [...context.map((c) => c.view), gitContext(join(configHome, "git"))].filter((view): view is ContextView => !!view);
  return {
    root, home, cacheRoot: cacheRoot(env), commonDir, contextDirs, contextViews,
    worktreeConfig: !!commonDir && /^\s*worktreeconfig\s*(=\s*(true|yes|on|1))?\s*$/im.test(readText(join(commonDir, "config"))),
    worktreeGitDirs: commonDir ? subdirs(join(commonDir, "worktrees")) : [],
    wikiDir: env.LLM_WIKI_DIR ? real(env.LLM_WIKI_DIR) : undefined,
    identity: { name, email }, kind,
  };
}
