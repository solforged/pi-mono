import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agents, childExtensions, createWorktree, piInvocation, type Task } from "../workflows/subagents.ts";
import { bounded, emptyUsage, type Usage } from "../workflows/process.ts";
import { resolveRole, type Config } from "../workflows/roles.ts";
import { atomicWrite, privateDir, readJson, saveJson, scopeRoot } from "../workflows/state.ts";
import { BlockGone, RexClient } from "./client.ts";
import { Channel } from "./channel.ts";
import { claimOwner, readOwner, isId, MAX_TASKS, VERSION, waitFor, text, validUsage, type ChildMessage, type Manifest, type Outcome, type Result } from "./protocol.ts";
export { validateReady, waitFor } from "./protocol.ts";

/** Thrown into a wait when the user queues a message; the child's work continues. */
export class UserWaiting extends Error { constructor() { super("The user queued a message"); } }

/**
 * Waits like `wait(signal)`, but gives the turn back to the user: input queued
 * during the wait ends it with `undefined`. Input already queued when the wait
 * starts (e.g. a follow-up for the end of the run) does not, so a parent cannot
 * loop on it. Cancellation still rejects.
 */
export async function yieldingWait<T>(wait: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, pending?: () => boolean, pollMs = 250): Promise<T | undefined> {
  if (!pending) return wait(signal);
  const user = new AbortController(), already = pending();
  const poll = setInterval(() => { if (!already && pending()) user.abort(new UserWaiting()); }, pollMs);
  try { return await wait(AbortSignal.any([signal, user.signal])); }
  catch (error) { if (user.signal.aborted && !signal.aborted) return undefined; throw error; }
  finally { clearInterval(poll); }
}

export interface Run {
  version: 2; id: string; name: string; parentSession: string; parentEntry: string | null; profile: string;
  dir: string; agent: Task["agent"]; owner: "managed" | "human" | "retired" | "unknown";
  status: "starting" | "idle" | "running" | "closed"; note?: string;
  cwd: string; worktree?: string; provider: string; model: string; rexSession: string; parentBlock: string;
  hostId: string; instanceId: string; block?: string; childSession?: string; sessionFile: string;
  taskIds: string[]; activeTask?: string;
  /** Layout intent: auto places in the deck/grid; background stays detached. */
  view?: "auto" | "background"; pinned?: number;
}
export interface TaskRun {
  id: string; childId: string; requestId: string; task: string; title?: string;
  /** Running cost reported by the child; the settled usage replaces it. */
  liveCost?: number; status: "starting" | "running" | Outcome;
  text: string; usage: Usage; usageKnown: boolean; started: number; elapsedMs: number; resultFile: string;
  collected: boolean; notified: boolean; background: boolean;
}
export type RexBackend = Pick<RexClient, "probe" | "create" | "show" | "hide" | "close" | "peek" | "minimize" | "keep" | "toggle">;
interface Live {
  run: Run; manifest: Manifest; channel: Channel; controlDir: string;
  ready: boolean; transferring: boolean; closing?: Promise<void>; launchError?: Error;
  timer?: ReturnType<typeof setTimeout>; pending?: ReturnType<typeof Promise.withResolvers<TaskRun>>;
  tasks: Map<string, Promise<TaskRun>>;
}
/** Short, distinct, pronounceable defaults; enough for the 14-child upper bound and then some. */
export const NAMES = ["birch", "cedar", "fern", "oak", "ash", "elm", "pine", "moss", "reed", "sage", "ivy", "hazel", "rowan", "alder",
  "aspen", "larch", "maple", "willow", "juniper", "laurel", "myrtle", "poplar", "spruce", "yew"];
