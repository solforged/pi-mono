// Finds image file paths in prompt text and turns them into attachments.
// Pure apart from the loader the caller passes in, so it can be tested
// without Pi.
import { open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export interface Candidate {
  start: number; // Offsets of the whole token in the text, quotes included.
  end: number;
  path: string;  // Absolute path with escapes, quotes and file:// removed.
}

export interface Loaded { data: string; mimeType: string }

export const limits = { images: 8, bytes: 20 * 1024 * 1024 };

// Nerd Font image icon, one column wide like the status line's icons. The 🖼
// emoji is one column to Pi but two on screen, so it ran into the label.
export const imageIcon = "\uF03E";

const imageExtension = /\.(png|jpe?g|gif|webp)$/i;
// Escaped spaces are part of a path; macOS screenshot names also contain
// U+202F, which is not a separator here.
const separator = (char: string | undefined) => char === " " || char === "\t" || char === "\n" || char === "\r";
const trailing = /[.,;:!?)\]}>]$/;

// Pi saves a clipboard image as $TMPDIR/pi-clipboard-<uuid>.<ext> and puts
// that path in the editor. The path means nothing to the model, so the
// attachment marker replaces it; other paths stay in the text.
export const isClipboardFile = (path: string) => /^pi-clipboard-[0-9a-f-]+\.\w+$/i.test(basename(path));

function absolute(path: string, home: string): string | undefined {
  if (path.startsWith("file://")) {
    try { path = fileURLToPath(path); } catch { return undefined; }
  }
  if (path.startsWith("~/")) path = home + path.slice(1);
  return path.startsWith("/") ? path : undefined;
}

// Image paths that stand on their own: absolute, ~/ or file:// paths ending in
// an image extension, at the start of the text or after whitespace, either
// quoted or with backslash-escaped spaces, as terminals paste dropped files.
export function candidates(text: string, home = homedir()): Candidate[] {
  const found: Candidate[] = [];
  let i = 0;
  while (i < text.length) {
    if (i > 0 && !separator(text[i - 1])) { i++; continue; }
    const quote = text[i] === "'" || text[i] === '"' ? text[i] : undefined;
    if (quote) {
      const close = text.indexOf(quote, i + 1);
      const inner = close > i ? text.slice(i + 1, close) : "";
      const path = !inner.includes("\n") && imageExtension.test(inner) ? absolute(inner, home) : undefined;
      if (path) { found.push({ start: i, end: close + 1, path }); i = close + 1; continue; }
      i++; continue;
    }
    if (text[i] !== "/" && !text.startsWith("~/", i) && !text.startsWith("file:///", i)) { i++; continue; }
    let raw = "", end = i;
    const stops: Array<{ raw: string; end: number }> = [];
    while (end < text.length && !separator(text[end])) {
      if (text[end] === "\\" && end + 1 < text.length && text[end + 1] !== "\n") { raw += text[end + 1]; end += 2; }
      else raw += text[end++];
      stops.push({ raw, end });
    }
    // Trailing punctuation belongs to the sentence, not the file name.
    let stop = stops.at(-1);
    while (stop && !imageExtension.test(stop.raw) && trailing.test(stop.raw)) {
      stops.pop();
      stop = stops.at(-1);
    }
    const path = stop && imageExtension.test(stop.raw) ? absolute(stop.raw, home) : undefined;
    if (path && stop) found.push({ start: i, end: stop.end, path });
    i = Math.max(end, i + 1);
  }
  return found;
}

export function sniff(bytes: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

// Cheap check for the editor preview: a regular file whose header is an image.
export async function probe(path: string): Promise<{ mimeType: string; size: number } | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > limits.bytes) return undefined;
    const file = await open(path, "r");
    try {
      const head = new Uint8Array(12);
      const { bytesRead } = await file.read(head, 0, 12, 0);
      const mimeType = sniff(head.subarray(0, bytesRead));
      return mimeType ? { mimeType, size: info.size } : undefined;
    } finally { await file.close(); }
  } catch { return undefined; }
}

export async function load(path: string): Promise<Loaded | undefined> {
  if (!await probe(path)) return undefined;
  try {
    const bytes = await readFile(path);
    const mimeType = sniff(bytes);
    return mimeType ? { data: Buffer.from(bytes).toString("base64"), mimeType } : undefined;
  } catch { return undefined; }
}

// Attaches every image path that loads, numbered after the images the prompt
// already has. Clipboard files become `[Image #N]`; other paths keep their text
// and gain the marker. Returns undefined when nothing was attached.
export async function attach(
  text: string,
  existing: number,
  loader: (path: string) => Promise<Loaded | undefined> = load,
  home = homedir(),
): Promise<{ text: string; images: Loaded[] } | undefined> {
  const numbers = new Map<string, number>();
  const images: Loaded[] = [];
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  for (const candidate of candidates(text, home)) {
    let n = numbers.get(candidate.path);
    if (n === undefined) {
      if (images.length >= limits.images) continue;
      const image = await loader(candidate.path);
      if (!image) continue;
      images.push(image);
      n = existing + images.length;
      numbers.set(candidate.path, n);
    }
    const marker = `[Image #${n}]`;
    const original = text.slice(candidate.start, candidate.end);
    edits.push({ ...candidate, replacement: isClipboardFile(candidate.path) ? marker : `${original} ${marker}` });
  }
  if (!images.length) return undefined;
  let out = text;
  for (const edit of edits.reverse()) out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  return { text: out, images };
}

// Transcript display for prompts sent before this extension: a bare clipboard
// path becomes a short link to the file.
export function shortenClipboardPaths(markdown: string): string {
  return markdown.replace(/(^|[\s(])((?:\/[^\s/]+)*\/(pi-clipboard-[0-9a-f-]+\.\w+))(?=$|[\s).,;:!?])/gim,
    (_match, before: string, path: string) => `${before}[${imageIcon} pasted image](file://${encodeURI(path)})`);
}
