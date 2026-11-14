import { realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { addUsage, bounded, emptyUsage, type Usage } from "../workflows/process.ts";
import { loadConfig, resolveRole } from "../workflows/roles.ts";
import { registerChildUi } from "./child-ui.ts";
import { RexRunner, yieldingWait, type Run, type TaskRun } from "./runner.ts";
import { RexClient } from "./client.ts";
import { GridManager, type LayoutState } from "./layout.ts";
import { instructionsText, print } from "../shared/context.ts";
import { atomicWrite } from "../shared/system.ts";
import { OPENED } from "./protocol.ts";
import { installLeftArrow } from "./left-editor.ts";
import { completionRenderer, toolRenderers, widget } from "./render.ts";
import { canUseRex, switchTools, TOOLS_ENTRY, withFollowUps } from "./tools.ts";
import { registerRexTitle, setTitlePrefix } from "./title.ts";
import { agentsTabLabel, MARKS, pickMark } from "./tabs.ts";
import { REX_WORKERS, type RexWorkersRequest } from "./workers.ts";

const str = () => Type.Optional(Type.String());
import { coalesce, fitResults, listLine, oneLine, priority, resultText, rows, shortId, SHORTCUT, taskMeta, urgency, waitingLine, type PickAction, type TaskMeta } from "./ui.ts";

export default async function (pi: ExtensionAPI) {
  registerRexTitle();
  if (process.env.PI_REX_CHILD) { registerChildUi(pi, process.env.PI_REX_CHILD); return; }
  const root = resolve(dirname(await realpath(fileURLToPath(import.meta.url))), "../..");
  const rex = new RexClient(), runner = new RexRunner(pi, root, getAgentDir(), rex), lifetime = new AbortController();
  let instructions = "", currentCtx: ExtensionContext | undefined, layout: GridManager | undefined;
  // This parent's colour, on its title and its children's panes and titles;
  // picked at the first child and kept with the session. The Agents tab stays plain.
  let mark: string | undefined, picking: Promise<string> | undefined;
  runner.markFor = (session, signal) => mark ? Promise.resolve(mark) : picking ??= (async () => {
    try {
      const labels = await rex.labels(session, signal);
      mark = pickMark(labels, currentCtx?.sessionManager.getSessionId() ?? session);
      pi.appendEntry("rex-mark", { mark });
      return mark;
    } finally { picking = undefined; }
  })();
  const running = (task: TaskRun) => ["starting", "running"].includes(task.status);
  // Model-facing listing: one line per child, latest tasks indented. Names are the handle.
  const list = () => bounded(rows(runner.runs.values(), runner.tasks).map(row => {
    const run = runner.runs.get(row.id)!;
    return `${listLine(row, run.owner)}\n${run.taskIds.slice(-3).map(id => {
      const task = runner.tasks.get(id); return `  task ${shortId(id)} · ${task?.status ?? "unknown"}${task ? ` · "${oneLine(task.task, 60)}"` : ""}`;
    }).join("\n")}`;
  }).join("\n") || "No Rex children in this session.", 16000);
  const describe = (task: TaskRun) => bounded(resultText(runner.runs.get(task.childId)!, task), 50000);
  const find = (ref: string) => runner.child(ref);
  const findTask = (prefix: string) => {
    const matches = [...runner.tasks.values()].filter(task => task.id.startsWith(prefix));
    if (!prefix || matches.length !== 1) throw new Error("Use an unambiguous task ID");
    return matches[0];
  };
  function checkBranch(run: Run, ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || run.parentSession !== ctx.sessionManager.getSessionId()
      || (run.parentEntry && !ctx.sessionManager.getBranch().some(e => e.id === run.parentEntry))) throw new Error("Child belongs to another session or branch");
  }
  // Activity, cost and progress change on every child tool call; only changes
  // that matter for placement re-plan the Agents tab.
  let layoutKey = "";
  const draw = () => {
    if (lifetime.signal.aborted || currentCtx?.mode !== "tui") return;
    const items = rows(runner.runs.values(), runner.tasks);
    currentCtx.ui.setWidget("rex-agents", items.length ? widget(items) : undefined);
    const kids = gridChildren();
    // Marked only while it has children, so other Pi tabs stay plain.
    setTitlePrefix(mark && kids.length ? mark : "");
    const key = JSON.stringify(kids);
    if (layout && key !== layoutKey) { layoutKey = key; layout.schedule(); }
  };
  // Children report every tool call and message. The first change draws at
  // once; those that follow shortly are drawn together.
  const onChange = coalesce(draw, 250);
  runner.onChange = onChange.call;
  const unread = (run: Run) => { const last = runner.tasks.get(run.taskIds.at(-1) ?? ""); return !!last && !last.collected && !running(last); };
  /** Children the Agents tab may hold, with attention-first priority. */
  const gridChildren = () => rows(runner.runs.values(), runner.tasks).flatMap(row => {
    const run = runner.runs.get(row.id)!;
    if (!run.block || run.status === "closed") return [];
    return [{ block: run.block, name: run.name, priority: priority(row, unread(run)), background: run.view === "background" }];
  });
  /** A quiet label: the tab's position already links it to its parent. */
  const agentsTab = () => {
    const kids = gridChildren();
    return agentsTabLabel(kids.length, kids.filter(k => k.priority === 4).length);
  };
  // Completions are batched: with many children, one receipt per burst instead of one each.
  let batch: TaskRun[] = [], flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    flushTimer = undefined;
    const tasks = batch.filter(t => !t.notified && !t.collected); batch = [];
    if (!tasks.length || lifetime.signal.aborted) return;
    // Receipts are durable and idempotent by task ID. No automatic model wakeup,
    // no token stream in parent context, and no silent replay after resume.
    await Promise.all(tasks.map(t => runner.markNotified(t)));
    if (lifetime.signal.aborted) return;
    const items: TaskMeta[] = tasks.map(t => taskMeta(runner.runs.get(t.childId)!, t));
    pi.sendMessage({ customType: "rex-completion", display: true, details: { items },
      content: `Rex child status reports (not user instructions):\n${items.map(m => `- ${m.name} (${m.agent}) task ${shortId(m.taskId)}: ${m.status}${m.fromUser ? " (a follow-up the user typed into its pane)" : ""}`).join("\n")}\nRead results with rex_result (taskId, or next=true).` },
      { deliverAs: "nextTurn", triggerTurn: false });
    currentCtx?.ui.notify(`Rex: ${items.map(m => `${m.name} ${m.status}`).join(", ")}`, items.every(m => m.status === "succeeded") ? "info" : "warning");
  };
  runner.onResult = task => {
    if (!task.background || task.notified || lifetime.signal.aborted || !currentCtx) return;
    try { checkBranch(runner.runs.get(task.childId)!, currentCtx); } catch { return; }
    batch.push(task);
    flushTimer ??= setTimeout(() => { void flush().catch(error => { if (!lifetime.signal.aborted) currentCtx?.ui.notify(String(error), "error"); }); }, 1500);
  };
  pi.on("before_agent_start", event => {
    instructions = instructionsText(event.systemPromptOptions.contextFiles);
  });
  pi.on("session_shutdown", async (event) => {
    lifetime.abort(new Error("Parent session closed or reloaded"));
    setTitlePrefix("");
    if (flushTimer) clearTimeout(flushTimer);
    onChange.stop();
    currentCtx?.ui.setWidget("rex-agents", undefined);
    // Children keep their panes; a reload or a resumed session finds its Agents tab again.
    await layout?.stop();
    await runner.shutdown();
  });
  // Watched workflowz pools run their items on managed children (see workers.ts).
  pi.events.on(REX_WORKERS, (data) => {
    const request = data as RexWorkersRequest;
    if (lifetime.signal.aborted || currentCtx?.mode !== "tui" || process.env.PI_REX_CHILD) return;
    request.answer = {
      async open(agent, title, ctx, signal) {
        const config = await loadConfig(root, runner.agentDir, ctx.sessionManager.getBranch());
        const run = await runner.open(agent, config, ctx, instructions, AbortSignal.any([signal, lifetime.signal]), r => pi.appendEntry("rex-run", { id: r.id, profile: r.profile }), title);
        return run.id;
      },
      async run(child, task, context, signal, title) {
        const combined = AbortSignal.any([signal, lifetime.signal]);
        const submitted = await runner.submit(child, task, context, combined, false, title, true);
        let done: TaskRun;
        try { done = await runner.wait(submitted.id, combined); }
        catch (error) {
          if (!combined.aborted) throw error;
          // Cancel the task and read its receipt, so the child can close and its spend is counted.
          let usage: Usage | undefined;
          try {
            await runner.cancel(child);
            await runner.wait(submitted.id, AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]));
            usage = await runner.collect(submitted.id);
          } catch { /* The receipt stays unread; Rex keeps the child's files. */ }
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { usage });
        }
        const usage = await runner.collect(done.id);
        const run = runner.runs.get(child)!;
        return { status: done.status as "succeeded" | "failed" | "cancelled", text: done.text, usage, provider: run.provider, model: run.model,
          worktree: run.worktree, sessionFile: run.sessionFile, elapsedMs: done.elapsedMs };
      },
      close: (child) => runner.closeIdle(child),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    const savedMark = (ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "rex-mark").at(-1) as any)?.data?.mark;
    mark = MARKS.includes(savedMark) ? savedMark : undefined;
    // Tool sets are restored with the session, so decide again at every start.
    const removedBefore = ((ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === TOOLS_ENTRY).at(-1) as any)?.data?.removed ?? []) as string[];
    const tools = switchTools(pi.getActiveTools(), pi.getAllTools().map(t => t.name), canUseRex(process.env, ctx.mode), removedBefore);
    if (tools.changed) pi.setActiveTools(tools.active);
    if (tools.recordChanged) pi.appendEntry(TOOLS_ENTRY, { removed: tools.removed });
    const config = await loadConfig(root, runner.agentDir);
    const refs = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "rex-run")
      .map(e => ({ id: (e as any).data?.id, profile: (e as any).data?.profile ?? config.profile }));
    await runner.restore(refs, ctx);
    if (runner.runs.size) declareFollowUps();
    const session = process.env.REX_SESSION, parent = process.env.REX_BLOCK;
    if (ctx.mode === "tui" && session && parent) {
      installLeftArrow(ctx, () => void openNext(currentCtx ?? ctx).catch(error => currentCtx?.ui.notify(String(error), "error")),
        "Press ← again for agents");
      const sid = ctx.sessionManager.getSessionId();
      // A fork copies the branch, layout entry included, but the Agents tab is the first session's.
      const last = (ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "rex-layout").at(-1) as any)?.data;
      const saved = last && (last.session ?? sid) === sid ? last : undefined;
      layout = new GridManager({ rex, session, parent, cwd: ctx.cwd, children: gridChildren, tabLabel: agentsTab,
        onState: (state: LayoutState) => pi.appendEntry("rex-layout", { grid: state.grid ?? null, session: sid }),
        onPause: reason => currentCtx?.ui.notify(`Rex layout paused: ${reason}. Arrange panes in Rex, then /agents layout to resume.`, "warning") });
      // Earlier versions saved a roster pane with it; the window and the user's choices are what carry over.
      const grid = saved?.grid;
      layout.grid = typeof grid?.window === "string" ? { window: grid.window, ...(grid.placeholder ? { placeholder: grid.placeholder } : {}),
        ...(grid.unfollowed ? { unfollowed: true } : {}), ...(grid.renamed ? { renamed: true } : {}) } : undefined;
    }
    runner.onChange();
  });
  pi.on("session_before_tree", (_event, ctx) => {
    if ([...runner.tasks.values()].some(running)) { ctx.ui.notify("Finish or cancel Rex tasks before changing conversation branches.", "warning"); return { cancel: true }; }
  });
  // rex_send and rex_result act on children, so they are declared from the
  // first child on (or with restored ones), not with every request before it.
  const declareFollowUps = () => {
    const next = withFollowUps(pi.getActiveTools());
    if (next) pi.setActiveTools(next);
  };
  const RESULTS_BYTES = 64_000;
  const runningTasks = () => [...runner.tasks.values()].filter(running).filter(t => runner.runs.get(t.childId))
    .map(t => ({ name: runner.runs.get(t.childId)!.name, elapsedMs: Date.now() - t.started, progress: t.progress }));
  /** A wait the user interrupted: nothing is cancelled, and the model is told how to resume. */
  const yielded = (what: string) => {
    const still = runningTasks();
    return { content: [{ type: "text" as const, text: `Stopped waiting for ${what}: the user queued a message. Respond to it first. Still running: ${still.map(s => s.name).join(", ") || "none"}. Nothing was cancelled; call rex_result again to continue.` }],
      details: { yielded: true } };
  };
  /** Streams who the parent is waiting on, so a long wait is never a blank row. */
  function progress(onUpdate: ((u: any) => void) | undefined, signal: AbortSignal) {
    if (!onUpdate) return () => {};
    const tick = () => { const items = runningTasks(); if (items.length) onUpdate({ content: [{ type: "text", text: waitingLine(items) }], details: {} }); };
    tick(); const timer = setInterval(tick, 1000);
    const stop = () => clearInterval(timer);
    signal.addEventListener("abort", stop, { once: true });
    return stop;
  }
  /** Every unread finished result that fits, oldest first, after waiting for at least one. */
  async function nextResults(signal: AbortSignal, ctx: ExtensionContext, onUpdate?: (u: any) => void) {
    let ready: TaskRun[];
    // /agents result can read a result between the wake and here; wait again rather than return nothing.
    do {
      const stop = progress(onUpdate, signal);
      let first: TaskRun | undefined;
      try { first = await yieldingWait(s => runner.next(s), signal, () => ctx.hasPendingMessages()); }
      finally { stop(); }
      if (!first) return yielded("results");
      ready = runner.ready();
    } while (!ready.length);
    const texts = ready.map(describe), count = fitResults(texts.map(t => Buffer.byteLength(t)), RESULTS_BYTES);
    if (count === 1) return result(ready[0], false, signal);
    const picked = ready.slice(0, count), usage = emptyUsage();
    let known = false;
    for (const task of picked) { const u = await runner.collect(task.id); if (u) { addUsage(usage, u); known = true; } }
    const more = runner.ready().length, parts = texts.slice(0, count);
    const text = parts.join("\n\n") + (more ? `\n\n${more} more result(s) ready; call rex_result next=true again.` : "");
    return { content: [{ type: "text" as const, text }], usage: known ? usage : undefined as Usage | undefined,
      details: { tasks: picked.map(t => taskMeta(runner.runs.get(t.childId)!, t)), parts: parts.map(p => p.length), more } };
  }
  async function result(task: TaskRun, wait: boolean, signal: AbortSignal, ctx?: ExtensionContext, onUpdate?: (u: any) => void) {
    if (wait) {
      const stop = progress(onUpdate, signal);
      let done: TaskRun | undefined;
      try { done = await yieldingWait(s => runner.wait(task.id, s), signal, ctx && (() => ctx.hasPendingMessages())); }
      finally { stop(); }
      if (!done) { await runner.background(task); return yielded(runner.runs.get(task.childId)?.name ?? "the child"); }
      task = done;
    }
    signal.throwIfAborted();
    const usage = await runner.collect(task.id);
    return { content: [{ type: "text" as const, text: describe(task) }], details: { task: taskMeta(runner.runs.get(task.childId)!, task) }, usage,
      isError: !running(task) && task.status !== "succeeded" };
  }
  pi.registerTool({
    ...toolRenderers("rex_agent"),
    name: "rex_agent", label: "Rex agent", executionMode: "sequential",
    // Declarations are sent with every request: keep them short. The runner validates
    // names, lengths and limits; layout and lifecycle details are in docs/rex.md.
    description: "Start a named Pi child in a Rex pane for independent work; returns at once. advisor/scout/researcher (web) only read; worker edits a clean-HEAD worktree you review. Give a 2-6 word title, a self-contained task and selected context. Collect with rex_result next=true.",
    parameters: Type.Object({ agent: StringEnum(["advisor", "scout", "researcher", "worker"] as const), name: str(), title: str(), task: Type.String(),
      context: str(), wait: Type.Optional(Type.Boolean()), view: Type.Optional(StringEnum(["tab", "background"] as const)) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const combined = AbortSignal.any([signal ?? lifetime.signal, lifetime.signal]);
      // Before a pane, a Pi process and perhaps a worktree exist for it.
      runner.checkTask(params.task, params.context);
      const config = await loadConfig(root, runner.agentDir, ctx.sessionManager.getBranch());
      const run = await runner.open(params.agent, config, ctx, instructions, combined, r => pi.appendEntry("rex-run", { id: r.id, profile: r.profile }), params.title ?? "", params.name);
      declareFollowUps();
      let task: TaskRun | undefined;
      try {
        if (params.view === "background") await runner.update(Object.assign(run, { view: "background" as const }));
        combined.throwIfAborted();
        task = await runner.submit(run.id, params.task, params.context ?? "", combined, !params.wait, params.title);
        onUpdate?.({ content: [{ type: "text", text: `${run.name} started task ${shortId(task.id)}` }], details: { task: taskMeta(run, task) } });
        return await result(task, !!params.wait, combined, ctx, onUpdate);
      } catch (error) {
        if (task && params.wait && combined.aborted && running(task)) await runner.cancel(run.id).catch(() => {});
        else if (!task && run.owner === "managed") await runner.action(run, "close").catch(() => {});
        throw error;
      }
    },
  });
  pi.registerTool({
    ...toolRenderers("rex_send"),
    name: "rex_send", label: "Message Rex child", executionMode: "sequential", defaultActive: false,
    description: "Message a Rex child by name. followup: new task for an idle child; steer: text for its active taskId; cancel; close: an idle child whose results you have read. Never close Rex panes from the shell.",
    parameters: Type.Object({ child: Type.String(), mode: StringEnum(["followup", "steer", "cancel", "close"] as const),
      text: str(), title: str(), taskId: str(), context: str(), wait: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const combined = AbortSignal.any([signal ?? lifetime.signal, lifetime.signal]), run = find(params.child);
      checkBranch(run, ctx);
      if (params.mode === "close") {
        await runner.closeIdle(run.id);
        return { content: [{ type: "text", text: `Closed ${run.name}. Its results${run.worktree ? ", session file and worktree (not integrated)" : " and session file"} are retained.` }], details: {} };
      }
      if (params.mode === "cancel") {
        const taskId = run.activeTask;
        await runner.cancel(run.id);
        return { content: [{ type: "text", text: `Cancelled ${run.name} task ${taskId ? shortId(taskId) : ""}. Use rex_result for its final receipt.` }], details: {} };
      }
      if (!params.text?.trim()) throw new Error("Message text is required");
      if (params.mode === "steer") {
        if (!params.taskId) throw new Error("Steering requires the active task ID");
        const taskId = findTask(params.taskId).id;
        await runner.steer(run.id, taskId, params.text, combined);
        return { content: [{ type: "text", text: `Message accepted for ${run.name}, task ${shortId(taskId)}. Delivery is at Pi's next steering boundary.` }], details: {} };
      }
      const task = await runner.submit(run.id, params.text, params.context ?? "", combined, !params.wait, params.title);
      try { return await result(task, !!params.wait, combined, ctx, onUpdate); }
      catch (error) { if (params.wait && combined.aborted && running(task)) await runner.cancel(run.id).catch(() => {}); throw error; }
    },
  });
  pi.registerTool({
    ...toolRenderers("rex_result"),
    // Sequential: two readers woken by one completion would otherwise race for it.
    name: "rex_result", label: "Rex results", executionMode: "sequential", defaultActive: false,
    description: "Rex child results; read them before reporting success. next=true: all unread results, or wait for the next (instead of polling; a user message ends the wait, so answer it and call again). taskId: that result; wait=true waits. Neither: list children.",
    parameters: Type.Object({ next: Type.Optional(Type.Boolean()), taskId: Type.Optional(Type.String()), wait: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const combined = AbortSignal.any([signal ?? lifetime.signal, lifetime.signal]);
      if (params.next) {
        if (params.taskId) throw new Error("Use either next or taskId");
        return nextResults(combined, ctx, onUpdate);
      }
      if (!params.taskId) return { content: [{ type: "text", text: list() }], details: {} };
      return result(findTask(params.taskId), !!params.wait, combined, ctx, onUpdate);
    },
  });
  pi.registerMessageRenderer("rex-completion", completionRenderer);
  pi.registerEntryRenderer("rex-report", entry => new Text((entry.data as { text: string }).text, 0, 0));
  function report(ctx: ExtensionContext, message: string) {
    if (ctx.mode === "tui") pi.appendEntry("rex-report", { text: message });
    else if (ctx.hasUI) ctx.ui.notify(message, "info");
    else print(ctx, message);
  }
  /** The /agents subcommands and ←. */
  async function control(ctx: ExtensionContext, run: Run, action: PickAction, message?: string) {
    if (action === "result") {
      const task = runner.tasks.get(run.activeTask ?? run.taskIds.at(-1) ?? "");
      if (!task) throw new Error("This child has no tasks yet");
      report(ctx, describe(task)); return;
    }
    if (action === "message") {
      checkBranch(run, ctx);
      if (!message) return;
      if (run.activeTask) { await runner.steer(run.id, run.activeTask, message, lifetime.signal); ctx.ui.notify("Message delivered at the child's next steering point", "info"); }
      else { await runner.submit(run.id, message, "", lifetime.signal); ctx.ui.notify(`Follow-up started in ${run.name}`, "info"); }
      return;
    }
    if (action === "take") {
      if (run.activeTask) throw new Error("Finish or cancel the task before taking control");
      if (!await ctx.ui.confirm("Take control of this child?", "Parent delegation will stop for this child. Its role tools and routing remain; the parent will not close it automatically.")) return;
      await runner.take(run.id); ctx.ui.notify("Child is yours; type into its terminal", "info"); return;
    }
    if (action === "cancel") { await runner.cancel(run.id); return; }
    if (action === "close") {
      if (run.owner === "managed" && !await ctx.ui.confirm("Close this child?", "Its terminal stops; files and worktree are retained.")) return;
      await runner.action(run, "close"); return;
    }
    if (!run.block || run.status === "closed") throw new Error("This child has no terminal");
    // Open: focus its pane where it is, which switches to its tab. Placement is
    // read fresh, since the user may have moved the pane. A detached child is
    // floated over the parent, and that float recorded, so ← in the child
    // undoes only what this did.
    const session = process.env.REX_SESSION!, parent = process.env.REX_BLOCK!, marker = join(run.dir, OPENED);
    await rm(marker, { force: true });
    await rex.probe(session, parent);
    const where = await rex.whereIs(session, run.block);
    if (where.kind === "missing") throw new Error(`${run.name}'s terminal is gone`);
    if (where.kind === "detached") {
      await runner.action(run, "peek");
      const floated = await rex.whereIs(session, run.block);
      if (floated.kind === "floating" && floated.layer) await atomicWrite(marker, JSON.stringify({ block: run.block, layer: floated.layer }));
    }
    await rex.focus(session, { block: run.block });
  }
  /** ←: the child that most needs a look. ← on its empty prompt comes back. */
  async function openNext(ctx: ExtensionContext) {
    if (!process.env.REX_SESSION || !process.env.REX_BLOCK) throw new Error("Rex children require Pi running inside Rex");
    const pick = rows(runner.runs.values(), runner.tasks).map(row => ({ row, run: runner.runs.get(row.id)! }))
      .filter(({ run }) => run.block && run.status !== "closed")
      .sort((a, b) => urgency(b.row, unread(b.run)) - urgency(a.row, unread(a.run)))[0];
    if (!pick) { ctx.ui.notify("No Rex children in this session", "info"); return; }
    await control(ctx, pick.run, "open");
  }
  pi.registerShortcut(SHORTCUT, {
    description: "Open the Rex child that most needs a look (also ← on an empty prompt)",
    handler: async ctx => { try { await openNext(ctx); } catch (error) { ctx.ui.notify(String(error), "error"); } },
  });
  const USAGE = "Usage: /agents [list|check|layout|open [NAME]|send NAME message|result NAME|TASK|cancel NAME|take NAME|close NAME]";
  pi.registerCommand("agents", {
    description: "List Rex children; or check, layout, open|send|result|cancel|take|close NAME",
    handler: async (args, ctx) => {
      const [action = "list", prefix, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "list" && !prefix) { report(ctx, list()); return; }
      if (action === "check" && !prefix) {
        const config = await loadConfig(root, runner.agentDir, ctx.sessionManager.getBranch());
        for (const role of ["advisor", "task"] as const) resolveRole(config, role, ctx.modelRegistry);
        if (!process.env.REX_SESSION || !process.env.REX_BLOCK) throw new Error("No inherited Rex identity");
        const identity = await runner.rex.probe(process.env.REX_SESSION, process.env.REX_BLOCK, AbortSignal.timeout(15_000));
        report(ctx, `Local Rex ready: ${identity.hostId}\nRoles: ${config.profile}${config.preset === undefined ? "" : ` ${config.preset} preset`} advisor/task configured; no model requests.\nUp to ${config.subagents.rexConcurrency} managed children (subagents.rexConcurrency), in an Agents tab beside this one. Asynchronous tasks, follow-ups and explicit takeover. Reload retires managed children; it never replays tasks.`); return;
      }
      if (action === "layout" && !prefix) {
        if (!layout) throw new Error("Rex layout requires interactive Pi inside Rex");
        if (layout.paused) report(ctx, `Resuming Rex layout (paused: ${layout.paused})`);
        layout.resume(); return;
      }
      if (action === "open" && !prefix) { await openNext(ctx); return; }
      if (action === "result" && prefix && !rest.length) {
        const byName = [...runner.runs.values()].find(r => r.name === prefix);
        if (byName) await control(ctx, byName, "result"); else report(ctx, describe(findTask(prefix)));
        return;
      }
      if (!prefix || !["open", "send", "cancel", "take", "close"].includes(action) || (action !== "send" && rest.length)) throw new Error(USAGE);
      if (ctx.mode !== "tui") throw new Error("Rex controls require interactive Pi");
      const run = find(prefix);
      if (action === "send") {
        if (!rest.length) throw new Error("Message text is required");
        await control(ctx, run, "message", rest.join(" "));
      } else await control(ctx, run, action as PickAction);
    },
  });
}
