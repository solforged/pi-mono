// A persistent JavaScript kernel for workflow orchestration. Cells run in a
// separate process (kernel-child.cjs), on the host or inside the sandbox
// guest, so a busy loop costs a kernel restart rather than a frozen Pi.
// Workflow state stays here in Jobs; the child's handles call back for it.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bounded } from "../workflows/process.ts";
import { ReservedName, transformCell, wrapCell } from "./transform.ts";
import type { Item, Jobs } from "./jobs.ts";

export interface ToolBridge { call(name: string, args: unknown): Promise<unknown> }
export interface CellOptions {
  signal?: AbortSignal; timeoutMs?: number;
  /** True while the user has a message waiting; the cell then stops being awaited. */
  pending?: () => boolean;
  /** Every print so far, on each new one; the caller joins what it shows. */
  onOutput?: (lines: readonly string[]) => void;
  tools?: ToolBridge;
}
/** How to start the child; `source` is the kernel program for `-e`. */
export interface Launch { command: string; args: string[]; env?: Record<string, string>; where: string }
export interface KernelHooks {
  log?: (line: string) => void; phase?: (title: string) => void;
  syncTimeoutMs?: number;
  /** A kernel silent this long (no heartbeat) is stuck and gets restarted. */
  hangMs?: number;
  /** How long a new kernel may take to answer; a guest can be slow to start. */
  startupMs?: number;
  launch?: (source: string) => Launch | Promise<Launch>;
  /** Where the kernel must run now ("host" or "sandbox"); a kernel elsewhere is stopped. */
  placement?: () => string;
}
export interface CellResult { output: string; value?: string; error?: string; detached?: "timeout" | "aborted" | "user"; note?: string }
export interface KernelTool { name: string; description: string; parameters: Record<string, unknown> }

const MAX_OUTPUT = 48_000;
/** Limit for each synchronous stretch of a cell inside the child. */
const SYNC_TIMEOUT_MS = 10_000;
const STARTUP_MS = 60_000;
export const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "kernel-child.cjs"), "utf8");

/** Runs the child with the runtime Pi itself runs on: Bun inside Pi, Node in tests. */
export function localLaunch(source: string): Launch {
  const bun = Boolean(process.versions.bun);
  return { command: process.execPath, args: ["-e", source], env: bun ? { BUN_BE_BUN: "1" } : {}, where: "host" };
}

const snapshot = (item: Item) => ({ id: item.id, status: item.status, label: item.label, agent: item.agent, text: item.text,
  ...(item.schema !== undefined && item.status === "done" ? { data: item.data } : {}), ...(item.error ? { error: item.error } : {}),
  ...(item.worktree ? { worktree: item.worktree } : {}), ...(item.transcript ? { transcript: item.transcript } : {}),
  ...(item.session ? { session: item.session } : {}) });

/**
 * Cell candidates for the child, most persistent first; the last one surfaces
 * the code's own syntax error. A declaration of a kernel name throws instead:
 * running it with local declarations would hide the mistake until the next cell.
 */
export function candidates(code: string) {
  const list: Array<{ code: string; returnsValue: boolean; note?: string }> = [];
  for (const returnLast of [true, false]) {
    try { const t = transformCell(code, returnLast); list.push({ code: wrapCell(t.body, t.prelude), returnsValue: t.returnsValue }); }
    catch (error) { if (error instanceof ReservedName) throw error; /* otherwise fall through */ }
  }
  list.push({ code: wrapCell(code), returnsValue: false, note: "This cell's top-level declarations stay local: the kernel could not rewrite them." });
  return list;
}

interface Child {
  proc: ChildProcessWithoutNullStreams; ready: Promise<void>; beat: number; stderr: string; where: string;
  dead?: string; monitor: ReturnType<typeof setInterval>;
  /** Set once the child answers; until then the startup timer, not the hang monitor, decides. */
  started: boolean;
  /** Ends the waits this child's cells hold in Pi when it stops, so their results are delivered instead. */
  waits: AbortController;
}
interface Pending { resolve: (message: any) => void }

