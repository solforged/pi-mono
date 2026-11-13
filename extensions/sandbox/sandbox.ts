// Container lifecycle. Pi processes in one worktree share its container: each
// holds a lease file named by PID, and the last one out deletes the container.
// A mkdir lock serializes start and stop; dead holders are detected by PID.
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EXEC_ID, type ContainerCli, type RunOptions, type RunResult } from "./container.ts";
import { CACHE_DIRS, runArgs, type Plan } from "./plan.ts";

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
      // The parent can go between attempts, when a sweep removes an unused container's state.
      if (error?.code === "ENOENT") { await mkdir(dirname(dir), { recursive: true }); continue; }
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
  /** Holds the per-container build output and command logs; without it they are never swept. */
  cacheRoot?: string;
  imageDir?: string;
  pid?: number;
  alive?: (pid: number) => boolean;
  onPhase?: (phase: Phase, detail?: string) => void;
}

// What `container exec` prints, with exit status 1, when the container is not there to run in.
const GONE = /container[^\n]*(not ?found|not running|does not exist)|no such container/i;
// The exit status of a command whose container was deleted under it; the CLI prints nothing.
const KILLED = 137;
const STOPPED = "The sandbox container stopped while this command was running, and has been started again. Repeat the command if that is safe.";
const NAME = /^pi-sbx-[a-z0-9-]+$/;
const OUTPUT_AGE_MS = 7 * 24 * 3600 * 1000;
const UNUSED_AGE_MS = 30 * 24 * 3600 * 1000;

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
      // Lets a later sweep tell that the project is gone.
      await writeFile(join(this.dir(), "root"), this.plan.root);
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
      await this.sweepDirs();
    } catch (error) { void this.log(`sweep failed: ${(error as Error).message}`); }
  }

  private dirsOf(name: string) {
    const { stateRoot, cacheRoot } = this.options;
    return [this.dir(name), join(stateRoot, "browser", name), ...(cacheRoot ? CACHE_DIRS.map((kind) => join(cacheRoot, kind, name)) : [])];
  }

  // Removes what a container left on the host once its project folder is gone:
  // state, the browser profile, Linux build output and command logs. Directories
  // from before the folder was recorded go after a month without use.
  private async sweepDirs() {
    const { stateRoot, cacheRoot } = this.options;
    if (!cacheRoot) return;
    const now = Date.now();
    for (const name of await readdir(this.plan.outputDir).catch(() => [] as string[])) {
      const file = join(this.plan.outputDir, name);
      const age = await stat(file).then((s) => s.isFile() ? now - s.mtimeMs : 0, () => 0);
      if (age > OUTPUT_AGE_MS) await rm(file, { force: true });
    }
    const names = new Set<string>();
    for (const parent of [join(stateRoot, "containers"), join(stateRoot, "browser"), ...CACHE_DIRS.map((kind) => join(cacheRoot, kind))]) {
      for (const name of await readdir(parent).catch(() => [] as string[])) if (NAME.test(name) && name !== this.plan.name) names.add(name);
    }
    for (const name of names) {
      const stale = async () => {
        const root = (await readFile(join(this.dir(name), "root"), "utf8").catch(() => "")).trim();
        if (root) return stat(root).then(() => false, (error) => error?.code === "ENOENT");
        const used = await Promise.all(this.dirsOf(name).map((dir) => stat(dir).then((s) => s.mtimeMs, () => 0)));
        return now - Math.max(...used) > UNUSED_AGE_MS;
      };
      if (!(await stale())) continue;
      // A session starting there takes this lock and a lease first. Taking the
      // lock touches the state directory, so its age is not read again.
      await withLock(join(this.dir(name), "lock"), async () => {
        if ((await this.liveLeases(name)).length) return;
        for (const dir of this.dirsOf(name)) await rm(dir, { recursive: true, force: true });
        void this.log(`removed the cache and state of ${name}: its project is gone or unused`);
      }, this.alive, 2000).catch(() => {});
    }
  }

  private async buildWiki() {
    const wiki = this.plan.wiki!;
    const script = 'set -e; tmp="bin/.wiki.$$"; go build -o "$tmp" ./cmd/wiki && mv -f "$tmp" bin/wiki';
    const result = await this.options.cli.exec(this.plan.name, ["bash", "-lc", script], { cwd: wiki, timeoutMs: 300000 }).catch((error) => ({ code: -1, stderr: String(error) }) as RunResult);
    if (result.code !== 0) void this.log(`wiki build failed: ${result.stderr.trim()}`);
  }

  /**
   * A command line for a long-lived guest process whose stdin and stdout the
   * caller streams. `stop` ends it in the guest: killing the client does not.
   */
  async command(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
    await this.ensure();
    const { cli } = this.options;
    const id = cli.execId();
    return {
      command: cli.bin, args: cli.execArgs(this.plan.name, argv, { ...options, env: { ...options.env, [EXEC_ID]: id }, interactive: true }),
      stop: () => cli.stop(this.plan.name, id),
    };
  }

  async exec(argv: string[], options: RunOptions & { cwd?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
    await this.ensure();
    const { cli } = this.options;
    const result = await cli.exec(this.plan.name, argv, options);
    if (result.code === 0 || result.aborted || result.timedOut) return result;
    // Only these two say the container may be gone; any other failure is the command's own.
    const refused = result.code !== KILLED && GONE.test(result.stderr);
    if (!refused && result.code !== KILLED) return result;
    if ((await cli.inspect(this.plan.name))?.running) return result;
    // Stopped underneath us (another session's cleanup, a crash, or a reboot): start once more.
    this.starting = undefined;
    await this.ensure();
    // A refused command never started, so it runs now. One that was killed may
    // have changed files already: the caller decides whether to repeat it.
    if (refused) return cli.exec(this.plan.name, argv, options);
    options.onData?.(Buffer.from(`\n[${STOPPED}]\n`));
    return { ...result, stderr: `${result.stderr}${STOPPED}\n` };
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
