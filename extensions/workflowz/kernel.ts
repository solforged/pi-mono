// A persistent JavaScript kernel for workflow orchestration. Cells run in a
// node:vm context (not a security boundary) whose globals are the workflow
// helpers; top-level declarations persist between cells.

import vm from "node:vm";
import { inspect } from "node:util";
import { bounded } from "../workflows/process.ts";
import { transformCell, wrapCell } from "./transform.ts";
import type { Item, Jobs } from "./jobs.ts";

export interface ToolBridge { call(name: string, args: unknown): Promise<unknown> }
export interface CellOptions {
  signal?: AbortSignal; timeoutMs?: number;
  /** True while the user has a message waiting; the cell then stops being awaited. */
  pending?: () => boolean;
  onOutput?: (text: string) => void;
  tools?: ToolBridge;
}
export interface KernelHooks { log?: (line: string) => void; phase?: (title: string) => void; syncTimeoutMs?: number }
export interface CellResult { output: string; value?: string; error?: string; detached?: "timeout" | "aborted" | "user"; note?: string }

const MAX_OUTPUT = 48_000;
/** Limit for each synchronous stretch of a cell; a busy loop after an await is not covered. */
const SYNC_TIMEOUT_MS = 10_000;
const custom = inspect.custom;
const show = (value: unknown) => typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 110, maxArrayLength: 60, maxStringLength: 20_000 });
const snapshot = (item: Item) => ({ id: item.id, status: item.status, label: item.label, agent: item.agent, text: item.text,
  ...(item.schema !== undefined && item.status === "done" ? { data: item.data } : {}), ...(item.error ? { error: item.error } : {}),
  ...(item.worktree ? { worktree: item.worktree } : {}), ...(item.transcript ? { transcript: item.transcript } : {}) });
const ms = (options: any) => options?.timeout === undefined ? undefined : Math.max(0, Number(options.timeout) * 1000);

function describeError(error: unknown): string {
  if (!(error && typeof error === "object" && "message" in error)) return `Uncaught ${show(error)}`;
  const e = error as Error;
  const frames = (e.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line) && /cell-\d+\.js/.test(line)).slice(0, 6);
  return [`${e.name ?? "Error"}: ${e.message}`, ...frames].join("\n");
}

export class Kernel {
  private context!: vm.Context;
  private cells = 0;
  private active?: { lines: string[]; size: number; onOutput?: (text: string) => void };
  private late: string[] = [];
  private bridge?: ToolBridge;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private jobs: Jobs;
  private hooks: KernelHooks;

  constructor(jobs: Jobs, hooks: KernelHooks = {}) { this.jobs = jobs; this.hooks = hooks; this.reset(); }

