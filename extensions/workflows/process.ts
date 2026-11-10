import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export function bounded(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const decoder = new StringDecoder("utf8");
  return decoder.write(Buffer.from(text).subarray(0, bytes)) + "\n[truncated]";
}

export class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];
  async run<T>(limit: number, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.running >= limit) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal.removeEventListener("abort", abort); resolve(); };
        const abort = () => {
          this.queue = this.queue.filter((item) => item !== wake);
          reject(signal.reason);
        };
        this.queue.push(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    } else { this.running++; }
    try { signal.throwIfAborted(); return await fn(); }
    finally {
      const next = this.queue.shift();
      if (next) next(); // Transfer the occupied slot to the next waiter.
      else this.running--;
    }
  }
}

export interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function addUsage(target: Usage, value?: Partial<Usage>): Usage {
  if (!value) return target;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) target[key] += value[key] ?? 0;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) target.cost[key] += value.cost?.[key] ?? 0;
  return target;
}

export class JsonLines {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private consume: (event: any) => void;
  constructor(consume: (event: any) => void) { this.consume = consume; }
  push(chunk: Buffer) { this.buffer += this.decoder.write(chunk); this.drain(); }
  finish() {
    this.buffer += this.decoder.end(); this.drain();
    if (this.buffer.trim()) this.consume(JSON.parse(this.buffer));
    this.buffer = "";
  }
  private drain() {
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.consume(JSON.parse(line));
    }
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) throw new Error("Child JSON record exceeds 4 MiB");
  }
}

export interface ProcessOptions {
  cwd: string;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  input?: string;
  transcript?: string;
  onEvent?: (event: any) => void;
  maxBytes?: number;
}
export async function runProcess(command: string, args: string[], options: ProcessOptions) {
  options.signal.throwIfAborted();
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    let stdout = "", stderr = "", bytes = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const fd = options.transcript ? openSync(options.transcript, "wx", 0o600) : undefined;
    const proc = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const kill = (signal: NodeJS.Signals) => {
      try { if (proc.pid) process.kill(-proc.pid, signal); } catch (error: any) { if (error.code !== "ESRCH") proc.kill(signal); }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1500);
    };
    const parser = options.onEvent ? new JsonLines(options.onEvent) : undefined;
    // Chunks can end inside a multibyte character.
    const decodeOut = new StringDecoder("utf8"), decodeErr = new StringDecoder("utf8");
    const fail = (error: unknown) => { failure ??= error instanceof Error ? error : new Error(String(error)); stop(); };
    options.signal.addEventListener("abort", stop, { once: true });
    // The signal can change between the preflight check and listener registration.
    if (options.signal.aborted) stop();
    proc.stdout.on("data", (chunk: Buffer) => {
      try {
        bytes += chunk.length;
        if (bytes > (options.maxBytes ?? 32 * 1024 * 1024)) throw new Error("Child output limit exceeded");
        if (fd !== undefined) writeSync(fd, chunk);
        if (parser) parser.push(chunk);
        else stdout = bounded(stdout + decodeOut.write(chunk), 100000);
      } catch (error) { fail(error); }
    });
    proc.stderr.on("data", (chunk: Buffer) => { stderr = bounded(stderr + decodeErr.write(chunk), 16000); });
    proc.on("error", fail);
    proc.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") fail(error); });
    proc.stdin.end(options.input ?? "");
    proc.on("close", (code, signal) => {
      options.signal.removeEventListener("abort", stop);
      if (killTimer) clearTimeout(killTimer);
      kill("SIGKILL"); // Do not leave background descendants behind, even on success.
      if (fd !== undefined) closeSync(fd);
      try { parser?.finish(); } catch (error) { failure ??= error as Error; }
      if (options.signal.aborted) reject(options.signal.reason ?? new Error("Cancelled"));
      else if (failure) reject(failure);
      else if (signal) reject(new Error(`Child terminated by ${signal}: ${stderr}`));
      else resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}
