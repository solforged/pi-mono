// Copies local setup files into a new worktree, as Claude Code and Codex do:
// `.worktreeinclude` in the checkout root lists .gitignore-style patterns, and
// only untracked files that match one and are also ignored by Git are copied.
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git, inside } from "./git.ts";

export const INCLUDE_FILE = ".worktreeinclude";

/** The paths `.worktreeinclude` selects in `from`, relative to it. */
export async function included(from: string, run = git): Promise<string[]> {
  const spec = join(from, INCLUDE_FILE);
  if (!await lstat(spec).then((stat) => stat.isFile(), () => false)) return [];
  const matched = (await run(["ls-files", "-z", "--others", "--ignored", `--exclude-from=${spec}`], from)).split("\0").filter(Boolean);
  if (!matched.length) return [];
  // check-ignore exits 1 when none of the paths is ignored.
  const out = await run(["check-ignore", "-z", "--stdin"], from, matched.join("\0") + "\0").catch(() => "");
  return out.split("\0").filter(Boolean).sort();
}

/** Copies the selected files and symlinks into `to`, cloning where the filesystem allows; never overwrites. */
export async function copyIncluded(from: string, to: string, run = git): Promise<string[]> {
  const copied: string[] = [];
  for (const path of await included(from, run)) {
    const source = join(from, path), target = join(to, path);
    if (!inside(from, source) || !inside(to, target)) continue;
    const stat = await lstat(source).catch(() => undefined);
    if (!stat || !(stat.isFile() || stat.isSymbolicLink())) continue;
    await mkdir(dirname(target), { recursive: true });
    try {
      if (stat.isSymbolicLink()) await symlink(await readlink(source), target);
      else await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      copied.push(path);
    } catch (error: any) { if (error.code !== "EEXIST") throw error; }
  }
  return copied;
}
