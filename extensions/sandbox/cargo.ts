// Host bash in a linked Git worktree of a Rust repo builds into the main
// checkout's target/, so throwaway lanes do not each hold a multi-GB copy of
// every dependency. Reads .git files only; no process is spawned per command.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const read = (path: string) => { try { return readFileSync(path, "utf8").trim(); } catch { return undefined; } };

/** The main checkout's target/ when `cwd` is in a linked worktree whose root has a Cargo.toml. */
export function sharedTarget(cwd: string): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    let isFile: boolean | undefined;
    try { isFile = lstatSync(join(dir, ".git")).isFile(); } catch { /* keep walking up */ }
    if (isFile === false) return undefined; // A main checkout
    if (isFile) {
      const gitdir = read(join(dir, ".git"))?.match(/^gitdir: (.+)$/m)?.[1];
      const common = gitdir && read(join(resolve(dir, gitdir), "commondir"));
      // Submodules have a .git file but no commondir; bare repositories have no checkout target/.
      if (!common) return undefined;
      const commonDir = resolve(dir, gitdir, common);
      if (basename(commonDir) !== ".git" || !existsSync(join(dir, "Cargo.toml"))) return undefined;
      return join(dirname(commonDir), "target");
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Bash spawn hook: set CARGO_TARGET_DIR unless already set; a command can still export its own. */
export function shareCargoTarget<T extends { cwd: string; env?: NodeJS.ProcessEnv }>(spawn: T): T {
  const env = spawn.env ?? process.env;
  if (env.CARGO_TARGET_DIR) return spawn;
  const target = sharedTarget(spawn.cwd);
  return target ? { ...spawn, env: { ...env, CARGO_TARGET_DIR: target } } : spawn;
}
