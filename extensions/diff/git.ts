// Collects and parses Git diffs for the viewer. No Pi imports: the viewer runs
// as a plain Node process in its own Rex pane.
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { hostGit } from "../sandbox/hostgit.ts";

export type Source = "uncommitted" | "staged" | "branch";
export const SOURCES: Source[] = ["uncommitted", "staged", "branch"];
export type Status = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked";

export interface DiffLine { kind: " " | "+" | "-"; text: string; old?: number; new?: number }
export interface Hunk { oldStart: number; newStart: number; context: string; lines: DiffLine[] }
export interface FileDiff {
  path: string;
  oldPath?: string;
  status: Status;
  binary: boolean;
  /** Mode changes, similarity and other header facts worth showing. */
  notes: string[];
  added: number;
  removed: number;
  hunks: Hunk[];
}
export interface Snapshot { source: Source; label: string; files: FileDiff[] }

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_UNTRACKED = 300;
const MAX_UNTRACKED_BYTES = 512 * 1024;

export type Git = (args: string[]) => Promise<string>;

export function gitRunner(root: string): Git {
  return (args) => new Promise((resolve, reject) => {
    const call = hostGit(root, ["-c", "core.quotePath=false", ...args]);
    execFile("git", call.args, { cwd: root, maxBuffer: MAX_OUTPUT, encoding: "utf8", env: { ...call.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } },
      (error, stdout, stderr) => error ? reject(new Error(stderr.trim().split("\n")[0] || error.message)) : resolve(stdout));
  });
}

const DIFF_FLAGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", "-U3"];

const ok = (git: Git, args: string[]) => git(args).then((out) => out.trim(), () => undefined);

async function defaultBranch(git: Git): Promise<string | undefined> {
  const remote = await ok(git, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (remote) return remote;
  for (const name of ["main", "master", "origin/main", "origin/master"]) {
    if (await ok(git, ["rev-parse", "--verify", "-q", `${name}^{commit}`])) return name;
  }
  return undefined;
}

/** Diff for one source. Untracked files count as added in the working-tree sources. */
export async function collect(root: string, source: Source, git: Git = gitRunner(root)): Promise<Snapshot> {
  const head = await ok(git, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  let base = head ?? EMPTY_TREE;
  let label = "uncommitted";
  if (source === "branch") {
    const branch = await defaultBranch(git);
    const mergeBase = branch && head ? await ok(git, ["merge-base", "HEAD", branch]) : undefined;
    if (mergeBase) { base = mergeBase; label = `since ${branch}`; }
    else label = "uncommitted (no base branch)";
  }
  const staged = source === "staged";
  if (staged) label = "staged";
  const text = await git(staged ? [...DIFF_FLAGS, "--cached", "--"] : [...DIFF_FLAGS, base, "--"]);
  const files = parseDiff(text);
  if (!staged) {
    const listed = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const path of listed.slice(0, MAX_UNTRACKED)) files.push(await untracked(root, path));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { source, label, files };
}

async function untracked(root: string, path: string): Promise<FileDiff> {
  const file: FileDiff = { path, status: "untracked", binary: false, notes: [], added: 0, removed: 0, hunks: [] };
  let handle;
  try {
    handle = await open(join(root, path), "r");
    const info = await handle.stat();
    if (!info.isFile()) { file.notes.push("not a regular file"); return file; }
    const size = Math.min(info.size, MAX_UNTRACKED_BYTES);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    if (buffer.subarray(0, 8000).includes(0)) { file.binary = true; return file; }
    let text = buffer.toString("utf8");
    if (info.size > size) file.notes.push(`showing the first ${Math.round(size / 1024)} KB`);
    if (text.endsWith("\n")) text = text.slice(0, -1);
    const lines = text === "" ? [] : text.split("\n");
    if (lines.length) file.hunks.push({ oldStart: 0, newStart: 1, context: "", lines: lines.map((line, i) => ({ kind: "+", text: line.replace(/\r$/, ""), new: i + 1 })) });
    file.added = lines.length;
  } catch (error) {
    file.notes.push((error as Error).message);
  } finally {
    await handle?.close();
  }
  return file;
}

/** Undoes Git's C-style quoting of unusual paths ("a\tb", octal UTF-8 bytes). */
export function unquote(path: string): string {
  if (!path.startsWith("\"") || !path.endsWith("\"")) return path;
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, "\"": 34, "\\": 92 };
  const body = Buffer.from(path.slice(1, -1), "utf8");
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== 92) { bytes.push(body[i]); continue; }
    const next = String.fromCharCode(body[++i]);
    if (/[0-7]/.test(next)) { bytes.push(parseInt(body.subarray(i, i + 3).toString(), 8)); i += 2; }
    else bytes.push(simple[next] ?? body[i]);
  }
  return Buffer.from(bytes).toString("utf8");
}

