// Session-file helpers for the worktree extension; see docs/worktree.md.
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const exists = (path: string) => lstat(path).then(() => true, () => false);

interface SessionSource { getSessionFile(): string | undefined; getHeader(): unknown; getEntries(): unknown[] }

/** Pi's default per-cwd session folder name, as in getDefaultSessionDirPath(). */
export const sessionBucket = (cwd: string) => `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** The session folder for `to`: its default folder when `dir` is the default one for `from`, else the same custom folder. */
export const sessionDirFor = (dir: string, from: string, to: string) =>
  basename(dir) === sessionBucket(from) ? join(dirname(dir), sessionBucket(to)) : dir;

/** Where the session file belongs when its folder is mapped from `from`'s to `to`'s. */
export const sessionFileFor = (file: string, from: string, to: string) => join(sessionDirFor(dirname(file), from, to), basename(file));

/**
 * Folders that may hold this repository's sessions. Under Pi's per-directory folders
 * that is each checkout's own, since earlier moves left files in worktree folders;
 * a custom folder is the only one.
 */
export function repositorySessionDirs(dir: string, checkouts: string[]): string[] {
  if (!checkouts.some((path) => basename(dir) === sessionBucket(path))) return [dir];
  return [...new Set([dir, ...checkouts.map((path) => join(dirname(dir), sessionBucket(path)))])];
}

export interface Listed { path: string; name?: string; firstMessage: string; modified: Date; messageCount: number; branch?: string; worktree: string }

const ago = (then: Date, now: number) => {
  const minutes = Math.max(0, Math.round((now - then.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
};

/** Picker labels for sessions in other worktrees, newest first; each label is unique. */
export function sessionChoices(sessions: Listed[], now = Date.now()): { label: string; session: Listed }[] {
  const seen = new Map<string, number>();
  return [...sessions].filter((session) => session.messageCount > 0).sort((a, b) => b.modified.getTime() - a.modified.getTime()).map((session) => {
    const title = (session.name ?? session.firstMessage).replace(/\s+/g, " ").trim() || "(untitled)";
    let label = `${title.length > 60 ? `${title.slice(0, 59)}…` : title} · ${session.branch ?? basename(session.worktree)} · ${ago(session.modified, now)}`;
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    if (count > 1) label += ` (${count})`;
    return { label, session };
  });
}

async function put(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, file);
}

/**
 * Points the session file's header at `cwd`, so that switching to it rebinds Pi there.
 * A file in a default session folder stays in, or returns to, that of `home`, the main
 * checkout, where `pi --resume` lists it and `pi --session` opens it in `cwd`; a custom
 * folder is kept. A saved file keeps its entries byte for byte; an unsaved one is
 * written from memory. `undo` restores the original file.
 */
export async function relocate(session: SessionSource, cwd: string, home: string): Promise<{ file: string; undo: () => Promise<void> }> {
  const file = session.getSessionFile();
  if (!file) throw new Error("This session has no file (--no-session), so it cannot move");
  let original: string | undefined;
  try { original = await readFile(file, "utf8"); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  const lines = original?.split("\n") ?? [JSON.stringify(session.getHeader()), ...session.getEntries().map((entry) => JSON.stringify(entry)), ""];
  const header = JSON.parse(lines[0]);
  if (header?.type !== "session" || typeof header.cwd !== "string") throw new Error(`Unexpected session header in ${file}`);
  const target = sessionFileFor(file, header.cwd, home);
  if (target !== file && await exists(target)) throw new Error(`A session file already exists at ${target}`);
  lines[0] = JSON.stringify({ ...header, cwd });
  await put(target, lines.join("\n"));
  if (target !== file) await rm(file, { force: true });
  return {
    file: target,
    undo: async () => {
      if (target !== file) await rm(target, { force: true });
      if (original !== undefined) await put(file, original);
      else if (target === file) await rm(file, { force: true });
    },
  };
}