export class Kernel {
  private child?: Child;
  private cells = 0;
  private active?: { n: number; lines: string[]; size: number; onOutput?: (lines: readonly string[]) => void };
  private late: string[] = [];
  private lateSize = 0;
  private bridge?: ToolBridge;
  private runs = new Map<number, Pending>();
  private invocations = new Map<number, Pending>();
  private invokeIds = 0;
  private restartNote?: string;
  /** Bumped by reset and dispose, so a start still in flight does not install its child. */
  private generation = 0;
  readonly tools = new Map<string, KernelTool>();
  private jobs: Jobs;
  private hooks: KernelHooks;

  constructor(jobs: Jobs, hooks: KernelHooks = {}) { this.jobs = jobs; this.hooks = hooks; }

  get where() { return this.child?.where; }

  /** Stops the child; the next cell starts a fresh one. */
  reset() { this.generation++; this.stop("Kernel reset"); this.late = []; this.lateSize = 0; this.tools.clear(); this.restartNote = undefined; }
  dispose() { this.generation++; this.stop("Kernel closed"); }
  /** Stops a kernel that runs somewhere it no longer may (the sandbox was toggled). */
  relocate(reason: string) {
    if (!this.child || !this.hooks.placement || this.child.where === this.hooks.placement()) return false;
    this.reset();
    this.restartNote = `The kernel restarted because ${reason}. Variables from earlier cells are gone; jobs keep running (reattach with pool(name) or handle(id)).`;
    return true;
  }

  private stop(reason: string) {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.dead = reason;
    child.waits.abort(new Error(`Kernel stopped: ${reason}`));
    clearInterval(child.monitor);
    // SIGTERM reaches a guest process through `container exec`; SIGKILL would orphan it.
    child.proc.stdin.end();
    child.proc.kill("SIGTERM");
    setTimeout(() => { if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill("SIGKILL"); }, 3000).unref?.();
    this.settleDead(reason);
  }

  private settleDead(reason: string) {
    for (const [n, run] of this.runs) { this.runs.delete(n); run.resolve({ t: "done", cell: n, error: `Kernel stopped: ${reason}`, killed: true }); }
    for (const [id, call] of this.invocations) { this.invocations.delete(id); call.resolve({ ok: false, error: `Kernel stopped: ${reason}` }); }
  }

