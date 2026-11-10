// Gathers host facts for the plan: the worktree root, its Git common
// directory, identity for guest Git, and read-only context directories.
import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Probe } from "./plan.ts";

const git = (cwd: string, args: string[]) => new Promise<string | undefined>((resolve) => {
  execFile("git", ["-C", cwd, ...args], { timeout: 10000 }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
});
const real = (path: string | undefined) => {
  if (!path || !existsSync(path)) return undefined;
  try { return realpathSync(path); } catch { return undefined; }
};
export const kind = (path: string) => {
  try { const s = statSync(path); return s.isDirectory() ? "dir" as const : s.isFile() ? "file" as const : undefined; } catch { return undefined; }
};

export function cacheRoot(env = process.env) {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-sandbox");
}

// The Git top level of the working directory, or the directory itself.
export async function findRoot(cwd: string) {
  const start = real(cwd) ?? cwd;
  return real(await git(start, ["rev-parse", "--show-toplevel"])) ?? start;
}

export async function probe(cwd: string, agentDir: string, packageDir: string, env = process.env): Promise<Probe> {
  const home = real(homedir()) ?? homedir();
  const root = await findRoot(cwd);
  const commonDir = real(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const [name, email] = await Promise.all([git(root, ["config", "user.name"]), git(root, ["config", "user.email"])]);
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const contextDirs = [join(home, ".agents", "skills"), join(agentDir, "skills"), packageDir, join(configHome, "git")]
    .map(real).filter((dir): dir is string => !!dir && kind(dir) === "dir");
  return {
    root, home, cacheRoot: cacheRoot(env), commonDir, contextDirs,
    wikiDir: env.LLM_WIKI_DIR ? real(env.LLM_WIKI_DIR) : undefined,
    identity: { name, email }, kind,
  };
}
