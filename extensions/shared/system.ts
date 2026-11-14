// Plain Node helpers shared by the extensions. Like context.ts, which says
// why, this folder has no index.ts.
import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";

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
