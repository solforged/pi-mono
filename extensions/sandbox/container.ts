// Drives Apple's `container` CLI. Cancellation sends SIGTERM to the client,
// which forwards it into the guest (see image/pi-run), then SIGKILL.
import { spawn } from "node:child_process";

export interface RunOptions {
  input?: Buffer | string;
  onData?: (chunk: Buffer) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}
export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  truncated: boolean;
}
export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

const GRACE_MS = 3000;

export const runProcess: Runner = (command, args, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) return resolve({ code: null, stdout: Buffer.alloc(0), stderr: "", aborted: true, timedOut: false, truncated: false });
  const child = spawn(command, args, { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let size = 0, stderr = "", aborted = false, timedOut = false, truncated = false;
  let killTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), GRACE_MS);
  };
  const onAbort = () => { aborted = true; stop(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs) : undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    if (options.onData) return options.onData(chunk);
    if (options.maxBytes !== undefined && size + chunk.length > options.maxBytes) {
      chunks.push(chunk.subarray(0, Math.max(0, options.maxBytes - size)));
      size = options.maxBytes; truncated = true; stop(); return;
    }
    chunks.push(chunk); size += chunk.length;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (options.onData) options.onData(chunk);
    else if (stderr.length < 65536) stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => { cleanup(); reject(error); });
  child.on("close", (code) => { cleanup(); resolve({ code, stdout: Buffer.concat(chunks), stderr, aborted, timedOut, truncated }); });
  if (options.input !== undefined) {
    child.stdin!.on("error", () => {});
    child.stdin!.end(options.input);
  }
  function cleanup() {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", onAbort);
  }
});

export interface ContainerInfo { running: boolean; labels: Record<string, string> }

export class ContainerCli {
  readonly run: Runner;
  readonly bin: string;
  constructor(run: Runner = runProcess, bin = "container") { this.run = run; this.bin = bin; }
  async call(args: string[], options?: RunOptions) {
    const result = await this.run(this.bin, args, options);
    if (result.code !== 0 && !result.aborted) throw new Error(`container ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    return result;
  }
  async status() {
    const result = await this.run(this.bin, ["system", "status"], { timeoutMs: 15000 }).catch((error) => ({ code: -1, stderr: String(error) }) as RunResult);
    if (result.code !== 0) throw new Error(`Apple container services are not running (${result.stderr.trim() || "no status"}). Start them with: container system start`);
  }
  async inspect(name: string): Promise<ContainerInfo | undefined> {
    const result = await this.run(this.bin, ["inspect", name], { timeoutMs: 15000 });
    if (result.code !== 0) return undefined;
    const [info] = JSON.parse(result.stdout.toString("utf8") || "[]");
    if (!info) return undefined;
    return { running: info.status === "running" || info.status?.state === "running", labels: info.configuration?.labels ?? {} };
  }
  async list(): Promise<Array<{ id: string; running: boolean; labels: Record<string, string> }>> {
    const result = await this.call(["list", "--all", "--format", "json"], { timeoutMs: 15000 });
    return (JSON.parse(result.stdout.toString("utf8") || "[]") as any[]).map((info) => ({
      id: info.configuration?.id ?? info.id, running: info.status === "running" || info.status?.state === "running", labels: info.configuration?.labels ?? {},
    }));
  }
  async imageExists(reference: string) {
    return (await this.run(this.bin, ["image", "inspect", reference], { timeoutMs: 15000 })).code === 0;
  }
  // Leaves the BuildKit VM as it found it: a builder started here is stopped.
  async build(tag: string, dir: string, onData?: (chunk: Buffer) => void, signal?: AbortSignal) {
    const before = await this.run(this.bin, ["builder", "status"], { timeoutMs: 15000 });
    const wasRunning = before.code === 0 && /\brunning\b/.test(before.stdout.toString("utf8"));
    try {
      await this.call(["build", "--progress", "plain", "--tag", tag, "--file", `${dir}/Containerfile`, dir], { onData, signal });
    } finally {
      if (!wasRunning) await this.run(this.bin, ["builder", "stop"], { timeoutMs: 60000 });
    }
  }
  async start(args: string[]) { await this.call(args, { timeoutMs: 120000 }); }
  async remove(name: string) { await this.run(this.bin, ["delete", "--force", name], { timeoutMs: 60000 }); }
  // Detached so Pi can exit without waiting for the VM to stop.
  removeDetached(name: string) {
    const child = spawn(this.bin, ["delete", "--force", name], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  }
  exec(name: string, argv: string[], options: RunOptions & { cwd?: string; env?: Record<string, string> } = {}) {
    const args = ["exec", ...(options.input !== undefined ? ["--interactive"] : [])];
    if (options.cwd) args.push("--workdir", options.cwd);
    for (const [key, value] of Object.entries(options.env ?? {})) args.push("--env", `${key}=${value}`);
    return this.run(this.bin, [...args, name, ...argv], options);
  }
}