  reset() { this.dispose(); this.context = vm.createContext(this.globals()); this.late = []; this.cells = 0; }
  /** Clears the kernel's timers; cells still awaiting something stop getting callbacks from them. */
  dispose() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }

  private print(text: string) {
    const cell = this.active;
    if (!cell) {
      this.late.push(text);
      while (this.late.join("\n").length > 16_000) this.late.shift();
      return;
    }
    if (cell.size > MAX_OUTPUT * 2) return;
    cell.lines.push(text); cell.size += text.length + 1;
    cell.onOutput?.(cell.lines.join("\n"));
  }

  private globals() {
    const jobs = this.jobs;
    const print = (...args: unknown[]) => this.print(args.map(show).join(" "));
    const guard = (fn: (...args: any[]) => unknown) => (...args: any[]) => {
      try { const r: any = fn(...args); if (r && typeof r.then === "function") r.then(undefined, (e: unknown) => this.print(`[timer] ${describeError(e)}`)); }
      catch (e) { this.print(`[timer] ${describeError(e)}`); }
    };
    const itemHandle = (item: Item) => ({
      id: item.id, handle: `agent://${item.id}`, label: item.label,
      wait: (options?: { timeout?: number }) => jobs.itemWait(item.id, ms(options)),
      status: () => item.status,
      [custom]: () => `${item.kind === "completion" ? "Completion" : "Agent"}(${item.id} · ${item.status} · ${item.label})`,
    });
    const poolHandle = (name: string) => ({
      name,
      push: async (...items: unknown[]) => jobs.push(name, items.length === 1 && Array.isArray(items[0]) ? items[0] : items),
      status: async () => jobs.poolStatus(name),
      peek: async () => jobs.poolItems(name).map(snapshot),
      results: async () => jobs.poolItems(name).filter((i) => !["queued", "running"].includes(i.status)).map(snapshot),
      wait: async (options?: { timeout?: number }) => (await jobs.poolWait(name, ms(options))).map(snapshot),
      close: async () => jobs.closePool(name),
      [custom]: () => { const s = jobs.poolStatus(name); return `Pool(${name} · ${s.agent} · ${s.done + s.failed + s.cancelled}/${s.total} finished${s.running ? ` · ${s.running} running` : ""}${s.queued ? ` · ${s.queued} queued` : ""})`; },
    });
    const batchHandle = (id: string) => ({
      id,
      drain: async (options?: { timeout?: number }) => (await jobs.batchDrain(id, ms(options) ?? 30_000)).map((i) => [i.key, i] as const),
      drainIter: async function* (options?: { timeout?: number }) {
        while (true) {
          const fresh = await jobs.batchDrain(id, ms(options) ?? 30_000);
          for (const item of fresh) yield [item.key, item] as const;
          const batch = jobs.batch(id);
          if (batch.done && batch.drained >= batch.items.length) return;
          if (!fresh.length && !batch.done) continue;
        }
      },
      status: async () => { const b = jobs.batch(id); const ok = b.items.filter((i) => i.ok).length; return { id, intent: b.intent, total: b.total, judged: b.items.length, ok, failed: b.items.length - ok, done: b.done, closed: b.closed }; },
      results: async () => Object.fromEntries(jobs.batch(id).items.filter((i) => i.ok).sort((a, b) => a.key - b.key).map((i) => [i.key, i.answers])),
      failed: async () => jobs.batch(id).items.filter((i) => !i.ok).map((i) => ({ key: i.key, error: i.error })),
      close: async () => jobs.closeBatch(id),
      [custom]: () => { const b = jobs.batch(id); return `JudgmentBatch(${id} · ${b.intent} · ${b.items.length}/${b.total} judged${b.done ? " · done" : ""})`; },
    });
    const tools = new Proxy({}, {
      get: (_target, name) => typeof name !== "string" || name === "then" ? undefined : (args: unknown = {}) => {
        if (!this.bridge) return Promise.reject(new Error("tools.* works only while an eval cell is being awaited"));
        if (name === "eval" || name === "wait") return Promise.reject(new Error(`tools.${name} cannot be called from the kernel`));
        return this.bridge.call(name, args);
      },
    });
    return {
      print, console: { log: print, info: print, warn: print, error: print, debug: print },
      log: (message: unknown) => { const line = String(message); this.print(`· ${line}`); this.hooks.log?.(line); },
      phase: (title: unknown) => { jobs.phase = String(title); this.print(`## ${jobs.phase}`); this.hooks.phase?.(jobs.phase); jobs.onChange(); },
      workpool: (agent?: unknown, options?: any) => {
        if (agent && typeof agent === "object") { options = agent; agent = undefined; }
        return poolHandle(jobs.createPool(agent ?? "scout", options ?? {}).name);
      },
      agent: (prompt: unknown, options?: any) => itemHandle(jobs.agent(prompt, options ?? {})),
      completion: (prompt: unknown, options?: any) => itemHandle(jobs.completion(prompt, options ?? {})),
      judge: (state: unknown, questions: unknown) => jobs.judge(state, questions),
      judgeBatch: (states: unknown, questions: unknown, options?: any) => batchHandle(jobs.judgeBatch(states, questions, options ?? {}).id),
      wait: async (handles: any, options?: { timeout?: number; raiseErrors?: boolean }) => {
        const list = Array.isArray(handles) ? handles : [handles];
        const settled = await Promise.allSettled(list.map((h) => {
          if (!h || typeof h.id !== "string" || !jobs.items.has(h.id)) return Promise.reject(new Error("wait() takes agent/completion handles; use pool.wait() for pools"));
          return jobs.itemWait(h.id, ms(options));
        }));
        if (options?.raiseErrors !== false) { const failed = settled.find((s) => s.status === "rejected"); if (failed) throw (failed as PromiseRejectedResult).reason; }
        const values = settled.map((s) => s.status === "fulfilled" ? s.value : (s as PromiseRejectedResult).reason);
        return Array.isArray(handles) ? values : values[0];
      },
      budget: {
        total: async () => jobs.budget.total ?? null,
        spent: async () => jobs.spent(),
        remaining: async () => jobs.budget.total === undefined ? null : Math.max(0, jobs.budget.total - jobs.spent()),
      },
      tools,
      sleep: (milliseconds: number) => new Promise((resolve) => { const t = setTimeout(() => { this.timers.delete(t); resolve(undefined); }, Math.max(0, Number(milliseconds) || 0)); this.timers.add(t); }),
      setTimeout: (fn: (...a: any[]) => unknown, delay?: number, ...args: any[]) => { const t = setTimeout(() => { this.timers.delete(t); guard(fn)(...args); }, delay); this.timers.add(t); return t; },
      setInterval: (fn: (...a: any[]) => unknown, delay?: number, ...args: any[]) => { const t = setInterval(guard(fn), delay, ...args); this.timers.add(t); return t; },
      clearTimeout: (t: ReturnType<typeof setTimeout>) => { this.timers.delete(t); clearTimeout(t); },
      clearInterval: (t: ReturnType<typeof setInterval>) => { this.timers.delete(t); clearInterval(t); },
      structuredClone, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal, atob, btoa,
    };
  }

  /** Compiles a cell, preferring the persistent rewrite; falls back to an untransformed async body. */
  private compile(code: string, n: number): { script: vm.Script; returnsValue: boolean; note?: string } {
    const filename = `cell-${n}.js`;
    for (const returnLast of [true, false]) {
      try {
        const t = transformCell(code, returnLast);
        return { script: new vm.Script(wrapCell(t.body, t.prelude), { filename }), returnsValue: t.returnsValue };
      } catch (error) { if (!(error instanceof SyntaxError) && (error as Error)?.name !== "SyntaxError") throw error; }
    }
    // Throws the code's own syntax error when it is not valid either.
    const script = new vm.Script(wrapCell(code), { filename });
    return { script, returnsValue: false, note: "This cell's top-level declarations stay local: the kernel could not rewrite them." };
  }

  async run(code: string, options: CellOptions = {}): Promise<CellResult> {
    const n = ++this.cells;
    const earlier = this.late.splice(0);
    const cell = { lines: earlier.length ? ["[earlier background output]", ...earlier, "[this cell]"] : [], size: 0, onOutput: options.onOutput };
    let compiled: ReturnType<Kernel["compile"]>;
    try { compiled = this.compile(code, n); }
    catch (error) { return { output: cell.lines.join("\n"), error: describeError(error) }; }
    this.active = cell; this.bridge = options.tools;
    let promise: Promise<unknown>;
    try { promise = Promise.resolve(compiled.script.runInContext(this.context, { timeout: this.hooks.syncTimeoutMs ?? SYNC_TIMEOUT_MS })); }
    catch (error) { promise = Promise.reject(error); }
    type Outcome = { kind: "value"; value: unknown } | { kind: "error"; error: unknown } | { kind: "timeout" | "aborted" | "user" };
    let timer: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined, onAbort: (() => void) | undefined;
    const outcome = await new Promise<Outcome>((resolve) => {
      promise.then((value) => resolve({ kind: "value", value }), (error) => resolve({ kind: "error", error }));
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
    const output = bounded(cell.lines.join("\n"), MAX_OUTPUT);
    if (outcome.kind === "value") return { output, value: compiled.returnsValue && outcome.value !== undefined ? bounded(show(outcome.value), 16_000) : undefined, note: compiled.note };
    if (outcome.kind === "error") return { output, error: describeError(outcome.error), note: compiled.note };
    // The cell keeps running; its later output and outcome surface in the next cell.
    promise.then((value) => { this.print(`[cell ${n} finished]${value === undefined ? "" : ` ${show(value)}`}`); },
      (error) => { this.print(`[cell ${n} failed] ${describeError(error)}`); });
    return { output, detached: outcome.kind, note: compiled.note };
  }
}
