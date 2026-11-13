// Container lifecycle. Pi processes in one worktree share its container: each
// holds a lease file named by PID, and the last one out deletes the container.
// A mkdir lock serializes start and stop; dead holders are detected by PID.
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContainerCli, RunOptions, RunResult } from "./container.ts";
import { runArgs, type Plan } from "./plan.ts";

export type Phase = "idle" | "building" | "starting" | "ready" | "error";

export const isAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === "EPERM"; }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withLock<T>(dir: string, fn: () => Promise<T>, alive = isAlive, timeoutMs = 600000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(dir), { recursive: true });
  for (;;) {
    try {
      await mkdir(dir);
      await writeFile(join(dir, "pid"), String(process.pid));
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const owner = Number(await readFile(join(dir, "pid"), "utf8").catch(() => ""));
      const age = await stat(dir).then((s) => Date.now() - s.mtimeMs, () => 0);
      if ((owner && !alive(owner)) || (!owner && age > 10000)) { await rm(dir, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${dir}`);
      await sleep(150);
    }
  }
  try { return await fn(); } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function imageTag(dir: string) {
  const digest = createHash("sha256");
  for (const name of (await readdir(dir)).sort()) digest.update(name).update("\0").update(await readFile(join(dir, name))).update("\0");
  return `pi-sandbox:${digest.digest("hex").slice(0, 12)}`;
}

export interface SandboxOptions {
  cli: ContainerCli;
  stateRoot: string;
  imageDir?: string;
  pid?: number;
  alive?: (pid: number) => boolean;
  onPhase?: (phase: Phase, detail?: string) => void;
}

const GONE = /not ?found|not running|no such container|does not exist/i;

export class Sandbox {
  phase: Phase = "idle";
  error?: Error;
  private starting?: Promise<void>;
  private readonly pid: number;
  private readonly alive: (pid: number) => boolean;
  readonly plan: Plan;
  readonly options: SandboxOptions;
  constructor(plan: Plan, options: SandboxOptions) {
    this.plan = plan;
    this.options = options;
    this.pid = options.pid ?? process.pid;
    this.alive = options.alive ?? isAlive;
  }
  private dir(name = this.plan.name) { return join(this.options.stateRoot, "containers", name); }
  private set(phase: Phase, detail?: string) { this.phase = phase; this.options.onPhase?.(phase, detail); }
  private log(line: string) { return appendFile(join(this.options.stateRoot, "sandbox.log"), `${new Date().toISOString()} ${line}\n`).catch(() => {}); }

  ensure(): Promise<void> {
    this.starting ??= this.start().then(() => this.set("ready"), (error) => {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.set("error", this.error.message);
      void this.log(`start failed: ${this.error.message}`);
      throw this.error;
    });
    return this.starting;
  }

  private async liveLeases(name: string) {
    const dir = join(this.dir(name), "leases");
    const pids = (await readdir(dir).catch(() => [] as string[])).map(Number).filter(Number.isInteger);
    const live: number[] = [];
    for (const pid of pids) {
      if (pid !== this.pid && !this.alive(pid)) await rm(join(dir, String(pid)), { force: true });
      else live.push(pid);
    }
    return live;
  }

  private async start() {
    const { cli, stateRoot, imageDir } = this.options;
    await mkdir(join(stateRoot, "containers"), { recursive: true });
    await cli.status();
    if (imageDir && !(await cli.imageExists(this.plan.image))) {
      await withLock(join(stateRoot, "image.lock"), async () => {
        if (await cli.imageExists(this.plan.image)) return;
        this.set("building", this.plan.image);
        const logFile = join(stateRoot, "build.log");
        await writeFile(logFile, "");
        try {
          await cli.build(this.plan.image, imageDir, (chunk) => { void appendFile(logFile, chunk); });
        } catch (error) {
          throw new Error(`Image build failed; see ${logFile}: ${(error as Error).message}`);
        }
      }, this.alive);
    } else if (!(await cli.imageExists(this.plan.image))) {
      throw new Error(`Sandbox image not found: ${this.plan.image}`);
    }
    this.set("starting");
    for (const dir of this.plan.hostDirs) await mkdir(dir, { recursive: true });
    let fresh = false;
    await withLock(join(this.dir(), "lock"), async () => {
      const leases = join(this.dir(), "leases");
      await mkdir(leases, { recursive: true });
      // The lease goes first so a concurrent sweep never deletes a starting container.
      await writeFile(join(leases, String(this.pid)), "");
      const others = (await this.liveLeases(this.plan.name)).filter((pid) => pid !== this.pid);
      const info = await cli.inspect(this.plan.name);
      const same = info?.labels["pi.sandbox.config"] === this.plan.labels["pi.sandbox.config"];
      if (info?.running && (same || others.length)) {
        if (!same) void this.log(`reusing ${this.plan.name} with different settings; it restarts when its other sessions end`);
        return;
      }
      if (info) await cli.remove(this.plan.name);
      await cli.start(runArgs(this.plan));
      fresh = true;
    }, this.alive);
    void this.sweep();
    if (fresh && this.plan.wikiBuild) void this.buildWiki();
  }

  // Deletes sandbox containers whose Pi processes have all exited.
  private async sweep() {
    try {
      for (const info of await this.options.cli.list()) {
        if (info.labels["pi.sandbox"] !== "1" || info.id === this.plan.name) continue;
        if (await stat(join(this.dir(info.id), "lock")).then(() => true, () => false)) continue;
        if (!(await this.liveLeases(info.id)).length) this.options.cli.removeDetached(info.id);
      }
    } catch (error) { void this.log(`sweep failed: ${(error as Error).message}`); }
  }

  private async buildWiki() {
    const wiki = this.plan.wiki!;
    const script = 'set -e; tmp="bin/.wiki.$$"; go build -o "$tmp" ./cmd/wiki && mv -f "$tmp" bin/wiki';
    const result = await this.options.cli.exec(this.plan.name, ["bash", "-lc", script], { cwd: wiki, timeoutMs: 300000 }).catch((error) => ({ code: -1, stderr: String(error) }) as RunResult);
    if (result.code !== 0) void this.log(`wiki build failed: ${result.stderr.trim()}`);
  }

  /** A command line for a long-lived guest process whose stdin and stdout the caller streams. */
  async command(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
    await this.ensure();
    return { command: this.options.cli.bin, args: this.options.cli.execArgs(this.plan.name, argv, { ...options, interactive: true }) };
  }

  async exec(argv: string[], options: RunOptions & { cwd?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
    await this.ensure();
    const result = await this.options.cli.exec(this.plan.name, argv, options);
    // Streamed output has no separate stderr to inspect, so check the container itself.
    const suspect = options.onData || GONE.test(result.stderr);
    if (result.code !== 0 && !result.aborted && !result.timedOut && suspect && !(await this.options.cli.inspect(this.plan.name))?.running) {
      // Stopped underneath us (another session's cleanup, a crash, or a reboot): start once more.
      this.starting = undefined;
      await this.ensure();
      return this.options.cli.exec(this.plan.name, argv, options);
    }
    return result;
  }

  async release() {
    // A start still in flight would otherwise create the container after we leave.
    const pending = this.starting;
    this.starting = undefined;
    if (pending) {
      // Cleared afterwards: a pending timer would hold a print-mode process open.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([pending.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, 20000); })]);
      clearTimeout(timer);
    }
    this.set("idle");
    let last = false;
    await withLock(join(this.dir(), "lock"), async () => {
      await rm(join(this.dir(), "leases", String(this.pid)), { force: true });
      last = !(await this.liveLeases(this.plan.name)).filter((pid) => pid !== this.pid).length;
    }, this.alive, 10000).catch(() => {});
    if (last) this.options.cli.removeDetached(this.plan.name);
  }

  // Whether this sandbox, kept from the previous session in this process, fits a new plan.
  fits(plan: Plan) {
    return this.phase !== "error" && this.plan.labels["pi.sandbox.config"] === plan.labels["pi.sandbox.config"];
  }

  async restart() {
    await withLock(join(this.dir(), "lock"), () => this.options.cli.remove(this.plan.name), this.alive);
    this.starting = undefined;
    this.error = undefined;
    return this.ensure();
  }
}
