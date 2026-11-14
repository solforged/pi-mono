// Small PNG previews for the editor. A preview line is written to the
// terminal again whenever the lines above the editor move, so it carries a
// thumbnail rather than a full screenshot: just enough pixels to fill the
// cells it is shown in. macOS shrinks images with the built-in sips;
// elsewhere only small files are shown as they are.
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
export interface Box { widthPx: number; heightPx: number }

async function size(path: string): Promise<{ width?: number; height?: number }> {
  const { stdout } = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { timeout: 10_000 });
  const value = (key: string) => Number(new RegExp(`${key}: (\\d+)`).exec(stdout)?.[1]) || undefined;
  return { width: value("pixelWidth"), height: value("pixelHeight") };
}

/** The longer side, in pixels, of an image fitted inside `box` and never enlarged. */
export function longSide(image: { width?: number; height?: number }, box: Box) {
  const { width, height } = image;
  if (!width || !height) return Math.max(16, Math.round(Math.max(box.widthPx, box.heightPx)));
  const scale = Math.min(1, box.widthPx / width, box.heightPx / height);
  return Math.max(16, Math.round(Math.max(width, height) * scale));
}

export async function thumbnail(path: string, box: Box): Promise<Thumbnail | undefined> {
  const found = await probe(path);
  if (!found) return undefined;
  if (process.platform !== "darwin") {
    return found.size <= unshrunk ? { data: (await readFile(path)).toString("base64"), mimeType: found.mimeType } : undefined;
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-image-paste-"));
  try {
    const out = join(dir, "thumb.png");
    const original = await size(path);
    // -Z fits the longer side.
    await run("/usr/bin/sips", ["-s", "format", "png", "-Z", String(longSide(original, box)), path, "--out", out], { timeout: 10_000 });
    return { data: (await readFile(out)).toString("base64"), mimeType: "image/png", ...original };
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
