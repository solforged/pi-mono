import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

// Bytes alone decide: a long listing of short lines costs less inline than its
// receipt plus the reads that recover it.
export const MAX_INLINE_BYTES = 8192;
export const MAX_EXCERPT_BYTES = 6000;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const TOOLS = new Set(["bash", "powershell", "grep", "find", "ls", "web_search", "codemode"]);
const DIAGNOSTIC = /\b(error|fail(?:ed|ure)?|warning|exception|traceback|assert(?:ion)?|fatal|panic)\b/i;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface Result {
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  content: Content[];
  details?: unknown;
  structuredContent?: unknown;
  isError: boolean;
}

// Buffer truncation must not introduce a replacement character in Unicode text.
export function headBytes(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let end = Math.max(0, max);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
function tailBytes(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let start = Math.max(0, bytes.length - max);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

export function preview(text: string): string {
  const lines = text.split("\n");
  const head = headBytes(lines.slice(0, 20).join("\n"), 1500);
  const tail = tailBytes(lines.slice(-30).join("\n"), 3000);
  const diagnostics: string[] = [];
  let bytes = 0;
  for (let i = 20; i < lines.length - 30 && diagnostics.length < 15; i++) {
    if (!DIAGNOSTIC.test(lines[i])) continue;
    const line = headBytes(`L${i + 1}: ${lines[i]}`, Math.min(500, 1000 - bytes));
    if (!line) break;
    diagnostics.push(line);
    bytes += Buffer.byteLength(line) + 1;
  }
  return ["[Start excerpt; may end mid-line]", head,
    ...(diagnostics.length ? ["[Selected diagnostic lines; not exhaustive]", diagnostics.join("\n")] : []),
    "[End excerpt; may start mid-line]", tail].join("\n");
}

export class ArtifactStore {
  readonly root: string;
  constructor(root: string) { this.root = root; }

  private async directory(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error("Artifact directory must not be a symlink");
    // Resolving parents also supports macOS's conventional /var and /tmp links.
    const root = await realpath(this.root);
    await chmod(root, 0o700);
    return root;
  }

  async save(text: string): Promise<{ id: string; path: string }> {
    if (Buffer.byteLength(text) > MAX_ARTIFACT_BYTES) throw new Error("Tool output exceeds the 16 MiB artifact limit");
    const root = await this.directory();
    const id = randomUUID();
    const path = join(root, `${id}.txt`);
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(text, "utf8"); }
    catch (error) { await unlink(path).catch(() => {}); throw error; }
    finally { await file.close(); }
    return { id, path };
  }

  async read(id: string): Promise<string> {
    if (!ID.test(id)) throw new Error("Expected an artifact UUID, not a file path");
    const path = resolve(await this.directory(), `${id}.txt`);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) throw new Error("Invalid artifact file");
      return await file.readFile("utf8");
    } finally { await file.close(); }
  }
}

export interface ReadOptions { offset?: number; limit?: number; query?: string; column?: number }
function fromColumn(text: string, column: number): string {
  let index = 0;
  let skipped = 0;
  for (const char of text) {
    if (skipped >= column - 1) break;
    index += char.length;
    skipped++;
  }
  return text.slice(index);
}
export function readExcerpt(text: string, options: ReadOptions = {}): string {
  const offset = options.offset ?? 1;
  // Asking for more than a page returns one page and its continuation offset; refusing cost a turn each time.
  const limit = Math.min(options.limit ?? 40, 80);
  if (!Number.isSafeInteger(offset) || offset < 1) throw new Error("offset must be a positive line number");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be between 1 and 80 lines");
  if (options.query !== undefined && (!options.query || options.query.length > 500)) throw new Error("query must be 1–500 characters");
  const column = options.column ?? 1;
  if (!Number.isSafeInteger(column) || column < 1) throw new Error("column must be a positive character number");
  const lines = text.split("\n");
  let output = `Artifact: ${lines.length} lines, ${Buffer.byteLength(text)} bytes.\n`;
  let count = 0;
  let stopped = 0;
  for (let i = offset - 1; i < lines.length; i++) {
    if (options.query !== undefined && !lines[i].includes(options.query)) continue;
    if (count === limit) { stopped = i + 1; break; }
    const prefix = `L${i + 1}${count === 0 && column > 1 ? ` (column ${column})` : ""}: `;
    const source = count === 0 ? fromColumn(lines[i], column) : lines[i];
    const line = `${prefix}${source}\n`;
    // Reserve space for a continuation notice; never silently skip a long line.
    const available = MAX_EXCERPT_BYTES - Buffer.byteLength(output) - 300;
    if (Buffer.byteLength(line) > available) {
      if (count === 0) {
        const clipped = headBytes(source, Math.max(0, available - Buffer.byteLength(prefix)));
        const nextColumn = column + Array.from(clipped).length;
        output += `${prefix}${clipped}\n[Line clipped: continue with offset=${i + 1}, column=${nextColumn}${options.query === undefined ? "" : " and the same query"}.]\n`;
        return output;
      }
      stopped = i + 1;
      break;
    }
    output += line;
    count++;
  }
  if (stopped && stopped <= lines.length) output += `[More available: continue with offset=${stopped}${options.query === undefined ? "" : " and the same query"}.]\n`;
  else if (!count && !stopped) output += "[No matching lines in this range.]\n";
  return output;
}

export async function archiveResult(event: Result, store: ArtifactStore) {
  // Scripts need original structured values to compute their own filtered result.
  // Failed calls and explicit reads retain their complete evidence by default.
  if (event.parentToolCallId || event.isError || !TOOLS.has(event.toolName)) return;
  const text = event.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
  const bytes = Buffer.byteLength(text);
  const lines = text.split("\n").length;
  if (bytes <= MAX_INLINE_BYTES) return;
  // Persist before returning a replacement. A failed save must never lose evidence.
  const artifact = await store.save(text);
  const excerpt = preview(text);
  const receipt = `[Output archived: ${event.toolName}, ${bytes} bytes, ${lines} lines. Excerpts below are incomplete, not a summary.\nArtifact: ${artifact.id}\nUse artifact_read({id: "${artifact.id}", offset: 1, limit: 40}) or add a literal query to locate omitted evidence.\nSaved delivered text: ${artifact.path}; upstream tool truncation still applies.]`;
  let inserted = false;
  const content = event.content.flatMap((block): Content[] => {
    if (block.type !== "text") return [block];
    if (inserted) return [];
    inserted = true;
    return [{ type: "text", text: `${receipt}\n\n${excerpt}` }];
  });
  return {
    content,
    // Do not copy raw output into details or structuredContent and thus back into history.
    // Built-in details (exit status, upstream truncation paths) remain intact.
    details: event.details,
    artifact: { ...artifact, originalBytes: bytes, returnedBytes: Buffer.byteLength(`${receipt}\n\n${excerpt}`) },
  };
}
