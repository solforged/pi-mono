import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
export async function scopeRoot(agentDir: string, profile: string, cwd: string): Promise<string> {
  return join(agentDir, "workflow-state", profile, hash(await realpath(cwd)).slice(0, 20));
}
export async function privateDir(dir: string): Promise<void> { await mkdir(dir, { recursive: true, mode: 0o700 }); }
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error: any) { if (error.code === "ENOENT") return fallback; throw error; }
}
export async function atomicWrite(file: string, content: string): Promise<void> {
  await privateDir(dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
export async function saveJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Refuse concurrent reviewers/publishers instead of risking lost updates.
export async function withLock<T>(root: string, name: string, fn: () => Promise<T>): Promise<T> {
  await privateDir(root);
  const lock = join(root, `${name}.lock`);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Workflow is locked: ${lock}. Remove only after confirming no review/publish is running.`);
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

// Check each component, including existing parents, before a host-side publication.
export async function rejectSymlinks(file: string): Promise<void> {
  const parts = resolve(file).split("/").filter(Boolean);
  let current = "/";
  for (const part of parts) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing symlink in managed path: ${current}`); }
    catch (error: any) { if (error.code === "ENOENT") return; throw error; }
  }
}
export async function readSkill(root: string, name: string): Promise<string | null> {
  const file = skillPath(root, name);
  await rejectSymlinks(file);
  try { return await readFile(file, "utf8"); }
  catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}
