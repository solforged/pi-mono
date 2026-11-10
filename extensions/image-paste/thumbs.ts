// Small PNG previews for the editor. A preview line is written to the
// terminal again whenever the lines above the editor move, so it carries a
// thumbnail rather than a full screenshot. macOS shrinks images with the
// built-in sips; elsewhere only small files are shown as they are.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { probe } from "./paths.ts";

const run = promisify(execFile);
const unshrunk = 1024 * 1024;

// width and height are the original image's, for the caption.
export interface Thumbnail { data: string; mimeType: string; width?: number; height?: number }

async function size(path: string): Promise<{ width?: number; height?: number }> {
  const { stdout } = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { timeout: 10_000 });
  const value = (key: string) => Number(new RegExp(`${key}: (\\d+)`).exec(stdout)?.[1]) || undefined;
  return { width: value("pixelWidth"), height: value("pixelHeight") };
}

export async function thumbnail(path: string, maxPx: number): Promise<Thumbnail | undefined> {
  const found = await probe(path);
  if (!found) return undefined;
  if (process.platform !== "darwin") {
    return found.size <= unshrunk ? { data: (await readFile(path)).toString("base64"), mimeType: found.mimeType } : undefined;
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-image-paste-"));
  try {
    const out = join(dir, "thumb.png");
    // -Z fits the longer side; it also enlarges, which is harmless at this size.
    const original = await size(path);
    await run("/usr/bin/sips", ["-s", "format", "png", "-Z", String(Math.max(16, Math.round(maxPx))), path, "--out", out], { timeout: 10_000 });
    return { data: (await readFile(out)).toString("base64"), mimeType: "image/png", ...original };
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