  private async start(): Promise<Child> {
    const generation = this.generation;
    const launch = await (this.hooks.launch ?? localLaunch)(SOURCE);
    if (generation !== this.generation) throw new Error("The kernel was reset while it started");
    const proc = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ["pipe", "pipe", "pipe"] });
    const ready = Promise.withResolvers<void>();
    const child: Child = { proc, ready: ready.promise, beat: Date.now(), stderr: "", where: launch.where, started: false, waits: new AbortController(),
      monitor: setInterval(() => {
        const limit = this.hooks.hangMs ?? (this.hooks.syncTimeoutMs ?? SYNC_TIMEOUT_MS) + 5000;
        const silent = () => child.started && this.child === child && Date.now() - child.beat > limit;
        // Pi may itself have been stalled, or the machine asleep, with beats
        // waiting unread: look again once they have had time to arrive.
        if (silent()) setTimeout(() => { if (silent()) this.crash(child, `it stopped responding for ${Math.round(limit / 1000)}s, probably a busy loop after an await`); }, 600).unref?.();
      }, 1000) };
    child.monitor.unref?.();
    proc.stderr.on("data", (chunk) => { child.stderr = (child.stderr + chunk).slice(-4000); });
    proc.stdin.on("error", () => {});
    proc.on("error", (error) => { ready.reject(error); this.crash(child, error.message); });
    proc.on("exit", (code, signal) => {
      const why = `it exited (${signal ?? code})${child.stderr.trim() ? `: ${child.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`;
      ready.reject(new Error(`Kernel could not start: ${why}`));
      this.crash(child, why);
    });
    // Split on "\n" only: readline also breaks lines at U+2028 and U+2029, which JSON leaves raw inside strings.
    let pending = "";
    proc.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop()!;
      for (const line of lines) this.receive(child, line, ready.resolve);
    });
    // Registered before it is ready, so the monitor, crashes, reset and dispose all reach it.
    this.child = child;
    this.send(child, { t: "init", counters: this.jobs.counterSnapshot(), syncTimeoutMs: this.hooks.syncTimeoutMs ?? SYNC_TIMEOUT_MS });
    const startupMs = this.hooks.startupMs ?? STARTUP_MS;
    const timer = setTimeout(() => ready.reject(new Error(`Kernel did not start within ${startupMs / 1000}s`)), startupMs);
    try { await ready.promise; } catch (error) {
      if (this.child === child) this.stop(String((error as Error).message));
      else if (!child.dead) { child.dead = "startup failed"; clearInterval(child.monitor); proc.kill("SIGKILL"); }
      throw error;
    } finally { clearTimeout(timer); }
    if (child.dead) throw new Error(`Kernel stopped during startup: ${child.dead}`);
    return child;
  }

  private crash(child: Child, reason: string) {
    if (child.dead) return;
    if (this.child === child) {
      this.restartNote = `The kernel was restarted because ${reason}. Variables from earlier cells are gone; jobs keep running (reattach with pool(name) or handle(id)).`;
      this.stop(reason);
    }
  }

  private send(child: Child, message: unknown) { if (!child.dead) child.proc.stdin.write(`${JSON.stringify(message)}\n`); }

  private receive(child: Child, line: string, ready: () => void) {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    child.beat = Date.now();
    switch (message.t) {
      case "ready": child.started = true; ready(); break;
      case "print": {
        // Output from a detached earlier cell is labelled with that cell.
        const text = this.describe(String(message.text)), from = message.cell as number | undefined;
        this.print(from !== undefined && from !== this.active?.n ? `[cell ${from}] ${text}` : text);
        break;
      }
      case "call": void this.answer(child, message); break;
      case "done": {
        const run = this.runs.get(message.cell);
        if (run) { this.runs.delete(message.cell); run.resolve(message); }
        break;
      }
      case "invoked": {
        const call = this.invocations.get(message.id);
        if (call) { this.invocations.delete(message.id); call.resolve(message); }
        break;
      }
    }
  }

  private print(text: string) {
    const cell = this.active;
    if (!cell) {
      // Sizes are tracked, not recomputed: a detached cell can print tens of thousands of lines.
      const line = text.length > 16_000 ? `${text.slice(0, 16_000)}…` : text;
      this.late.push(line); this.lateSize += line.length + 1;
      while (this.lateSize > 16_000 && this.late.length > 1) this.lateSize -= this.late.shift()!.length + 1;
      return;
    }
    if (cell.size > MAX_OUTPUT * 2) return;
    cell.lines.push(text); cell.size += text.length + 1;
    cell.onOutput?.(cell.lines);
  }

  /** Replaces handle tokens from the child with their current status. */
  describe(text: string) {
    return text.replace(/\u0001(pool|agent|completion|judge|item):([^\u0001]*)\u0001/g, (_m, kind: string, id: string) => {
      const jobs = this.jobs;
      if (kind === "pool") {
        if (!jobs.pools.has(id)) return `Pool(${id} · not started)`;
        const s = jobs.poolStatus(id);
        return `Pool(${id} · ${s.agent} · ${s.done + s.failed + s.cancelled}/${s.total} finished${s.running ? ` · ${s.running} running` : ""}${s.queued ? ` · ${s.queued} queued` : ""})`;
      }
      if (kind === "judge") {
        const b = jobs.batches.get(id);
        return b ? `JudgmentBatch(${id} · ${b.intent} · ${b.items.length}/${b.total} judged${b.done ? " · done" : ""})` : `JudgmentBatch(${id} · not started)`;
      }
      const item = jobs.items.get(id);
      if (!item) return `Agent(${id} · not started)`;
      return `${item.kind === "completion" ? "Completion" : "Agent"}(${item.id} · ${item.status} · ${item.label})`;
    });
  }

  private async answer(child: Child, message: { id: number; fn: string; args: unknown[] }) {
    try {
      const value = await this.dispatch(message.fn, message.args ?? [], child.waits.signal);
      this.send(child, { t: "reply", id: message.id, ok: true, value });
    } catch (error) {
      const e = error as Error;
      this.send(child, { t: "reply", id: message.id, ok: false, error: { name: e?.name ?? "Error", message: String(e?.message ?? error) } });
    }
  }

  /** The workflow API behind the child's handles. Values must survive JSON. */
  private async dispatch(fn: string, args: any[], signal: AbortSignal): Promise<unknown> {
    const jobs = this.jobs;
    const ms = (value: unknown) => value === undefined || value === null ? undefined : Math.max(0, Number(value));
    const finished = (items: Item[]) => items.filter((i) => !["queued", "running"].includes(i.status));
    switch (fn) {
      case "createPool": return jobs.createPool(args[0], args[1] ?? {}).name;
      case "poolStatus": return jobs.poolStatus(String(args[0]));
      case "poolPush": return jobs.push(String(args[0]), Array.isArray(args[1]) ? args[1] : [args[1]]);
      case "poolPeek": return jobs.poolItems(String(args[0])).map(snapshot);
      case "poolResults": return finished(jobs.poolItems(String(args[0]))).map(snapshot);
      case "poolWait": return (await jobs.poolWait(String(args[0]), ms(args[1]), signal)).map(snapshot);
      case "poolClose": jobs.closePool(String(args[0])); return undefined;
      case "agent": return jobs.agent(args[0], args[1] ?? {}).id;
      case "completion": return jobs.completion(args[0], args[1] ?? {}).id;
      case "agentSend": { const item = jobs.followUp(String(args[0]), args[1], args[2] ?? {}); return { id: item.id, label: item.label }; }
      case "itemWait": return jobs.itemWait(String(args[0]), ms(args[1]), signal);
      case "itemStatus": { const item = jobs.items.get(String(args[0])); if (!item) throw new Error(`No job item ${args[0]}`); return item.status; }
      case "judge": return jobs.judge(args[0], args[1], signal);
      case "judgeBatch": return jobs.judgeBatch(args[0], args[1], args[2] ?? {}).id;
      case "batchDrain": return (await jobs.batchDrain(String(args[0]), ms(args[1]) ?? 30_000, signal)).map((i) => [i.key, i]);
      case "batchStatus": {
        const b = jobs.batch(String(args[0])), ok = b.items.filter((i) => i.ok).length;
        return { id: b.id, intent: b.intent, total: b.total, judged: b.items.length, ok, failed: b.items.length - ok, done: b.done, closed: b.closed, drainedAll: b.drained >= b.items.length };
      }
      case "batchResults": return Object.fromEntries(jobs.batch(String(args[0])).items.filter((i) => i.ok).sort((a, b) => a.key - b.key).map((i) => [i.key, i.answers]));
      case "batchFailed": return jobs.batch(String(args[0])).items.filter((i) => !i.ok).map((i) => ({ key: i.key, error: i.error }));
      case "batchClose": jobs.closeBatch(String(args[0])); return undefined;
      case "budget": {
        const total = jobs.budget.total;
        return args[0] === "spent" ? jobs.spent() : total === undefined ? null : args[0] === "total" ? total : Math.max(0, total - jobs.spent());
      }
      case "tool": {
        const name = String(args[0]);
        if (!this.bridge) throw new Error("tools.* works only while an eval cell is being awaited");
        if (name === "eval" || name === "wait") throw new Error(`tools.${name} cannot be called from the kernel`);
        return this.bridge.call(name, args[1] ?? {});
      }
      case "defineTool": {
        const name = String(args[0]), options = (args[1] ?? {}) as { description?: unknown; parameters?: unknown };
        const parameters = options.parameters && typeof options.parameters === "object" ? options.parameters as Record<string, unknown> : { type: "object", properties: {} };
        if ((parameters as { type?: unknown }).type !== "object") throw new Error("tool() parameters must be a JSON Schema object");
        this.tools.set(name, { name, description: String(options.description ?? `Kernel function ${name}`).slice(0, 1000), parameters });
        return undefined;
      }
      case "log": this.hooks.log?.(String(args[0])); return undefined;
      case "phase": jobs.phase = String(args[0]); this.hooks.phase?.(jobs.phase); jobs.onChange(); return undefined;
      default: throw new Error(`Unknown kernel call ${fn}`);
    }
  }

  /** Calls a function the kernel registered with tool(); used by children's kernel tools. */
  async invoke(name: string, args: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: string; error?: string }> {
    this.relocate("the sandbox was turned on or off");
    const child = this.child;
    if (!child || !this.tools.has(name)) return { ok: false, error: `Kernel tool ${name} is not defined (was the kernel reset?)` };
    const id = ++this.invokeIds;
    const pending = Promise.withResolvers<any>();
    this.invocations.set(id, { resolve: pending.resolve });
    const abort = () => { this.invocations.delete(id); pending.resolve({ ok: false, error: "Cancelled" }); };
    signal?.addEventListener("abort", abort, { once: true });
    this.send(child, { t: "invoke", id, name, args });
    try { return await pending.promise; } finally { signal?.removeEventListener("abort", abort); }
  }

  async run(code: string, options: CellOptions = {}): Promise<CellResult> {
    let list: ReturnType<typeof candidates>;
    try { list = candidates(code); } catch (error) { return { output: "", error: String((error as Error).message) }; }
    const n = ++this.cells;
    const earlier = this.late.splice(0);
    this.lateSize = 0;
    const notes: string[] = [];
    const cell = { n, lines: earlier.length ? ["[earlier background output]", ...earlier, "[this cell]"] : [], size: 0, onOutput: options.onOutput };
    this.relocate("the sandbox was turned on or off");
    let child = this.child;
    try {
      if (child) await child.ready;
      else child = await this.start();
      // The sandbox may have been toggled while the kernel started.
      if (this.relocate("the sandbox was turned on or off")) child = await this.start();
    } catch (error) { return { output: cell.lines.join("\n"), error: String((error as Error).message) }; }
    if (this.restartNote) { notes.push(this.restartNote); this.restartNote = undefined; }
    this.active = cell; this.bridge = options.tools;
    const done = Promise.withResolvers<any>();
    this.runs.set(n, { resolve: done.resolve });
    this.send(child, { t: "run", cell: n, candidates: list });
    type Outcome = { kind: "done"; message: any } | { kind: "timeout" | "aborted" | "user" };
    let timer: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined, onAbort: (() => void) | undefined;
    const outcome = await new Promise<Outcome>((resolve) => {
      done.promise.then((message) => resolve({ kind: "done", message }));
      if (options.timeoutMs !== undefined) timer = setTimeout(() => resolve({ kind: "timeout" }), options.timeoutMs);
      if (options.signal) {
        onAbort = () => resolve({ kind: "aborted" });
        if (options.signal.aborted) onAbort(); else options.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (options.pending && !options.pending()) poll = setInterval(() => { if (options.pending!()) resolve({ kind: "user" }); }, 250);
    });
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    if (this.active === cell) { this.active = undefined; this.bridge = undefined; }
    if (this.restartNote) { notes.push(this.restartNote); this.restartNote = undefined; }
    const output = bounded(cell.lines.join("\n"), MAX_OUTPUT);
    if (outcome.kind === "done") {
      const m = outcome.message;
      // This cell stopped the kernel itself: its error already says why.
      if (m.killed) notes.splice(0, notes.length, "Variables from earlier cells are gone; jobs keep running (reattach with pool(name) or handle(id)).");
      const note = [...notes, ...(m.note ? [String(m.note)] : [])].join("\n") || undefined;
      return { output, ...(m.value !== undefined ? { value: bounded(this.describe(String(m.value)), 16_000) } : {}), ...(m.error ? { error: this.describe(String(m.error)) } : {}), note };
    }
    // The cell keeps running; its later output and outcome surface in the next cell.
    done.promise.then((m) => {
      if (m.killed) return;
      this.print(m.error ? `[cell ${n} failed] ${this.describe(String(m.error))}` : `[cell ${n} finished]${m.value === undefined ? "" : ` ${this.describe(String(m.value))}`}`);
    });
    return { output, detached: outcome.kind, note: notes.join("\n") || undefined };
  }
}
