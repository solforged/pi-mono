// Guest-side scripts and output parsing for the file tools. Each tool call is
// one `container exec` where possible; parsing stays here so it is testable.
import { basename, posix } from "node:path";

// Prints a NUL-separated record stream: D, F, or M for the path itself, then
// for directories one record per entry: find's %Y type letter and the name.
export const LS_SCRIPT = `p=$1
if [ -d "$p" ]; then printf 'D\\0'; find "$p" -mindepth 1 -maxdepth 1 -printf '%Y%f\\0'
elif [ -e "$p" ]; then printf 'F\\0'
else printf 'M\\0'; fi`;

export interface Listing { kind: "dir" | "file" | "missing"; entries: Map<string, boolean> }
export function parseListing(output: Buffer): Listing {
  const parts = output.toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  const [head, ...records] = parts;
  const kind = head === "D" ? "dir" : head === "F" ? "file" : "missing";
  const entries = new Map<string, boolean>();
  for (const record of records) if (record) entries.set(record.slice(1), record[0] === "d");
  return { kind, entries };
}

// Prints D, F, or M on the first line, then runs ripgrep with the remaining
// arguments. A directory is searched as "." from inside it, as Pi does: a glob
// with a slash is matched against the path from there.
export const GREP_SCRIPT = `p=$1; shift
if [ -d "$p" ]; then echo D; cd -- "$p" || exit 2; set -- "$@" .
elif [ -e "$p" ]; then echo F; set -- "$@" "$p"
else echo M; exit 0; fi
exec rg "$@"`;

export interface GrepParams { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }
/** ripgrep's arguments up to the pattern; GREP_SCRIPT adds the path. */
export function rgArgs(params: GrepParams): string[] {
  const args = ["--no-config", "--json", "--line-number", "--color=never", "--hidden"];
  if (params.ignoreCase) args.push("--ignore-case");
  if (params.literal) args.push("--fixed-strings");
  if (params.glob) args.push("--glob", params.glob.replace(/^(!?)(?:\.\/)+/, "$1"));
  if (params.context && params.context > 0) args.push("--context", String(Math.floor(params.context)));
  args.push("--", params.pattern);
  return args;
}

interface GrepLine { match: boolean; path: string; line: number; text: string }
// Collects ripgrep JSON events. At the limit it keeps trailing context lines,
// then asks the caller to stop at the next non-context event.
export class GrepCollector {
  readonly lines: GrepLine[] = [];
  matches = 0;
  limitReached = false;
  readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  push(raw: string): boolean {
    if (!raw.trim()) return true;
    let event: any;
    try { event = JSON.parse(raw); } catch { return true; }
    const type = event?.type;
    if (this.limitReached && type !== "context") return false;
    if (type !== "match" && type !== "context") return true;
    const data = event.data ?? {};
    const path = data.path?.text ?? (data.path?.bytes ? Buffer.from(data.path.bytes, "base64").toString("utf8") : undefined);
    const text = data.lines?.text ?? (data.lines?.bytes ? Buffer.from(data.lines.bytes, "base64").toString("utf8") : "");
    if (typeof path !== "string" || typeof data.line_number !== "number") return true;
    this.lines.push({ match: type === "match", path, line: data.line_number, text });
    if (type === "match" && ++this.matches >= this.limit) this.limitReached = true;
    return true;
  }
  format(searchPath: string, isDirectory: boolean, truncate: (line: string) => { text: string; wasTruncated: boolean }) {
    let linesTruncated = false;
    const output = this.lines.map(({ match, path, line, text }) => {
      // Paths come back relative to the searched directory ("./src/a.ts").
      const relative = isDirectory ? posix.relative(searchPath, posix.resolve(searchPath, path)) : "";
      const shown = relative && !relative.startsWith("..") ? relative : basename(path);
      const cleaned = text.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
      const result = truncate(cleaned);
      if (result.wasTruncated) linesTruncated = true;
      return match ? `${shown}:${line}: ${result.text}` : `${shown}-${line}- ${result.text}`;
    });
    return { output, linesTruncated };
  }
}

export function fdArgs(pattern: string, searchPath: string, limit: number, ignore: string[] = []): string[] {
  const args = ["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", String(limit)];
  for (const glob of ignore) {
    const name = /^\*\*\/([^/*]+)\/\*\*$/.exec(glob)?.[1];
    if (name) args.push("--exclude", name);
  }
  let effective = pattern;
  if (pattern.includes("/")) {
    args.push("--full-path");
    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") effective = `**/${pattern}`;
  }
  args.push("--", effective, searchPath);
  return args;
}

// Turns a guest command's stderr into a Node-style error for Pi's tools.
export function guestError(stderr: string, path: string, operation: string) {
  const text = stderr.trim();
  const code = /No such file or directory/i.test(text) ? "ENOENT"
    : /Is a directory/i.test(text) ? "EISDIR"
    : /Permission denied/i.test(text) ? "EACCES"
    : /Read-only file system/i.test(text) ? "EROFS"
    : /Not a directory/i.test(text) ? "ENOTDIR" : undefined;
  const message = code === "ENOENT" ? `ENOENT: no such file or directory, ${operation} '${path}'`
    : code === "EROFS" ? `EROFS: read-only in the sandbox, ${operation} '${path}'`
    : `${code ?? "EIO"}: ${text || "sandbox command failed"}, ${operation} '${path}'`;
  return Object.assign(new Error(message), { code: code ?? "EIO", path });
}

// Allows the per-command values Pi sets for shell commands; never the host environment.
export function commandEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["PI_SESSION_ID", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
    const value = env?.[key];
    if (typeof value === "string" && value) result[key] = value;
  }
  return result;
}

export function sniffImage(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/**
 * pi.events channel for a long-lived guest process (the workflowz kernel).
 * The sandbox sets `answer`: the command line and a `stop` that ends the
 * process in the guest, undefined while the sandbox is off, or a rejection
 * when it is on but unavailable.
 */
export const GUEST_COMMAND = "sandbox:guest-command";
/** pi.events channel announcing `{ enabled }` whenever the sandbox is turned on or off. */
export const SANDBOX_CHANGED = "sandbox:changed";
export interface GuestCommandRequest { argv: string[]; cwd?: string; answer?: Promise<{ command: string; args: string[]; stop?: () => void } | undefined> }