const strip = (path: string, prefix: string) => {
  const value = unquote(path.trim());
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
};

/** Paths from "diff --git a/x b/y" when no ---/+++ lines name them (binary, mode-only, pure renames). */
function headerPaths(rest: string): [string, string] | undefined {
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|a\/\S*) ("(?:[^"\\]|\\.)*"|b\/.*)$/);
  if (quoted && (quoted[1].startsWith("\"") || quoted[2].startsWith("\""))) return [strip(quoted[1], "a/"), strip(quoted[2], "b/")];
  // Unquoted names may contain spaces; the two halves are equal unless renamed.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " " && rest.slice(2, half) === rest.slice(half + 3)) return [rest.slice(2, half), rest.slice(half + 3)];
  return undefined;
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldNo = 0, newNo = 0;
  let previousOld: string | undefined;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const paths = headerPaths(raw.slice(11));
      file = { path: paths?.[1] ?? raw.slice(11), oldPath: paths?.[0], status: "modified", binary: false, notes: [], added: 0, removed: 0, hunks: [] };
      files.push(file);
      hunk = undefined;
      previousOld = undefined;
      continue;
    }
    if (!file) continue;
    if (hunk) {
      const kind = raw[0];
      if (kind === "+" || kind === "-" || kind === " ") {
        const line: DiffLine = { kind, text: raw.slice(1).replace(/\r$/, "") };
        if (kind !== "+") line.old = oldNo++;
        if (kind !== "-") line.new = newNo++;
        if (kind === "+") file.added++;
        if (kind === "-") file.removed++;
        hunk.lines.push(line);
        continue;
      }
      if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    }
    const header = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
    if (header) {
      oldNo = Number(header[1]); newNo = Number(header[2]);
      hunk = { oldStart: oldNo, newStart: newNo, context: header[3], lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    hunk = undefined;
    if (raw.startsWith("--- ")) previousOld = raw === "--- /dev/null" ? undefined : strip(raw.slice(4), "a/");
    else if (raw.startsWith("+++ ")) {
      if (raw !== "+++ /dev/null") file.path = strip(raw.slice(4), "b/");
      else if (previousOld) file.path = previousOld;
    }
    else if (raw.startsWith("new file mode")) file.status = "added";
    else if (raw.startsWith("deleted file mode")) file.status = "deleted";
    else if (raw.startsWith("rename from ")) { file.status = "renamed"; file.oldPath = unquote(raw.slice(12)); }
    else if (raw.startsWith("rename to ")) file.path = unquote(raw.slice(10));
    else if (raw.startsWith("copy from ")) { file.status = "copied"; file.oldPath = unquote(raw.slice(10)); }
    else if (raw.startsWith("copy to ")) file.path = unquote(raw.slice(8));
    else if (raw.startsWith("old mode ")) file.notes.push(`mode ${raw.slice(9)}`);
    else if (raw.startsWith("new mode ")) file.notes[file.notes.length - 1] += ` → ${raw.slice(9)}`;
    else if (raw.startsWith("Binary files ") || raw === "GIT binary patch") file.binary = true;
  }
  for (const entry of files) if (entry.status !== "renamed" && entry.status !== "copied") delete entry.oldPath;
  return files;
}

/** Hunk bodies that are new or different since the previous snapshot, by index. */
export function changedHunks(before: FileDiff | undefined, after: FileDiff): number[] {
  const key = (hunk: Hunk) => hunk.lines.map((line) => line.kind + line.text).join("\n");
  const seen = new Set(before?.hunks.map(key));
  return after.hunks.flatMap((hunk, index) => seen.has(key(hunk)) ? [] : [index]);
}
