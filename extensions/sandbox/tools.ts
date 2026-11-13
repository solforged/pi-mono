// Guest implementations of Pi's file and shell tools. Paths are host paths:
// the sandbox mounts everything at the same location, so no translation.
import {
  type BashOperations, type EditOperations, type FindOperations, type LsOperations, type ReadOperations, type WriteOperations,
  DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine,
} from "@earendil-works/pi-coding-agent";
import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Sandbox } from "./sandbox.ts";
import { commandEnv, fdArgs, GREP_SCRIPT, GrepCollector, type GrepParams, guestError, LS_SCRIPT, parseListing, rgArgs, sniffImage, type Listing } from "./guest.ts";

const READ_LIMIT = 256 * 1024 * 1024;

export function readOps(sandbox: Sandbox): ReadOperations & Pick<EditOperations, "readFile" | "access"> {
  const cache = new Map<string, Promise<Buffer>>();
  const load = (path: string) => {
    let pending = cache.get(path);
    if (!pending) {
      pending = sandbox.exec(["cat", "--", path], { maxBytes: READ_LIMIT }).then((result) => {
        if (result.truncated) throw new Error(`File is larger than ${formatSize(READ_LIMIT)}: ${path}`);
        if (result.code !== 0) throw guestError(result.stderr, path, "open");
        return result.stdout;
      });
      cache.set(path, pending);
    }
    return pending;
  };
  return {
    access: async (path) => { await load(path); },
    readFile: (path) => load(path),
    detectImageMimeType: async (path) => sniffImage(await load(path)),
  };
}

export function writeOps(sandbox: Sandbox): WriteOperations {
  return {
    mkdir: async (dir) => {
      const result = await sandbox.exec(["mkdir", "-p", "--", dir]);
      if (result.code !== 0) throw guestError(result.stderr, dir, "mkdir");
    },
    writeFile: async (path, content) => {
      const result = await sandbox.exec(["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", path], { input: Buffer.from(content, "utf8") });
      if (result.code !== 0) throw guestError(result.stderr, path, "open");
    },
  };
}

export function editOps(sandbox: Sandbox): EditOperations {
  const { readFile, access } = readOps(sandbox);
  return { readFile, access, writeFile: writeOps(sandbox).writeFile };
}

export function lsOps(sandbox: Sandbox): LsOperations {
  const listings = new Map<string, Promise<Listing>>();
  const list = (path: string) => {
    let pending = listings.get(path);
    if (!pending) {
      pending = sandbox.exec(["sh", "-c", LS_SCRIPT, "sh", path]).then((result) => {
        if (result.code !== 0) throw guestError(result.stderr, path, "scandir");
        return parseListing(result.stdout);
      });
      listings.set(path, pending);
    }
    return pending;
  };
  const stat = async (path: string) => {
    // Entries are answered from their parent's listing: one exec per ls call.
    const parent = listings.get(posix.dirname(path));
    const known = parent && (await parent).entries.get(posix.basename(path));
    if (known !== undefined) return { isDirectory: () => known };
    const own = await list(path);
    if (own.kind === "missing") throw guestError("No such file or directory", path, "stat");
    return { isDirectory: () => own.kind === "dir" };
  };
  return {
    exists: async (path) => (await list(path)).kind !== "missing",
    stat: stat as LsOperations["stat"],
    readdir: async (path) => [...(await list(path)).entries.keys()],
  };
}

export function findOps(sandbox: Sandbox): FindOperations {
  return {
    exists: async (path) => (await sandbox.exec(["test", "-e", path])).code === 0,
    glob: async (pattern, cwd, options) => {
      const result = await sandbox.exec(["fd", ...fdArgs(pattern, cwd, options.limit, options.ignore)]);
      if (result.code !== 0 && !result.stdout.length) throw new Error(result.stderr.trim() || `fd exited with code ${result.code}`);
      return result.stdout.toString("utf8").split("\n").map((line) => line.replace(/\r$/, "").trim()).filter(Boolean);
    },
  };
}

// Mirrors Pi's grep output, running ripgrep in the guest in one exec.
export async function grep(sandbox: Sandbox, params: GrepParams, searchPath: string, signal?: AbortSignal) {
  const limit = Math.max(1, params.limit ?? 100);
  const collector = new GrepCollector(limit);
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let kind = "", pending = "", stderr = "", stopped = false;
  const decoder = new StringDecoder("utf8"); // Chunks can end inside a multibyte character.
  const consume = (line: string) => {
    if (!kind) { kind = line.trim(); return; }
    if (!stopped && !collector.push(line)) { stopped = true; stop.abort(); }
  };
  try {
    const result = await sandbox.exec(["sh", "-c", GREP_SCRIPT, "sh", searchPath, ...rgArgs(params)], {
      signal: stop.signal,
      onData: (chunk) => {
        // stdout and stderr share the stream; rg's JSON lines are recognizable.
        pending += decoder.write(chunk);
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (kind && !line.startsWith("{")) stderr += `${line}\n`;
          else consume(line);
        }
      },
    });
    if (pending) consume(pending);
    if (signal?.aborted) throw new Error("Operation aborted");
    if (kind === "M") throw new Error(`Path not found: ${searchPath}`);
    if (!stopped && result.code !== 0 && result.code !== 1) throw new Error(stderr.trim() || `ripgrep exited with code ${result.code}`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (!collector.matches) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
  const { output, linesTruncated } = collector.format(searchPath, kind === "D", (line) => truncateLine(line));
  const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  let text = truncation.content;
  const details: Record<string, unknown> = {};
  const notices: string[] = [];
  if (collector.limitReached) {
    notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    details.matchLimitReached = limit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push("Some lines truncated. Use read tool to see full lines");
    details.linesTruncated = true;
  }
  if (notices.length) text += `\n\n[${notices.join(". ")}]`;
  return { content: [{ type: "text" as const, text }], details: Object.keys(details).length ? details : undefined };
}

export function bashOps(sandbox: Sandbox): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error("aborted");
      const result = await sandbox.exec(["/usr/local/libexec/pi-sandbox/pi-run", command], {
        cwd, env: commandEnv(env), onData, signal, timeoutMs: timeout ? timeout * 1000 : undefined,
      });
      if (result.aborted || signal?.aborted) throw new Error("aborted");
      if (result.timedOut) throw new Error(`timeout:${timeout}`);
      return { exitCode: result.code ?? 1 };
    },
  };
}
