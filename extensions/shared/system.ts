// Plain Node helpers shared by the extensions. Like context.ts, which says
// why, this folder has no index.ts.
import { randomUUID } from "node:crypto";
import { accessSync, constants, renameSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

// Unique, so two writes of one file at once, even by one process, never share it.
const temporary = (file: string) => `${file}.${randomUUID()}.tmp`;

/**
 * Replaces `file` in one step, so a reader never sees half of it: the text goes
 * to a private (0600) temporary file beside it, which is renamed over it and
 * removed if that fails. The folder must exist.
 */
export async function atomicWrite(file: string, text: string): Promise<void> {
  const temp = temporary(file);
  try {
    await writeFile(temp, text, { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** `atomicWrite` for callers that cannot wait, such as a handler that runs as Pi quits. */
export function atomicWriteSync(file: string, text: string): void {
  const temp = temporary(file);
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Whether a process with this PID exists; one that may not be signalled (EPERM) does. */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === "EPERM"; }
}

/** Resolves a program on PATH to an absolute path, as needed to start it without a shell. */
export function which(name: string, path = process.env.PATH ?? ""): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  return undefined;
}
