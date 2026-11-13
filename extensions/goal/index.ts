import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DISCUSS } from "../ask/model.ts";
import {
  KICKOFF_TYPE, NOTE_TYPE, amount, close, continueNote, create, decide, format, isUnfinished, kickoff, label,
  limitNote, overBudget, parseAmount, restore, section, snapshot, statusText, transition, withBudget,
  type Goal, type Snapshot, type State,
} from "./goal.ts";

const usage = "Usage: /goal [<objective>|pause|resume|clear|continuations <n|off>|tokens <n|off>]";
const verbs = ["pause", "resume", "clear", "continuations", "tokens"];

export default function (pi: ExtensionAPI) {
  let state: State = restore([]);
  let progressed = false;    // A tool other than goal ran since the run started or the last continuation.
  let waiting = false;       // The loop stopped because the last turn ran no tool.
  let discussing = false;    // The user ended an ask to talk; cleared when the next run starts.
  let prompted: string | undefined;   // The objective in this run's system prompt.
  let pending: "set" | "resume" | undefined; // Goal work to start once the current run settles.
  let settled: (() => void)[] = [];   // Headless commands waiting for the goal run to end.

  const reload = (ctx: ExtensionContext) => { state = restore(ctx.sessionManager.getBranch()); };
  function refresh(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const text = statusText(state);
    ctx.ui.setStatus("goal", text && waiting && state.goal?.status === "active" ? `${text} · waiting` : text);
  }
  function save(ctx: ExtensionContext, next: Snapshot) {
    pi.appendEntry("goal", next);
    const fresh = next.event === "set" || next.event === "resume";
    state = { goal: next.goal, used: fresh ? { continuations: 0, tokens: 0, since: Date.now() } : state.used };
    if (fresh) waiting = false;
    refresh(ctx);
  }
  function start(event: "set" | "resume") {
    if (!state.goal) return;
    pi.sendMessage({ customType: KICKOFF_TYPE, content: kickoff(state.goal, event), display: false }, { triggerTurn: true });
  }
  // Mark the goal out of budget and ask once for a wrap-up, inside a turn boundary.
  function limit(goal: Goal, reason: string, entries: any[]) {
    const next = snapshot("limit", { ...goal, status: "budget_limited" });
    state = { ...state, goal: next.goal };
    return {
      entries: [...entries,
        { type: "custom", customType: "goal", data: next },
        { type: "custom_message", customType: NOTE_TYPE, content: limitNote(reason), display: true, details: { kind: "limit", reason } }],
      continue: true,
    };
  }

  pi.on("session_start", (_event, ctx) => { reload(ctx); waiting = false; pending = undefined; refresh(ctx); });
  pi.on("session_tree", (_event, ctx) => { reload(ctx); waiting = false; refresh(ctx); });

  // The objective and its rules sit in a prompt section, and the goal tool is
  // declared, only while the goal is active; both change only with the goal.
  pi.events.on(DISCUSS, () => { discussing = true; });
  pi.on("before_agent_start", (event, ctx) => {
    reload(ctx);
    progressed = false; waiting = false; discussing = false;
    const options = event.systemPromptOptions;
    const text = section(state.goal);
    if (text) options.sections.goal = text; else delete options.sections.goal;
    const tools = options.selectedTools;
    if (Array.isArray(tools)) {
      const at = tools.indexOf("goal");
      if (text && at < 0) tools.push("goal");
      if (!text && at >= 0) tools.splice(at, 1);
    }
    prompted = text ? state.goal!.objective : undefined;
    refresh(ctx);
  });

  pi.on("tool_execution_end", (event) => { if (event.toolName !== "goal") progressed = true; });

  // A token budget can run out mid-run; stop there instead of at the next settle.
  pi.on("turn_end", (event, ctx) => {
    if (event.outcome !== "completed") return;
    reload(ctx);
    const goal = state.goal;
    if (!goal || goal.status !== "active" || goal.budget.tokens === undefined || prompted !== goal.objective) return;
    const reason = overBudget({ ...goal, budget: { tokens: goal.budget.tokens } }, state.used);
    return reason ? limit(goal, reason, event.entries) : undefined;
  });

  pi.on("agent_before_settle", (event, ctx) => {
    reload(ctx);
    const goal = state.goal;
    // A goal set during this run starts after it settles, with its prompt section.
    if (!goal || goal.status !== "active" || prompted !== goal.objective || event.continue) return;
    // A failed run, or one the user stopped to discuss, waits for them like a stop without progress.
    if (event.outcome !== "completed" || discussing) { waiting = true; refresh(ctx); return; }
    const decision = decide(state, progressed);
    if (decision.kind === "wait") { waiting = true; refresh(ctx); }
    if (decision.kind === "wait" || decision.kind === "none") return;
    pending = undefined; // This run already carries the goal on.
    if (decision.kind === "limit") return limit(goal, decision.reason, event.entries);
    progressed = false;
    const cap = goal.budget.continuations;
    return {
      entries: [...event.entries, {
        type: "custom_message", customType: NOTE_TYPE, content: continueNote(goal, state.used, decision.n), display: true,
        details: { kind: "continue", n: decision.n, cap, tokens: state.used.tokens },
      }],
      continue: true,
    };
  });

  // Escape pauses the goal; otherwise start goal work that was set mid-run.
  pi.on("agent_settled", (event, ctx) => {
    reload(ctx);
    const next = pending;
    pending = undefined;
    if (event.aborted && state.goal?.status === "active") save(ctx, snapshot("interrupt", { ...state.goal, status: "paused" }));
    if (!event.aborted && next && state.goal?.status === "active") { start(next); return; }
    const waiters = settled;
    settled = [];
    for (const resolve of waiters) resolve();
    refresh(ctx);
  });

  pi.registerTool({
    name: "goal",
    label: "Goal",
    description: "Close the session goal. complete: note gives the evidence. blocked: note names the blocker and what would clear it.",
    parameters: Type.Object({
      status: StringEnum(["complete", "blocked"] as const),
      note: Type.String(),
    }),
    defaultActive: false,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      reload(ctx);
      const next = close(state.goal, params.status, params.note);
      state = { ...state, goal: next.goal };
      refresh(ctx);
      const text = params.status === "complete"
        ? "Goal marked complete. Report the outcome and its evidence to the user."
        : "Goal marked blocked. Tell the user what blocks it and what would clear it, then stop.";
      return { content: [{ type: "text", text }], details: next };
    },
    renderCall(args: any, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("goal ")) + theme.fg("muted", args.status ?? ""), 0, 0);
    },
    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("muted", "Updating the goal…"), 0, 0);
      const details = result.details as Snapshot | undefined;
      if (!details?.goal || context.isError) {
        const first = result.content[0];
        return new Text(theme.fg("error", first?.type === "text" ? first.text : "Goal update failed"), 0, 0);
      }
      const done = details.goal.status === "complete";
      const head = done ? theme.fg("success", "✓ Goal complete") : theme.fg("warning", "⊘ Goal blocked");
      return new Text(`${head}\n${theme.fg("muted", details.goal.note ?? "")}`, 0, 0);
    },
  });

  // Lifecycle changes appear in the transcript; they never reach the model.
  pi.registerEntryRenderer("goal", (entry, _options, theme) => {
    const data = entry.data as Snapshot | undefined;
    const goal = data?.goal;
    const mark = theme.fg("accent", "◎ ");
    let text: string;
    switch (data?.event) {
      case "set": text = `${mark}${theme.bold("Goal")} ${goal?.objective ?? ""}`; break;
      case "resume": text = `${mark}Goal resumed`; break;
      case "pause": text = `${mark}Goal paused · /goal resume continues it`; break;
      case "interrupt": text = `${mark}Goal paused by the interruption · /goal resume continues it`; break;
      case "clear": text = `${mark}Goal cleared`; break;
      case "limit": text = theme.fg("warning", "◎ Goal budget spent; wrapping up"); break;
      case "budget": {
        const { continuations, tokens } = goal?.budget ?? {};
        text = `${mark}Goal budget: ${continuations ?? "unlimited"} continuations, ${tokens === undefined ? "no token limit" : `${amount(tokens)} tokens`}`;
        break;
      }
      default: text = `${mark}Goal ${goal ? label(goal.status) : "updated"}`;
    }
    return new Text(text, 1, 0);
  });

  pi.registerMessageRenderer(NOTE_TYPE, (message, options, theme) => {
    const details = message.details as { kind: string; n?: number; cap?: number; tokens?: number; reason?: string } | undefined;
    if (details?.kind === "limit") return new Text(theme.fg("warning", "◎ ") + theme.fg("muted", `Goal budget of ${details.reason} spent; asked to wrap up`), options.outputPad, 0);
    const of = details?.cap === undefined ? `${details?.n ?? "?"}` : `${details?.n ?? "?"}/${details.cap}`;
    return new Text(theme.fg("accent", "↻ ") + theme.fg("muted", `Goal continues ${of} · ${amount(details?.tokens ?? 0)} tokens`), options.outputPad, 0);
  });

  pi.registerCommand("goal", {
    description: "Set, show, pause, resume or clear the session goal",
    getArgumentCompletions: (prefix) => {
      if (prefix.includes(" ")) return null;
      const items = verbs.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      reload(ctx);
      const text = args.trim();
      const words = text.split(/\s+/);
      let next: Snapshot;
      if (!text) {
        if (ctx.hasUI) ctx.ui.notify(format(state), "info"); else console.log(format(state));
        return;
      }
      if (words.length === 1 && (words[0] === "pause" || words[0] === "resume" || words[0] === "clear")) next = transition(state.goal, words[0]);
      else if (words.length === 2 && (words[0] === "continuations" || words[0] === "tokens")) next = withBudget(state.goal, words[0], parseAmount(words[1], words[0]));
      else if (words.length === 1 && verbs.includes(words[0])) throw new Error(usage);
      else {
        if (isUnfinished(state.goal) && ctx.hasUI && !(await ctx.ui.confirm("Replace the current goal?", state.goal!.objective))) return;
        next = snapshot("set", create(text));
      }
      save(ctx, next);
      if (next.event !== "set" && next.event !== "resume") return;
      // Headless runs keep going until the goal stops, then report it.
      const done = ctx.hasUI ? undefined : new Promise<void>((resolve) => settled.push(resolve));
      if (ctx.isIdle()) start(next.event); else pending = next.event;
      if (done) {
        await done;
        await ctx.waitForIdle();
        reload(ctx);
        console.error(format(state));
        if (state.goal?.status !== "complete") process.exitCode = 1;
      }
    },
  });
}
