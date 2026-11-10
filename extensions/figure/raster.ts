// Rasterizes prepared SVG to PNG with macOS `sips`, which draws through
// CoreSVG: vector-sharp at any size, transparent, and about 20 ms a figure.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Raster = { data: string; width: number; height: number };

const cacheSize = 24;
const cache = new Map<string, Promise<Raster>>();
let dir: Promise<string> | undefined;

export const supported = process.platform === "darwin";

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer) {
  if (png.length < 24 || png.toString("latin1", 12, 16) !== "IHDR") return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function sips(args: string[], signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/sips", args, { timeout: 15_000, signal }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const detail = String(stderr).split("\n").map((line) => line.trim())
        .filter((line) => /parser error|error :|Error:/i.test(line) && !/CORESVG_VERBOSE|Error 13/.test(line));
      reject(new Error(detail.length ? `CoreSVG could not draw the SVG: ${[...new Set(detail)].slice(0, 3).join("; ")}` : `sips failed: ${error.message}`));
    });
  });
}

async function draw(svg: string, signal?: AbortSignal): Promise<Raster> {
  dir ??= mkdtemp(join(tmpdir(), "pi-figure-"));
  const base = join(await dir, createHash("sha1").update(svg).digest("hex"));
  try {
    await writeFile(`${base}.svg`, svg);
    await sips(["-s", "format", "png", `${base}.svg`, "--out", `${base}.png`], signal);
    const png = await readFile(`${base}.png`);
    const size = pngSize(png);
    if (!size) throw new Error("sips produced no PNG");
    return { data: png.toString("base64"), ...size };
  } finally {
    await Promise.all([rm(`${base}.svg`, { force: true }), rm(`${base}.png`, { force: true })]);
  }
}

/** PNG of `svg` at its root's width and height in pixels; recent results are cached. */
export function rasterize(svg: string, signal?: AbortSignal): Promise<Raster> {
  if (!supported) return Promise.reject(new Error("Figures need macOS: they are drawn with sips and CoreSVG."));
  const key = svg;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const job = draw(svg, signal);
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
  return job;
}

export async function cleanup() {
  const current = dir;
  dir = undefined;
  cache.clear();
  if (current) await rm(await current, { recursive: true, force: true });
}
