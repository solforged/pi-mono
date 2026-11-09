import { connect, type Socket } from "node:net";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addUsage, bounded, emptyUsage } from "../workflows/process.ts";
import { privateDir, saveJson } from "../workflows/state.ts";
import { claimOwner, readOwner, Frames, isId, LEASE_MS, MAX_MESSAGES, MAX_TASKS, record, send, taskPrompt, text, validateManifest, VERSION, type Manifest, type Outcome } from "./protocol.ts";

export class ChildState {
  active = false;
  finished = false;
  turns = 0;
  messages = 0;
  usage = emptyUsage();
  last?: { text: string; stopReason: string; errorMessage?: string };
  failure?: string;
  cancelled?: string;
  settling = false;
  readonly manifest: Manifest;
  constructor(manifest: Manifest) { this.manifest = manifest; }
  message(message: any) {
    if (!this.active || this.finished) return;
    if (message.role === "assistant") {
      addUsage(this.usage, message.usage);
      if (message.provider !== this.manifest.role.provider || message.model !== this.manifest.role.model) this.failure = "Child used an unexpected model";
      this.last = { text: (message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"),
        stopReason: message.stopReason, errorMessage: message.errorMessage };
    } else if (message.role === "toolResult") addUsage(this.usage, message.usage);
  }
  settled(aborted: boolean): { status: Outcome; text: string } {
    if (this.failure) return { status: "failed", text: this.failure };
    if (this.cancelled || aborted) return { status: "cancelled", text: this.cancelled || "Child task cancelled" };
    if (this.last?.stopReason !== "stop" || !this.last.text.trim()) return { status: "failed", text: this.last?.errorMessage || `Child settled without a final answer (${this.last?.stopReason ?? "no response"})` };
    return { status: "succeeded", text: this.last.text };
  }
}

/** Managed tasks share a Pi session, but never share task IDs, budgets or results. */
export function registerChild(pi: ExtensionAPI, manifestPath: string, onReady: (ctx: ExtensionContext, manifest: Manifest) => void = () => {}) {
  let manifest: Manifest | undefined, ctx: ExtensionContext | undefined, socket: Socket | undefined;
  let owner: "managed" | "human" | "retired" | "transferring" = "retired";
  let current: { id: string; deadline: number; state: ChildState } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined, lastPing = Date.now(), seq = 0, tasks = 0;
  let shuttingDown = false, allowedInput: string | undefined, queue = Promise.resolve();
  const emit = (value: object) => { if (socket && !socket.destroyed) send(socket, { id: manifest!.id, seq: ++seq, ...value }); };
  const status = () => ctx?.ui.setStatus("rex-child", owner === "human" ? "Human control · role tools retained"
    : owner === "managed" ? current ? "Managed task · /take when idle" : "Ready for follow-up · /take for human control" : "Disconnected · inspection only · /take for human control");
  const finish = async (aborted: boolean) => {
    if (!current || current.state.finished) return;
    const task = current;
    task.state.finished = true; task.state.active = false;
    const result = task.state.settled(aborted);
    await saveJson(join(manifest!.dir, "tasks", task.id, "result.json"), { id: manifest!.id, taskId: task.id, ...result, usage: task.state.usage });
    current = undefined; allowedInput = undefined;
    emit({ type: "result", taskId: task.id, ...result, text: bounded(result.text, manifest!.outputBytes), usage: task.state.usage });
    status();
  };
  const retire = async (reason: string, shutdown = false) => {
    if (owner === "human" || owner === "transferring") return;
    owner = "retired";
    if (timer) clearInterval(timer);
    if (current) {
      current.state.cancelled = reason;
      ctx?.abort();
      if (ctx?.isIdle()) await finish(true);
    }
    status();
    try { emit({ type: "retired", text: bounded(reason, 1000) }); } catch { /* Broken transport. */ }
    if (shutdown) ctx?.shutdown();
  };
  const enqueue = (fn: () => Promise<void>) => {
    const result = queue.then(fn);
    queue = result.catch(async error => { await retire(String(error), true).catch(() => {}); });
    return result;
  };
  const take = async (requestId?: string) => {
    if (!manifest || owner === "transferring" || owner === "human") throw new Error("Child ownership is unavailable or already transferred");
    if (current || !ctx!.isIdle()) throw new Error("Cancel or finish the current task before taking control");
    owner = "transferring"; // Disarm lease/parent cleanup before making the transfer durable.
    try { if (!await claimOwner(manifest.dir, manifest.id, "human")) throw new Error("Terminal closure or another ownership transition has already been claimed"); }
    catch (error) { owner = "retired"; throw error; }
    owner = "human";
    if (timer) clearInterval(timer);
    status();
    emit({ type: "ownership", owner: "human", ...(requestId ? { requestId } : {}) });
    socket?.end();
  };
  pi.registerCommand("take", {
    description: "Take human control of this idle Rex child; retain its role tools and routing",
    handler: async (_args, context) => {
      // This is a human command, never exposed as a model tool.
      if (current || !context.isIdle()) { context.ui.notify("Finish the task or press Escape first, then /take.", "warning"); return; }
      await enqueue(() => take());
      context.ui.notify("You now control this session. The parent will not send work or close it automatically.", "info");
    },
  });
  pi.on("input", (event, context) => {
    if (owner === "human") return { action: "continue" };
    if (owner === "managed" && current?.state.active && !current.state.cancelled && event.source === "extension" && event.text === allowedInput) {
      allowedInput = undefined;
      if (context.model?.provider === manifest!.role.provider && context.model.id === manifest!.role.model) return { action: "continue" };
    }
    context.ui.notify("Managed child: use parent messages, or /take when idle. Approvals remain available here.", "warning");
    return { action: "handled" };
  });
  pi.on("before_agent_start", (_event, context) => {
    if (owner === "human") return;
    if (owner !== "managed" || !current?.state.active || current.state.cancelled
      || context.model?.provider !== manifest?.role.provider || context.model?.id !== manifest?.role.model) {
      context.abort(); throw new Error("Rex child is not authorized to start a run");
    }
    pi.setActiveTools(manifest!.tools);
  });
  pi.on("tool_call", event => {
    if (!manifest?.tools.includes(event.toolName) || (owner !== "human" && (owner !== "managed" || !current?.state.active
      || current.state.cancelled || current.state.turns >= manifest.maxTurns))) {
      if (current && !current.state.cancelled) current.state.failure = "Child tool or turn limit reached";
      return { block: true, terminate: true, reason: "Rex child tool or turn limit reached" };
    }
  });
  pi.on("turn_start", (_event, context) => {
    if (owner !== "human" && current && ++current.state.turns > manifest!.maxTurns) { current.state.failure = "Child turn limit reached"; context.abort(); }
  });
  pi.on("model_select", (_event, context) => {
    if (owner === "managed" && current && (context.model?.provider !== manifest!.role.provider || context.model?.id !== manifest!.role.model)) {
      current.state.failure = "Model changed during delegated work"; context.abort();
    }
  });
  pi.on("user_bash", () => {
    if (owner !== "human" || !manifest?.tools.includes("bash")) throw new Error("Manual shell commands require human ownership and a worker role");
  });
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"] as const) pi.on(event, () => owner !== "human" ? { cancel: true } : undefined);
  pi.on("session_before_compact", event => {
    if (owner !== "human" && (!current?.state.active || event.reason === "manual")) return { cancel: true };
  });
  pi.on("cache_warming_decision", () => owner !== "human" ? { action: "stop" } : undefined);
  pi.on("message_end", event => current?.state.message(event.message));
  pi.on("session_compact", event => { if (current?.state.active) addUsage(current.state.usage, event.compactionEntry.usage); });
  const progress = (message: string) => { if (current) emit({ type: "progress", taskId: current.id, text: bounded(message, 500) }); };
  pi.on("agent_start", () => progress("Running"));
  pi.on("tool_execution_start", event => progress(event.toolName));
  pi.on("ui_prompt_start", event => progress(`Waiting for user: ${event.title ?? event.kind}`));
  pi.on("ui_prompt_end", () => progress("Running"));
  pi.on("agent_settled", event => {
    if (current) current.state.settling = true;
    return enqueue(() => finish(event.aborted));
  });

  async function command(value: unknown) {
    const m = manifest!, message = record(value);
    if (message.id !== m.id) throw new Error("Wrong child ID");
    if (message.type === "ping") { lastPing = Date.now(); return; }
    if (message.type === "retire") { await retire("Parent session closed", !!current); return; }
    if (!isId(message.requestId)) throw new Error("Invalid request ID");
    try {
      if (owner !== "managed") throw new Error("Child is not parent-owned");
      if (message.type === "take") { await take(message.requestId); return; }
      if (!isId(message.taskId)) throw new Error("Invalid task ID");
      if (message.type === "dispatch") {
        if (current || !ctx!.isIdle()) throw new Error("Child is busy; wait for the current task result");
        if (tasks >= MAX_TASKS || !text(message.task, 16000) || !message.task.trim() || !text(message.context, 16000)
          || !Number.isFinite(message.deadline) || message.deadline <= Date.now() || message.deadline > Date.now() + m.role.timeoutMs + 1000) throw new Error("Invalid task or task limit reached");
        if (ctx!.model?.provider !== m.role.provider || ctx!.model?.id !== m.role.model) throw new Error("Requested model is no longer selected");
        const dir = join(m.dir, "tasks", message.taskId);
        await privateDir(dir);
        await writeFile(join(dir, "accepted.json"), JSON.stringify(message), { flag: "wx", mode: 0o600 });
        tasks++;
        current = { id: message.taskId, deadline: message.deadline, state: new ChildState(m) };
        current.state.active = true;
        emit({ type: "accepted", requestId: message.requestId, taskId: current.id });
        allowedInput = taskPrompt(current.id, message.task, message.context);
        // The terminal title follows the current task (Rex shows it on the pane).
        pi.setSessionName(`${m.name ?? m.agent ?? "Rex"}: ${message.task.replace(/\s+/g, " ").trim().slice(0, 60)}`);
        pi.sendUserMessage(allowedInput, { expandPromptTemplates: false });
        status();
        return;
      }
      if (!current || current.id !== message.taskId || current.state.cancelled) throw new Error("Task is no longer active; message not delivered");
      if (message.type === "cancel") {
        current.state.cancelled = "Cancelled by parent";
        ctx!.abort();
        emit({ type: "ack", requestId: message.requestId, taskId: message.taskId });
        if (ctx!.isIdle()) await finish(true);
        return;
      }
      if (message.type !== "steer" || !text(message.text, 16000) || !message.text.trim() || current.state.messages >= MAX_MESSAGES || ctx!.isIdle()) throw new Error("Invalid steering message or task has already settled");
      const dir = join(m.dir, "tasks", current.id, "messages");
      await privateDir(dir);
      await writeFile(join(dir, `${message.requestId}.json`), JSON.stringify(message), { flag: "wx", mode: 0o600 });
      // Persistence yields to Pi lifecycle callbacks. Recheck at the actual
      // delivery boundary so a late steer cannot start another task.
      if (current.id !== message.taskId || current.state.cancelled || current.state.settling || ctx!.isIdle()) throw new Error("Task settled before delivery; message not sent");
      current.state.messages++;
      pi.sendMessage({ customType: "rex-parent", content: `Parent agent message for task ${current.id}:\n${message.text}`, display: true,
        details: { childId: m.id, taskId: current.id, requestId: message.requestId } }, { deliverAs: "steer", triggerTurn: true });
      emit({ type: "ack", requestId: message.requestId, taskId: current.id });
    } catch (error) { emit({ type: "error", requestId: message.requestId, text: bounded(String(error), 1800) }); }
  }
  pi.on("session_start", async (_event, context) => {
    ctx = context;
    try {
      if (ctx.mode !== "tui") throw new Error("Rex children require interactive Pi");
      const info = await stat(manifestPath);
      if ((info.mode & 0o077) !== 0 || info.size > 64 * 1024) throw new Error("Rex child manifest must be private and bounded");
      manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")), true);
      const m = manifest;
      const claim = await readOwner(m.dir, m.id);
      if (claim === "human") { owner = "human"; pi.setActiveTools(m.tools); status(); return; }
      if (claim !== "managed") throw new Error("Child closure or ownership transition is already claimed");
      if (m.deadline <= Date.now()) throw new Error("Expired child launch; use /take for human control");
      if (await realpath(ctx.cwd) !== m.cwd || process.env.REX_SESSION !== m.rexSession || !process.env.REX_BLOCK || process.env.REX_BLOCK === m.parentBlock) throw new Error("Child cwd or Rex identity mismatch");
      if (ctx.model?.provider !== m.role.provider || ctx.model.id !== m.role.model) throw new Error("Requested child model was not selected");
      if (!await pi.setModel({ ...ctx.model, maxTokens: Math.min(ctx.model.maxTokens, m.role.maxTokens) })) throw new Error("Child authentication is unavailable; no fallback allowed");
      pi.setActiveTools(m.tools);
      if (m.tools.some(t => !pi.getActiveTools().includes(t))) throw new Error("Child tool loadout is incomplete");
      // A runtime reload cannot reconnect, reset budgets or replay an old task.
      await writeFile(join(m.dir, "bridge.json"), JSON.stringify({ at: Date.now() }), { flag: "wx", mode: 0o600 });
      owner = "managed";
      if (!pi.getSessionName()) pi.setSessionName(`${m.name ?? m.agent ?? "Rex"} (waiting for task)`);
      status(); onReady(ctx, m);
      socket = connect(m.socket);
      const frames = new Frames();
      socket.on("error", () => { void enqueue(() => retire("Parent control channel failed", !!current)).catch(() => {}); });
      socket.on("close", () => { if (!shuttingDown) void enqueue(() => retire("Parent disconnected; no task replay", !!current)).catch(() => {}); });
      socket.on("connect", () => {
        try { send(socket!, { type: "ready", version: VERSION, id: m.id, token: m.token, block: process.env.REX_BLOCK, rexSession: process.env.REX_SESSION,
          cwd: m.cwd, provider: ctx!.model!.provider, model: ctx!.model!.id, sessionId: ctx!.sessionManager.getSessionId(), sessionFile: ctx!.sessionManager.getSessionFile(), tools: pi.getActiveTools() }); }
        catch (error) { void retire(String(error), true); }
      });
      socket.on("data", chunk => {
        try { frames.push(chunk, value => { void enqueue(() => command(value)).catch(() => {}); }); }
        catch (error) { void enqueue(() => retire(String(error), true)).catch(() => {}); }
      });
      timer = setInterval(() => {
        if (owner !== "managed") return;
        if (Date.now() - lastPing > LEASE_MS) { void enqueue(() => retire("Parent lease expired", !!current)).catch(() => {}); return; }
        if (current && Date.now() > current.deadline && !current.state.cancelled) {
          current.state.cancelled = "Task deadline expired"; ctx!.abort();
          if (ctx!.isIdle()) void enqueue(() => finish(true)).catch(() => {});
        }
      }, 1000);
      timer.unref();
    } catch (error) {
      owner = "retired"; status(); ctx.ui.notify(String(error), "error");
      // No reconnection or automatic prompt. A retained session can still be taken over.
    }
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    if (timer) clearInterval(timer);
    await enqueue(async () => { if (current) { current.state.cancelled = "Child session closed"; await finish(true); } }).catch(() => {});
    socket?.destroy();
  });
}