export const NAME = /^[a-z][a-z0-9-]{1,15}$/;
/** Short, single-line pane/roster titles; control characters never reach Rex labels. */
export const cleanTitle = (title: string) => title.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim().slice(0, 60);
export function childCommand(manifest: Manifest, agentDir: string, profile: string, extension: string, extensions: string[]): string[] {
  const invocation = piInvocation([
    "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
    "--session", join(manifest.dir, "session.jsonl"),
    "--provider", manifest.role.provider, "--model", `${manifest.role.provider}/${manifest.role.model}`, "--thinking", manifest.role.thinking,
    ...extensions.flatMap(file => ["-e", file]), "-e", extension,
    "--tools", manifest.tools.join(","), "--append-system-prompt", join(manifest.dir, "instructions.md"),
  ]);
  return ["/usr/bin/env", "-u", "PI_SESSION_ID", "-u", "PI_SESSION_FILE", "-u", "PI_PROVIDER", "-u", "PI_MODEL", "-u", "PI_REASONING_LEVEL",
    // Rex starts blocks with its server's environment. Carry the parent's PATH so
    // the child finds the same fd/rg/tooling (offline mode cannot download them).
    ...(process.env.PATH ? [`PATH=${process.env.PATH}`] : []),
    `PI_CODING_AGENT_DIR=${agentDir}`, `PI_WORKFLOW_PROFILE=${profile}`, `PI_REX_CHILD=${join(manifest.dir, "child.json")}`,
    invocation.command, ...invocation.args];
}
export class RexRunner {
  readonly runs = new Map<string, Run>();
  readonly tasks = new Map<string, TaskRun>();
  private live = new Map<string, Live>();
  private starting = new Map<AbortController, ReturnType<typeof Promise.withResolvers<void>>>();
  private stopped = false;
  private writes = new Map<string, Promise<void>>();
  readonly pi: Pick<ExtensionAPI, "getAllTools">;
  readonly root: string;
  readonly agentDir: string;
  readonly rex: RexBackend;
  onChange: () => void = () => {};
  onResult: (task: TaskRun) => void = () => {};
  constructor(pi: Pick<ExtensionAPI, "getAllTools">, root: string, agentDir: string, rex: RexBackend = new RexClient()) {
    this.pi = pi; this.root = root; this.agentDir = agentDir; this.rex = rex;
  }
  private persist(file: string, value: object) {
    const write = (this.writes.get(file) ?? Promise.resolve()).catch(() => {}).then(() => saveJson(file, value));
    this.writes.set(file, write);
    void write.finally(() => { if (this.writes.get(file) === write) this.writes.delete(file); }).catch(() => {});
    return write;
  }
  private save(run: Run) { return this.persist(join(run.dir, "run.json"), run); }
  private saveTask(task: TaskRun) { return this.persist(join(this.runs.get(task.childId)!.dir, "tasks", task.id, "task.json"), task); }
  private async recoveredResult(run: Run, task: TaskRun, outputBytes = 50000) {
    try {
      const result = await readJson<Result | null>(join(run.dir, "tasks", task.id, "result.json"), null);
      if (result?.id === run.id && result.taskId === task.id && ["succeeded", "failed", "cancelled"].includes(result.status)
        && text(result.text, 8 * 1024 * 1024) && validUsage(result.usage)) return { ...result, text: bounded(result.text, outputBytes) };
    } catch { /* Invalid or incomplete receipts are not replayed. */ }
  }
  private async claimClose(run: Run) {
    if (await claimOwner(run.dir, run.id, "closing")) return true;
    run.owner = await readOwner(run.dir, run.id) === "human" ? "human" : "unknown";
    run.note = "Ownership changed or is unresolved; terminal preserved. Inspect it in Rex.";
    await this.save(run); return false;
  }
  /** Names are unique within this parent session, including retired children. */
  private allocateName(requested?: string) {
    const taken = new Set([...this.runs.values()].map(r => r.name));
    if (requested !== undefined) {
      if (!NAME.test(requested)) throw new Error("Child names use 2–16 lowercase letters, digits or hyphens, starting with a letter");
      if (taken.has(requested)) throw new Error(`A child named ${requested} already exists in this session`);
      return requested;
    }
    const free = NAMES.find(n => !taken.has(n));
    if (free) return free;
    for (let i = 2; ; i++) for (const n of NAMES) if (!taken.has(`${n}-${i}`)) return `${n}-${i}`;
  }
  /** Resolve a child by exact name, else by unambiguous ID prefix. */
  child(ref: string): Run {
    const byName = [...this.runs.values()].find(r => r.name === ref);
    if (byName) return byName;
    const matches = ref.length >= 4 ? [...this.runs.values()].filter(r => r.id.startsWith(ref)) : [];
    if (matches.length !== 1) throw new Error(`No child named ${JSON.stringify(ref)}; use a name from /agents`);
    return matches[0];
  }
  private waiters = new Set<() => void>();
  private finished: string[] = []; // Completion order; restored results sort first by time.
  /** The oldest finished, uncollected task; otherwise wait for the next one to finish. */
  /** Finished, unread results in completion order. */
  ready(): TaskRun[] {
    return [...this.tasks.values()].filter(t => !["starting", "running"].includes(t.status) && !t.collected)
      .sort((a, b) => this.finished.indexOf(a.id) - this.finished.indexOf(b.id) || (a.started + a.elapsedMs) - (b.started + b.elapsedMs));
  }
  async next(signal: AbortSignal): Promise<TaskRun> {
    for (;;) {
      const done = this.ready();
      if (done.length) return done[0];
      if (![...this.tasks.values()].some(t => ["starting", "running"].includes(t.status) && this.live.get(t.childId)?.tasks.has(t.id))) throw new Error("No Rex tasks are running and every result has been read");
      const woke = Promise.withResolvers<void>(), wake = () => woke.resolve();
      this.waiters.add(wake);
      try { await waitFor(woke.promise, signal); } finally { this.waiters.delete(wake); }
    }
  }
  private managed(id: string) {
    const live = this.live.get(id);
    if (this.stopped || !live?.ready || live.run.owner !== "managed" || live.transferring || live.closing) throw new Error("Child is not available for parent-directed work");
    return live;
  }
  async open(agent: Task["agent"], config: Config, ctx: ExtensionContext, instructions: string, signal: AbortSignal,
    announce: (run: Run) => void = () => {}, title = "", requestedName?: string): Promise<Run> {
    if (this.stopped || ctx.mode !== "tui" || process.env.PI_REX_CHILD) throw new Error("Rex delegation requires a live parent interactive Pi session");
    if (!Object.hasOwn(agents, agent) || !text(instructions, 24000)) throw new Error("Invalid agent or oversized instructions");
    // Idle managed children occupy a slot too: their processes and context remain live.
    if (this.starting.size + [...this.live.values()].filter(l => l.ready && l.run.owner === "managed").length >= config.subagents.rexConcurrency) throw new Error(`Rex child limit (${config.subagents.rexConcurrency}, subagents.rexConcurrency) reached; reuse, take, or close an existing child`);
    const { role } = resolveRole(config, agents[agent].role, ctx.modelRegistry);
    const name = this.allocateName(requestedName);
    const session = process.env.REX_SESSION, parentBlock = process.env.REX_BLOCK;
    if (!session || !parentBlock) throw new Error("Missing Rex identity; no headless fallback");
    const controller = new AbortController();
    const launchDone = Promise.withResolvers<void>();
    this.starting.set(controller, launchDone);
    const launchSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(30_000)]);
    let run: Run | undefined, live: Live | undefined, controlDir: string | undefined;
    try {
      const identity = await this.rex.probe(session, parentBlock, launchSignal);
      const scope = await scopeRoot(this.agentDir, config.profile, ctx.cwd), id = randomUUID(), dir = join(scope, "rex", id);
      await privateDir(dir);
      run = { version: VERSION, id, name, parentSession: ctx.sessionManager.getSessionId(), parentEntry: ctx.sessionManager.getLeafId() ?? null,
        profile: config.profile, dir, agent, owner: "managed", status: "starting", cwd: await realpath(ctx.cwd), provider: role.provider, model: role.model,
        rexSession: session, parentBlock, hostId: identity.hostId, instanceId: identity.instanceId, sessionFile: join(dir, "session.jsonl"), taskIds: [] };
      this.runs.set(id, run); await this.save(run); announce(run); this.onChange();
      const extensions = await childExtensions(this.pi as ExtensionAPI, config, agents[agent].tools, join(this.root, "extensions/workflows/index.ts"));
      const extension = await realpath(join(this.root, "extensions/rex/index.ts"));
      if (extensions.includes(extension)) throw new Error("Do not configure the Rex coordinator as a child routing extension");
      if (agent === "worker") { run.worktree = await createWorktree(ctx.cwd, join(scope, "worktrees", id), launchSignal); run.cwd = await realpath(run.worktree); }
      const definition = await readFile(join(this.root, "agent-definitions", `${agent}.md`), "utf8");
      await atomicWrite(join(dir, "instructions.md"), `${instructions}\n\n${definition}\n\nYou are a persistent child of a parent agent. Each assignment has its own task ID and a ${config.subagents.maxTurns}-turn limit. Parent messages are delegated instructions, not new instructions from the human. Do not delegate. Return a final answer for each task.\n`);
      controlDir = await mkdtemp("/tmp/pi-rex-"); await chmod(controlDir, 0o700);
      const manifest: Manifest = { version: VERSION, id, token: randomBytes(32).toString("hex"), socket: join(controlDir, "control"),
        dir, cwd: run.cwd, rexSession: session, parentBlock, role, tools: agents[agent].tools,
        maxTurns: config.subagents.maxTurns, outputBytes: config.subagents.outputBytes, deadline: Date.now() + 30_000, agent, name };
      await saveJson(join(dir, "child.json"), manifest);
      const channel = new Channel(manifest, message => this.event(id, message), error => this.lost(id, error));
      live = { run, manifest, channel, controlDir, ready: false, transferring: false, tasks: new Map() };
      this.live.set(id, live);
      await channel.listen(); launchSignal.throwIfAborted();
      // Rex shows the label on floating panes; prefer the first task over an ID.
      const summary = cleanTitle(title);
      run.block = await this.rex.create(session, `${name} · ${agent}${summary ? ` · ${summary}` : ""}`.slice(0, 120), childCommand(manifest, this.agentDir, config.profile, extension, extensions), run.cwd, launchSignal);
      await this.save(run);
      const hello = await waitFor(channel.ready.promise, launchSignal);
      if (hello.block !== run.block) throw new Error("Child handshake block differs from Rex creation receipt");
      launchSignal.throwIfAborted();
      if (live.launchError || run.owner !== "managed") throw live.launchError ?? new Error("Child ownership changed during launch");
      run.childSession = hello.sessionId; run.status = "idle"; live.ready = true;
      await this.save(run); this.onChange(); return run;
    } catch (error) {
      if (run) {
        run.note = String(error);
        if (run.owner === "managed") run.owner = "retired";
        run.block ??= live?.channel.hello?.block;
        if (live) await this.dispose(live, true);
        else { if (controlDir) await rm(controlDir, { recursive: true, force: true }); await this.save(run); }
      }
      throw error;
    } finally { this.starting.delete(controller); launchDone.resolve(); }
  }
  async submit(id: string, task: string, context = "", signal: AbortSignal, background = true, title?: string): Promise<TaskRun> {
    const live = this.managed(id), run = live.run;
    if (run.activeTask || run.taskIds.length >= MAX_TASKS) throw new Error("Child is busy or its task limit was reached");
    if (!text(task, 16000) || !task.trim() || !text(context, 16000)) throw new Error("Invalid task/context");
    signal.throwIfAborted();
    const taskId = randomUUID(), requestId = randomUUID(), started = Date.now();
    const item: TaskRun = { id: taskId, childId: id, requestId, task, ...(title ? { title: cleanTitle(title) } : {}), status: "starting", text: "", usage: emptyUsage(), usageKnown: false, started,
      elapsedMs: 0, resultFile: join(run.dir, "tasks", taskId, "result.json"), collected: false, notified: false, background };
    run.activeTask = taskId; run.taskIds.push(taskId); run.status = "running";
    this.tasks.set(taskId, item);
    live.pending = Promise.withResolvers<TaskRun>(); live.tasks.set(taskId, live.pending.promise);
    this.onChange();
    try {
      await this.saveTask(item); await this.save(run);
      this.managed(id); signal.throwIfAborted();
      live.timer = setTimeout(() => { void this.cancel(id, "Task deadline exceeded").catch(() => {}); }, live.manifest.role.timeoutMs);
      live.timer.unref();
      await live.channel.request({ type: "dispatch", id, requestId, taskId, task, context, deadline: started + live.manifest.role.timeoutMs },
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
      return item;
    } catch (error) {
      // An unacknowledged dispatch may have executed. Never replay it or reuse the
      // child until it is stopped; preserve an in-flight human takeover instead.
      await this.lost(id, new Error(`Dispatch not confirmed: ${String(error)}`));
      throw error;
    }
  }
  private async event(id: string, message: ChildMessage) {
    const live = this.live.get(id);
    if (!live) return;
    const run = live.run;
    if (message.type === "ownership") {
      run.owner = "human"; live.transferring = true;
      if (run.activeTask) await this.complete(live, "cancelled", "Ownership transferred; no further parent-directed work");
      await this.save(run); this.onChange();
      // Let the channel deliver the ownership receipt before closing it.
      setTimeout(() => { void this.dispose(live, false); }, 0).unref();
      return;
    }
    if (message.type === "retired") { await this.lost(id, new Error(message.text)); return; }
    if (message.type === "ready" || message.type === "ack" || message.type === "error") return;
    if (message.type === "accepted") {
      const task = this.tasks.get(message.taskId!);
      if (!task || run.activeTask !== task.id || task.requestId !== message.requestId) throw new Error("Unexpected task acceptance");
      task.status = "running"; await this.saveTask(task); this.onChange(); return;
    }
    if (message.type === "progress") {
      if (run.activeTask === message.taskId) {
        run.note = message.text;
        const task = this.tasks.get(message.taskId);
        if (task && typeof message.cost === "number") task.liveCost = message.cost;
        this.onChange();
      }
      return;
    }
    const task = this.tasks.get(message.taskId);
    if (!task || run.activeTask !== task.id || (message.status === "succeeded" && task.status !== "running")) throw new Error("Result does not belong to the active accepted task");
    await this.complete(live, message.status, message.text, message.usage);
  }
  private async complete(live: Live, outcome: Outcome, answer: string, usage?: Usage) {
    const run = live.run, task = this.tasks.get(run.activeTask!);
    if (!task || !["starting", "running"].includes(task.status)) return;
    task.status = outcome; task.text = answer; task.elapsedMs = Date.now() - task.started;
    if (usage) { task.usage = usage; task.usageKnown = true; }
    if (live.timer) clearTimeout(live.timer);
    const pending = live.pending;
    live.pending = undefined; run.activeTask = undefined; run.status = "idle"; run.note = undefined;
    try { await this.saveTask(task); await this.save(run); }
    finally {
      this.finished.push(task.id);
      pending?.resolve(task); this.onChange();
      for (const wake of this.waiters) wake();
    }
    if (!this.stopped) this.onResult(task);
  }
  private async lost(id: string, error: Error) {
    const live = this.live.get(id);
    if (!live || live.closing) return;
    if (!live.ready) { live.launchError = error; return; }
    const run = live.run;
    run.note = error.message;
    if (run.owner !== "human") run.owner = live.transferring ? "unknown" : "retired";
    const task = this.tasks.get(run.activeTask!);
    const receipt = task && await this.recoveredResult(run, task, live.manifest.outputBytes);
    await this.complete(live, receipt?.status ?? "failed", receipt?.text ?? `${error.message}. Usage is unknown; inspect retained files.`, receipt?.usage);
    await this.dispose(live, run.owner === "retired");
  }
  async wait(taskId: string, signal: AbortSignal): Promise<TaskRun> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("Unknown task ID");
    const promise = this.live.get(task.childId)?.tasks.get(taskId);
    if (!["starting", "running"].includes(task.status)) return promise ? waitFor(promise, signal) : task;
    if (!promise) throw new Error("Task has no live coordinator; no replay");
    return waitFor(promise, signal); // Cancelling a wait does not cancel a background task.
  }
  async steer(id: string, taskId: string, message: string, signal: AbortSignal) {
    const live = this.managed(id);
    if (live.run.activeTask !== taskId || !text(message, 16000) || !message.trim()) throw new Error("Invalid message or task is no longer active");
    await live.channel.request({ type: "steer", id, taskId, requestId: randomUUID(), text: message }, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
  }
  async cancel(id: string, reason = "Cancelled by user") {
    const live = this.managed(id), taskId = live.run.activeTask;
    if (!taskId) throw new Error("Child has no active task");
    const pending = live.tasks.get(taskId)!;
    try {
      await live.channel.request({ type: "cancel", id, taskId, requestId: randomUUID() }, AbortSignal.timeout(2000));
      await waitFor(pending, AbortSignal.timeout(3000));
    } catch {
      if (live.run.owner === "human" || live.transferring || live.run.activeTask !== taskId) return;
      live.run.owner = "retired";
      await this.complete(live, "cancelled", `${reason}; child did not settle within the cancellation grace period`);
      await this.dispose(live, true);
    }
  }
  async take(id: string) {
    const live = this.managed(id);
    if (live.run.activeTask) throw new Error("Finish or cancel the current task before taking control");
    live.transferring = true;
    try {
      await live.channel.request({ type: "take", id, requestId: randomUUID() }, AbortSignal.timeout(5000));
      if (live.run.owner !== "human") throw new Error("Ownership transfer was not confirmed");
    } catch (error) {
      // Ambiguous transfer is protected from automatic killing or redispatch.
      live.run.owner = "unknown"; live.run.note = `Takeover not confirmed: ${String(error)}. Inspect the child; no automatic retry.`;
      throw error;
    } finally { await this.save(live.run); await this.dispose(live, false); this.onChange(); }
  }
  private async dispose(live: Live, close: boolean): Promise<void> {
    if (live.closing) return live.closing;
    live.closing = (async () => {
      if (live.timer) clearTimeout(live.timer);
      try {
        // The exclusive claim precedes disconnect and any destructive action.
        // A concurrent child /take wins or loses the same claim atomically.
        const mayClose = close && !live.transferring && !["human", "unknown"].includes(live.run.owner) && await this.claimClose(live.run);
        if (live.run.owner === "retired") { try { live.channel.send({ type: "retire", id: live.run.id }); } catch {} }
        await live.channel.close();
        if (mayClose && live.run.block) {
          try { await this.rex.close(live.run.rexSession, live.run.block, AbortSignal.timeout(10_000)); live.run.status = "closed"; }
          catch (error) {
            if (error instanceof BlockGone) { live.run.status = "closed"; live.run.note = "Terminal was already closed"; }
            else live.run.note = `Terminal cleanup needs attention: ${String(error)}`;
          }
        }
        await this.save(live.run);
      } finally {
        this.live.delete(live.run.id);
        await rm(live.controlDir, { recursive: true, force: true });
        this.onChange();
      }
    })();
    return live.closing;
  }
  async shutdown() {
    this.stopped = true;
    for (const controller of this.starting.keys()) controller.abort(new Error("Parent session closed"));
    await Promise.allSettled([...this.starting.values()].map(done => done.promise));
    await Promise.allSettled([...this.live.values()].map(async live => {
      const busy = !!live.run.activeTask;
      if (live.run.owner === "managed" && !live.transferring) {
        live.run.owner = "retired";
        try { live.channel.send({ type: "retire", id: live.run.id }); } catch {}
        if (busy) await this.complete(live, "cancelled", "Parent session closed or reloaded");
      }
      await this.dispose(live, busy && !live.transferring);
    }));
  }
  async action(run: Run, action: "show" | "peek" | "hide" | "park" | "keep" | "close" | "toggle"): Promise<string | void> {
    if (!run.block || run.status === "closed") throw new Error("No retained Rex block for this child");
    const signal = AbortSignal.timeout(20_000);
    const identity = await this.rex.probe(run.rexSession, run.parentBlock, signal);
    if (identity.hostId !== run.hostId || identity.instanceId !== run.instanceId) throw new Error("Rex server changed; refusing stale block control");
    if (action === "close") {
      if (["human", "unknown"].includes(run.owner)) throw new Error("This child is no longer parent-owned; close it in Rex");
      const live = this.live.get(run.id);
      if (live?.transferring) throw new Error("Ownership transfer is in progress");
      if (live) {
        run.owner = "retired"; await this.complete(live, "cancelled", "Terminal closed by user"); await this.dispose(live, true);
      } else if (await this.claimClose(run)) { await this.rex.close(run.rexSession, run.block, signal); run.status = "closed"; await this.save(run); }
      if (run.status !== "closed") throw new Error(run.note ?? "Terminal closure was not confirmed");
    } else if (action === "show" || action === "peek") await this.rex.peek(run.rexSession, run.block, run.parentBlock, signal);
    else if (action === "toggle") return this.rex.toggle(run.rexSession, run.block, run.parentBlock, signal);
    else if (action === "hide") await this.rex.minimize(run.rexSession, run.block, signal);
    else if (action === "keep") await this.rex.keep(run.rexSession, run.block, run.parentBlock, signal);
    else await this.rex.hide(run.rexSession, run.block, signal);
  }
  /**
   * Parent-directed close: only an idle child the parent still manages, after
   * every result has been read. Human-owned, retired and transferring children
   * are refused (by `managed`); files, session and worktree are retained.
   */
  async closeIdle(id: string) {
    const run = this.managed(id).run;
    if (run.activeTask) throw new Error(`${run.name} is working; wait for its result or cancel the task first`);
    const unread = run.taskIds.filter(taskId => { const task = this.tasks.get(taskId); return task && !task.collected; });
    if (unread.length) throw new Error(`${run.name} has ${unread.length} unread result(s); read them with rex_result first`);
    await this.action(run, "close");
  }
  /** Persist presentation intent (view/pin); policy fields are not changed here. */
  async update(run: Run) { await this.save(run); this.onChange(); }
  /** A blocking wait was given up: report the task's completion like background work. */
  async background(task: TaskRun) {
    if (task.background) return;
    task.background = true; await this.saveTask(task);
    if (!["starting", "running"].includes(task.status)) this.onResult(task);
  }
  async markNotified(task: TaskRun) { task.notified = true; await this.saveTask(task); }
  async collect(taskId: string): Promise<Usage | undefined> {
    const task = this.tasks.get(taskId);
    if (!task || ["starting", "running"].includes(task.status) || task.collected) return;
    task.collected = true; // Reserve synchronously against concurrent result readers.
    try { await this.saveTask(task); } catch (error) { task.collected = false; throw error; }
    return task.usageKnown ? task.usage : undefined;
  }
  async restore(ids: Array<{ id: string; profile: string }>, ctx: ExtensionContext) {
    for (const ref of ids) {
      if (!isId(ref.id) || !/^[a-z][a-z0-9-]{0,31}$/.test(ref.profile)) continue;
      const dir = join(await scopeRoot(this.agentDir, ref.profile, ctx.cwd), "rex", ref.id);
      const run = await readJson<Run | null>(join(dir, "run.json"), null);
      if (!run || run.version !== VERSION || run.id !== ref.id || run.dir !== dir || run.parentSession !== ctx.sessionManager.getSessionId()
        || run.block === run.parentBlock || !Array.isArray(run.taskIds) || run.taskIds.length > MAX_TASKS) continue;
      if (typeof run.name !== "string" || !NAME.test(run.name) || [...this.runs.values()].some(r => r.name === run.name)) run.name = run.id.slice(0, 8).replace(/^[0-9]/, "c");
      const owner = await readOwner(dir, run.id);
      if (owner === "human" || owner === "unknown") run.owner = owner;
      else if (run.owner === "managed") run.owner = "retired";
      this.runs.set(run.id, run);
      for (const id of run.taskIds.filter(isId)) {
        const task = await readJson<TaskRun | null>(join(dir, "tasks", id, "task.json"), null);
        if (!task || task.id !== id || task.childId !== run.id) continue;
        if (["starting", "running"].includes(task.status)) {
          const receipt = await this.recoveredResult(run, task);
          task.status = receipt?.status ?? "failed"; task.text = receipt?.text ?? "Previous coordinator stopped; no task replay. Usage is unknown; inspect retained files.";
          if (receipt) { task.usage = receipt.usage; task.usageKnown = true; }
        }
        this.tasks.set(id, task);
      }
      run.activeTask = undefined;
      if (run.status !== "closed") run.status = "idle";
    }
  }
}
