import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { atomicWrite as write } from "../shared/system.ts";

export function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
export async function scopeRoot(agentDir: string, profile: string, cwd: string): Promise<string> {
  return join(agentDir, "workflow-state", profile, hash(await realpath(cwd)).slice(0, 20));
}
export async function privateDir(dir: string): Promise<void> { await mkdir(dir, { recursive: true, mode: 0o700 }); }
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error: any) { if (error.code === "ENOENT") return fallback; throw error; }
}
// Exported only for extensions/rex and its fixtures, which count on the folder
// being made; new code imports atomicWrite from ../shared/system.ts.
export async function atomicWrite(file: string, content: string): Promise<void> {
  await privateDir(dirname(file));
  await write(file, content);
}
export async function saveJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

const isAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === "EPERM"; }
};
const olderThan = (path: string, ms: number) => lstat(path).then((s) => Date.now() - s.mtimeMs > ms);
// A lock is stale when its recorded owner has exited, or when it never recorded one.
// A lock that is already gone needs no removal.
async function isStale(lock: string, alive: (pid: number) => boolean): Promise<boolean> {
  const pid = await readJson<{ pid?: unknown }>(join(lock, "owner.json"), {}).then((owner) => owner.pid, () => undefined);
  if (typeof pid === "number") return !alive(pid);
  return await olderThan(lock, 10000).catch(() => false);
}
// Only one process at a time may judge a lock stale and remove it. Two doing so
// together could each delete the lock the other had just retaken, and both would run.
async function clearStale(lock: string, alive: (pid: number) => boolean): Promise<void> {
  const gate = `${lock}.takeover`;
  try { await mkdir(gate, { mode: 0o700 }); }
  catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    // A gate outlives its holder only after a crash between two file operations.
    if (await olderThan(gate, 10000).catch(() => false)) await rmdir(gate).catch(() => {});
    return;
  }
  try { if (await isStale(lock, alive)) await rm(lock, { recursive: true, force: true }); }
  finally { await rmdir(gate).catch(() => {}); }
}

// Refuse concurrent reviewers/publishers instead of risking lost updates. A
// lock left by a killed process is taken over.
export async function withLock<T>(root: string, name: string, fn: () => Promise<T>, alive = isAlive): Promise<T> {
  await privateDir(root);
  const lock = join(root, `${name}.lock`);
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      if (attempt > 0) throw new Error(`Workflow is locked: ${lock}. Another Pi process holds it; remove it only if none is running.`);
      await clearStale(lock, alive);
    }
  }
  try {
    await saveJson(join(lock, "owner.json"), { pid: process.pid, started: new Date().toISOString() });
    return await fn();
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export function skillName(name: unknown): string {
  if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error("Skill names must be lowercase words separated by hyphens (at most 64 characters)");
  }
  return name;
}
export function skillPath(root: string, name: string): string { return join(root, "skills", skillName(name), "SKILL.md"); }

// Check each component below the scope root before a host-side publication. The
// path to the root is the user's own layout (a linked ~/.pi, /tmp on macOS).
export async function rejectSymlinks(root: string, file: string): Promise<void> {
  const below = relative(root, file);
  if (isAbsolute(below) || below.split(sep)[0] === "..") throw new Error(`Managed path is outside its root: ${file}`);
  let current = root;
  for (const part of below.split(sep)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing symlink in managed path: ${current}`); }
    catch (error: any) { if (error.code === "ENOENT") return; throw error; }
  }
}
export async function readSkill(root: string, name: string): Promise<string | null> {
  const file = skillPath(root, name);
  await rejectSymlinks(root, file);
  try { return await readFile(file, "utf8"); }
  catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}
