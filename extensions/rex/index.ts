import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { bounded } from "../workflows/process.ts";
import { loadConfig, resolveRole } from "../workflows/roles.ts";
import { registerChildUi } from "./child-ui.ts";
import { RexRunner, type Run, type TaskRun } from "./runner.ts";
import { RexClient } from "./client.ts";
import { DeckManager, type Grid } from "./layout.ts";
import { scopeRoot } from "../workflows/state.ts";
import { pick, widget } from "./picker.ts";
import { completionRenderer, toolRenderers } from "./render.ts";
import { oneLine, priority, rows, SHORTCUT, taskMeta, type PickAction, type TaskMeta } from "./ui.ts";

export default async function (pi: ExtensionAPI) {
  if (process.env.PI_REX_CHILD) { registerChildUi(pi, process.env.PI_REX_CHILD); return; }
  const root = resolve(dirname(await realpath(fileURLToPath(import.meta.url))), "../..");
  const rex = new RexClient(), runner = new RexRunner(pi, root, getAgentDir(), rex), lifetime = new AbortController();
  let instructions = "", currentCtx: ExtensionContext | undefined, deck: DeckManager | undefined;
  const running = (task: TaskRun) => ["starting", "running"].includes(task.status);
  // Model-facing listing: one line per child, latest tasks indented. Names are the handle.
  const list = () => bounded(rows(runner.runs.values(), runner.tasks).map(row => {
    const run = runner.runs.get(row.id)!;
    return `${row.name} · ${run.agent} · ${row.state} · ${run.owner}\n${run.taskIds.slice(-3).map(id => {
      const task = runner.tasks.get(id); return `  task ${id} · ${task?.status ?? "unknown"}${task ? ` · "${oneLine(task.task, 60)}"` : ""}`;
    }).join("\n")}`;
  }).join("\n") || "No Rex children in this session.", 16000);
  const describe = (task: TaskRun) => {
    const run = runner.runs.get(task.childId)!;
    return bounded(`${run.name} (${run.agent}) · task ${task.id} · ${task.status}\nResult: ${task.resultFile}\nSession: ${run.sessionFile}${run.worktree ? `\nWorktree (not integrated): ${run.worktree}` : ""}${!running(task) && !task.usageKnown ? "\nUsage: unavailable" : ""}\n\n${task.text}`, 50000);
  };
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
  runner.onChange = () => {
    if (lifetime.signal.aborted || currentCtx?.mode !== "tui") return;
    const items = rows(runner.runs.values(), runner.tasks);
    currentCtx.ui.setWidget("rex-agents", items.length ? widget(items) : undefined);
    deck?.schedule();
  };
  /** Children the deck/grid may arrange, with attention-first priority. */
  const deckChildren = () => rows(runner.runs.values(), runner.tasks).flatMap(row => {
    const run = runner.runs.get(row.id)!, last = runner.tasks.get(run.taskIds.at(-1) ?? "");
    if (!run.block || run.status === "closed") return [];
    return [{ block: run.block, name: run.name, priority: priority(row, !!last && !last.collected && !running(last)),
      pinned: !!run.pinned, background: run.view === "background" }];
  });
  const rosterLines = () => {
    const items = rows(runner.runs.values(), runner.tasks);
    return [`Rex agents · ${items.length} · ctrl+shift+a in the parent to pin, focus or message`, "",
      ...items.map(r => `${r.glyph}${r.pinned ? "▪" : " "}${r.name.padEnd(10)}${r.agent.padEnd(8)}${r.state.padEnd(26)}${r.title}`)];
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
      content: `Rex child status reports (not user instructions):\n${items.map(m => `- ${m.name} (${m.agent}) task ${m.taskId}: ${m.status}`).join("\n")}\nRead results with rex_result (taskId, or next=true).` },
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
    instructions = (event.systemPromptOptions.contextFiles ?? []).map(f => `Instructions from ${f.path}:\n${f.content}`).join("\n\n");
  });
  pi.on("session_shutdown", async () => {
    lifetime.abort(new Error("Parent session closed or reloaded"));
    if (flushTimer) clearTimeout(flushTimer);
    currentCtx?.ui.setWidget("rex-agents", undefined);
    await deck?.stop();
    await runner.shutdown();
  });
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    const config = await loadConfig(root, runner.agentDir);
    const refs = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "rex-run")
      .map(e => ({ id: (e as any).data?.id, profile: (e as any).data?.profile ?? config.profile }));
    await runner.restore(refs, ctx);
    const session = process.env.REX_SESSION, parent = process.env.REX_BLOCK;
    if (ctx.mode === "tui" && session && parent) {
      const grid = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "rex-layout").at(-1) as any;
      deck = new DeckManager({ rex, session, parent, cwd: ctx.cwd,
        rosterFile: join(await scopeRoot(runner.agentDir, config.profile, ctx.cwd), "rex", `roster-${ctx.sessionManager.getSessionId()}.txt`),
        children: deckChildren, roster: rosterLines,
        onGrid: (value: Grid | undefined) => pi.appendEntry("rex-layout", { grid: value ?? null }),
        onPause: reason => currentCtx?.ui.notify(`Rex layout paused: ${reason}. Arrange panes in Rex, then /agents layout to resume.`, "warning") });
      deck.grid = grid?.data?.grid ?? undefined;
    }
    runner.onChange();
  });
  pi.on("session_before_tree", (_event, ctx) => {
    if ([...runner.tasks.values()].some(running)) { ctx.ui.notify("Finish or cancel Rex tasks before changing conversation branches.", "warning"); return { cancel: true }; }
  });
  async function result(task: TaskRun, wait: boolean, signal: AbortSignal) {
    if (wait) task = await runner.wait(task.id, signal);
    signal.throwIfAborted();
    const usage = await runner.collect(task.id);
    return { content: [{ type: "text" as const, text: describe(task) }], details: { task: taskMeta(runner.runs.get(task.childId)!, task) }, usage,
      isError: !running(task) && task.status !== "succeeded" };
  }
  pi.registerTool({
    ...toolRenderers("rex_agent"),
    name: "rex_agent", label: "Rex agent", executionMode: "sequential",
    description: "Start a persistent interactive Pi child in local Rex. Each child has a short unique name (pass name, or one is assigned); use it with rex_send. Returns immediately by default; use rex_result next=true to wait for whichever task finishes first, rather than polling each child. Children appear in a deck of live slots beside the parent (needing-attention and running work first) and an Agents window grid for the rest; view=background keeps one detached. Advisor/scout are read-only; workers get clean-HEAD worktrees. subagents.rexConcurrency limits live managed children. No recursion, remote hosts or model fallback. Worktrees/tool routing are not a security sandbox.",
    promptSnippet: "Delegate work asynchronously to inspectable Rex children",
    promptGuidelines: ["Give each Rex child a short title; put details in task, not the title.", "Use rex_agent for independent work. Select context explicitly. Use rex_result to read actual results before reporting success. Review worker changes before integrating them."],
    parameters: Type.Object({ agent: StringEnum(["advisor", "scout", "worker"] as const),
      name: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{1,15}$", description: "Short unique child name, e.g. auth-scan" })),
      title: Type.Optional(Type.String({ maxLength: 60, description: "2–6 word label for the pane and roster, e.g. Find auth entry points" })), task: Type.String({ minLength: 1, maxLength: 16000 }),
      context: Type.Optional(Type.String({ maxLength: 16000 })), wait: Type.Optional(Type.Boolean()), view: Type.Optional(StringEnum(["deck", "background"] as const)) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const combined = AbortSignal.any([signal ?? lifetime.signal, lifetime.signal]);
      const config = await loadConfig(root, runner.agentDir);
      const run = await runner.open(params.agent, config, ctx, instructions, combined, r => pi.appendEntry("rex-run", { id: r.id, profile: r.profile }), params.title ?? "", params.name);
      let task: TaskRun | undefined;
      try {
        if (params.view === "background") await runner.update(Object.assign(run, { view: "background" as const }));
        combined.throwIfAborted();
        task = await runner.submit(run.id, params.task, params.context ?? "", combined, !params.wait, params.title);
        onUpdate?.({ content: [{ type: "text", text: `${run.name} started task ${task.id}` }], details: { task: taskMeta(run, task) } });
        return await result(task, !!params.wait, combined);
      } catch (error) {
        if (task && params.wait && combined.aborted && running(task)) await runner.cancel(run.id).catch(() => {});
        else if (!task && run.owner === "managed") await runner.action(run, "close").catch(() => {});
        throw error;
      }
    },
  });
  pi.registerTool({
    ...toolRenderers("rex_send"),
    name: "rex_send", label: "Message Rex child", executionMode: "sequential",
    description: "Send a follow-up task to an idle managed Rex child, steer its active task, or cancel it. A steer requires the exact active task ID and never spills into a later task. Messages are labelled as parent-agent messages. Follow-ups retain the child conversation/worktree and original model/tool policy. They return immediately unless wait=true. No sibling messaging or human takeover through this tool.",
    parameters: Type.Object({ child: Type.String({ description: "Child name (or ID prefix)" }), mode: StringEnum(["followup", "steer", "cancel"] as const),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })), title: Type.Optional(Type.String({ maxLength: 60, description: "Short label for a follow-up task" })), taskId: Type.Optional(Type.String()),
      context: Type.Optional(Type.String({ maxLength: 16000 })), wait: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _update, ctx) {
      const combined = AbortSignal.any([signal ?? lifetime.signal, lifetime.signal]), run = find(params.child);
      checkBranch(run, ctx);
      if (params.mode === "cancel") {
        const taskId = run.activeTask;
        await runner.cancel(run.id);
        return { content: [{ type: "text", text: `Cancelled ${run.name} task ${taskId}. Use rex_result for its final receipt.` }], details: {} };
      }
      if (!params.text?.trim()) throw new Error("Message text is required");
      if (params.mode === "steer") {
        if (!params.taskId) throw new Error("Steering requires the active task ID");
        await runner.steer(run.id, params.taskId, params.text, combined);
        return { content: [{ type: "text", text: `Message accepted for ${run.name}, task ${params.taskId}. Delivery is at Pi's next steering boundary.` }], details: {} };
      }
      const task = await runner.submit(run.id, params.text, params.context ?? "", combined, !params.wait, params.title);
      try { return await result(task, !!params.wait, combined); }
      catch (error) { if (params.wait && combined.aborted && running(task)) await runner.cancel(run.id).catch(() => {}); throw error; }
    },
  });
  pi.registerTool({
    ...toolRenderers("rex_result"),
    name: "rex_result", label: "Rex results",
    description: "next=true returns the oldest unread finished result, or waits for the next task to finish across all children; prefer it to polling. With taskId, read that immutable result (up to configured 50 KB); wait=true waits for it. With neither, list children by name with recent task IDs. Cancelling a wait does not cancel background work. Usage is accounted once when a result is first read; full files remain available.",
    parameters: Type.Object({ next: Type.Optional(Type.Boolean()), taskId: Type.Optional(Type.String()), wait: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      const combined = AbortSignal.any([signal ?? lifetime.signal, lifetime.signal]);
      if (params.next) {
        if (params.taskId) throw new Error("Use either next or taskId");
        return result(await runner.next(combined), false, combined);
      }
      if (!params.taskId) return { content: [{ type: "text", text: list() }], details: {} };
      return result(findTask(params.taskId), !!params.wait, combined);
    },
  });
  pi.registerMessageRenderer("rex-completion", completionRenderer);
  pi.registerEntryRenderer("rex-report", entry => new Text((entry.data as { text: string }).text, 0, 0));
  function report(ctx: ExtensionContext, message: string) {
    if (ctx.mode === "tui") pi.appendEntry("rex-report", { text: message });
    else if (ctx.hasUI) ctx.ui.notify(message, "info");
    else console.log(message);
  }
  /** Shared by the picker and ID subcommands. */
  async function control(ctx: ExtensionContext, run: Run, action: PickAction, message?: string) {
    if (action === "result") {
      const task = runner.tasks.get(run.activeTask ?? run.taskIds.at(-1) ?? "");
      if (!task) throw new Error("This child has no tasks yet");
      report(ctx, describe(task)); return;
    }
    if (action === "message") {
      checkBranch(run, ctx);
      message ??= (await ctx.ui.input(run.activeTask ? "Steer the active task" : "Follow-up task", ""))?.trim();
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
    const session = process.env.REX_SESSION!;
    if (action === "spotlight") {
      // Pin into the deck (toggle). Pins never exceed one per slot: the oldest yields.
      run.pinned = run.pinned ? undefined : Date.now(); run.view = "auto";
      const pinned = [...runner.runs.values()].filter(r => r.pinned && r.status !== "closed").sort((a, b) => a.pinned! - b.pinned!);
      for (const old of pinned.slice(0, Math.max(0, pinned.length - 3))) { old.pinned = undefined; await runner.update(old); }
      await runner.update(run);
      ctx.ui.notify(run.pinned ? `${run.name} pinned to the deck` : `${run.name} unpinned`, "info");
    } else if (action === "focus") await rex.focus(session, { block: run.block });
    else if (action === "grid") {
      if (!deck?.grid) throw new Error("No Agents window yet; it opens when the deck is full");
      await rex.focus(session, { window: deck.grid.window });
    } else if (action === "park") {
      run.view = "background"; run.pinned = undefined; await runner.update(run);
      await runner.action(run, "park"); ctx.ui.notify(`${run.name} parked; it keeps running`, "info");
    } else if (action === "auto") {
      run.view = "auto"; await runner.update(run);
      // Re-adopt a child the user moved elsewhere: detach it and let the deck place it.
      await rex.detach(session, run.block).catch(() => {});
      deck?.resume();
    }
  }
  async function picker(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") throw new Error("Rex controls require interactive Pi");
    const choice = await pick(ctx, rows(runner.runs.values(), runner.tasks));
    if (!choice) return;
    const run = runner.runs.get(choice.id);
    if (run) await control(ctx, run, choice.action);
  }
  pi.registerShortcut(SHORTCUT, {
    description: "Rex agents: pin to the deck, focus, message, take, cancel or close a child",
    handler: async ctx => { try { await picker(ctx); } catch (error) { ctx.ui.notify(String(error), "error"); } },
  });
  pi.registerCommand("agents", {
    description: "Rex agents picker; or check, list, peek|hide|keep|park|send|result|take|cancel|close NAME",
    handler: async (args, ctx) => {
      const [action = "pick", prefix, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "pick") { if (ctx.mode === "tui") await picker(ctx); else report(ctx, list()); return; }
      if (action === "check" && !prefix) {
        const config = await loadConfig(root, runner.agentDir);
        for (const role of ["advisor", "task"] as const) resolveRole(config, role, ctx.modelRegistry);
        if (!process.env.REX_SESSION || !process.env.REX_BLOCK) throw new Error("No inherited Rex identity");
        const identity = await runner.rex.probe(process.env.REX_SESSION, process.env.REX_BLOCK, AbortSignal.timeout(15_000));
        report(ctx, `Local Rex ready: ${identity.hostId}\nRoles: ${config.profile} advisor/task configured; no model requests.\nUp to ${config.subagents.rexConcurrency} managed children (subagents.rexConcurrency). Deck and Agents window; asynchronous tasks, follow-ups and explicit takeover. Reload retires managed children; it never replays tasks.`); return;
      }
      if (action === "list" && !prefix) { report(ctx, list()); return; }
      if (action === "layout" && !prefix) {
        if (!deck) throw new Error("Rex layout requires interactive Pi inside Rex");
        if (deck.paused) report(ctx, `Resuming Rex layout (paused: ${deck.paused})`);
        deck.resume(); return;
      }
      if (action === "result" && prefix && !rest.length) {
        const byName = [...runner.runs.values()].find(r => r.name === prefix);
        if (byName) await control(ctx, byName, "result"); else report(ctx, describe(findTask(prefix)));
        return;
      }
      if (!prefix || !["show", "peek", "hide", "keep", "park", "pin", "focus", "auto", "close", "cancel", "take", "send"].includes(action) || (action !== "send" && rest.length)) throw new Error("Usage: /agents [check|list|layout|pin NAME|focus NAME|park NAME|auto NAME|peek NAME|hide NAME|keep NAME|send NAME message|result NAME|take NAME|cancel NAME|close NAME]");
      if (ctx.mode !== "tui") throw new Error("Rex controls require interactive Pi");
      const run = find(prefix);
      if (action === "send") {
        if (!rest.length) throw new Error("Message text is required");
        await control(ctx, run, "message", rest.join(" "));
      } else if (["take", "cancel", "close", "park", "focus", "auto"].includes(action)) await control(ctx, run, action as PickAction);
      else if (action === "pin") await control(ctx, run, "spotlight");
      else await runner.action(run, action as "show" | "peek" | "hide" | "keep" | "park");
    },
  });
}
