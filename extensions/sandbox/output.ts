// Long bash output: Pi saves it to the host's temp folder and names that file
// in the result, where the guest's read and bash cannot reach it. No Pi
// imports, so tests load it directly.
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Moves a log Pi wrote to the host's temp folder into the folder mounted for
 * the guest, and returns its new path, which is the same on both sides.
 */
export async function shareOutput(file: string, dir: string): Promise<string> {
  const target = join(dir, basename(file));
  await mkdir(dir, { recursive: true });
  try { await rename(file, target); } catch (error: any) {
    if (error?.code !== "EXDEV") throw error;
    await copyFile(file, target);
    await rm(file, { force: true });
  }
  return target;
}

/** A tool result, or the error it threw, with every mention of one path replaced by another. */
export function repath<T>(value: T, from: string, to: string): T {
  if (typeof value === "string") return value.replaceAll(from, to) as T;
  if (value instanceof Error) { value.message = value.message.replaceAll(from, to); return value; }
  if (Array.isArray(value)) return value.map((item) => repath(item, from, to)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, repath(item, from, to)])) as T;
  return value;
}
