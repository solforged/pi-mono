import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DISCUSS } from "../ask/model.ts";
import { userStarted } from "../continue/started.ts";
import { report } from "../shared/context.ts";
import { showPanel } from "./panel.ts";
import {
  apply, counts, empty, format, limits, open, reminder, restated, restore, section, statuses, tally, withParentTodos,
  type Item, type List, type Operation, type Status,
} from "./store.ts";
import { resultRows, widgetLines } from "./view.ts";

// Keep the declaration small: it is sent with every request. Clearing
// finished items is left to /todos.
const actions = ["list", "add", "update", "remove"] as const;
type Details = List & { action: string; summary?: string };

export default function (pi: ExtensionAPI) {
  let list: List = empty();
  let reminders = 0;     // Reminders sent since the user's last prompt.
  let progressed = false; // A tool ran since that prompt or the last reminder.
  let discussing = false; // The user ended an ask to talk; cleared when the next run starts.
  let running = false;    // Between a run's start and its settle.
  let prompted: string | undefined; // The <todos> section that run's prompt carries.

  function refresh(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    if (!open(list).length) { ctx.ui.setWidget("todo", undefined); return; }
    const shown = list;
    // Drawn every frame; the rows change only with the list, the width or the theme.
    ctx.ui.setWidget("todo", (_tui, theme) => {
      let drawn: { width: number; lines: string[] } | undefined;
      return {
        render: (width: number) => (drawn?.width === width ? drawn : drawn = { width, lines: widgetLines(shown, width, theme) }).lines,
        invalidate() { drawn = undefined; },
      };
    });
  }
  function sync(ctx: ExtensionContext) { list = restore(ctx.sessionManager.getBranch()); refresh(ctx); }
  // Edits outside the tool are recorded as custom entries on the branch.
  function save(ctx: ExtensionContext, next: List) { list = next; pi.appendEntry("todo", next); refresh(ctx); }

  pi.on("session_start", (_event, ctx) => sync(ctx));
  pi.on("session_tree", (_event, ctx) => sync(ctx));
  pi.events.on(DISCUSS, () => { discussing = true; });
  pi.on("before_agent_start", (event) => {
    discussing = false;
    if (userStarted(event)) { reminders = 0; progressed = false; }
    const sections = event.systemPromptOptions.sections;
    const text = event.systemPromptOptions.selectedTools?.includes("todo") ? section(list) : undefined;
    if (text) sections.todos = text; else delete sections.todos;
    running = true; prompted = text;
  });
  pi.on("agent_settled", () => { running = false; });
  pi.on("tool_execution_end", () => { progressed = true; });

  // Pi takes a section only when a run starts, so a compaction inside a long
  // run replays the list from that start and summarizes away the calls that
  // changed it since. Restate the list once, after the summary. Between runs
  // the next start refreshes the section itself.
  pi.on("session_compact", () => {
    if (!running || !pi.getActiveTools().includes("todo") || section(list) === prompted) return;
    pi.sendMessage({ customType: "todo-state", content: restated(list), display: false });
  });

  // Remind the agent once per stop while it keeps making progress, at most three
  // times per prompt. Aborted runs skip this event; print and JSON runs are left alone.
  // A run that failed, that the user stopped to discuss, or that another
  // extension is already continuing is not pushed on.
  pi.on("agent_before_settle", (event, ctx) => {
    if (event.outcome !== "completed" || event.continue || discussing) return;
    if (!ctx.hasUI || !progressed || reminders >= limits.reminders || !pi.getActiveTools().includes("todo")) return;
    const content = reminder(list, reminders + 1);
    if (!content) return;
    reminders++; progressed = false;
    return {
      entries: [...event.entries, { type: "custom_message", customType: "todo-reminder", content, display: true, details: { count: reminders, open: open(list).length } }],
      continue: true,
    };
  });
  pi.registerMessageRenderer("todo-reminder", (message, options, theme) => {
    const details = message.details as { count: number; open: number } | undefined;
    return new Text(theme.fg("warning", "↻ ") + theme.fg("muted", `Todo reminder ${details?.count ?? "?"}/${limits.reminders}: ${details?.open ?? "?"} open item(s)`), options.outputPad, 0);
  });

  // Delegated children get the parent's open items as context, never write access.
  pi.on("tool_call", (event) => {
    if (!open(list).length) return;
    const input = event.input as any;
    const add = (target: any) => { const next = withParentTodos(target.context, list); if (next !== undefined) target.context = next; };
    if (event.toolName === "rex_agent" || (event.toolName === "rex_send" && input.mode === "followup")) add(input);
    else if (event.toolName === "subagent" && Array.isArray(input.tasks)) input.tasks.forEach(add);
  });

  function operation(params: any): Operation {
    switch (params.action) {
      case "add":
        if (!params.items?.length) throw new Error('Provide "items" for add');
        return { action: "add", items: params.items };
      case "update":
        if (params.id === undefined) throw new Error('Provide "id" for update');
        return { action: "update", id: params.id, change: { text: params.text, status: params.status, note: params.note } };
      case "remove":
        if (params.id === undefined) throw new Error('Provide "id" for remove');
        return { action: "remove", id: params.id };
      default: throw new Error(`Unknown todo action: ${params.action}`);
    }
  }

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Session todo list. add: items; update: id, status/text/note; remove: id.",
    parameters: Type.Object({
      action: StringEnum(actions),
      items: Type.Optional(Type.Array(Type.String())),
      id: Type.Optional(Type.Integer()),
      status: Type.Optional(StringEnum(statuses)),
      text: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      let summary: string | undefined;
      if (params.action !== "list") ({ list, summary } = apply(list, operation(params)));
      refresh(ctx);
      // Details carry the full snapshot so the branch can be restored.
      const details: Details = { action: params.action, summary, ...list };
      return { content: [{ type: "text", text: summary ? `${summary}. ${tally(list)}.` : format(list) }], details };
    },
    renderCall(args: any, theme) {
      let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action ?? "");
      if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
      if (args.status) text += ` ${theme.fg("muted", `→ ${args.status}`)}`;
      if (args.items?.length) text += ` ${theme.fg("dim", args.items.length === 1 ? `"${args.items[0]}"` : `${args.items.length} items`)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = result.details as Details | undefined;
      if (isPartial) return new Text(theme.fg("muted", "Updating the todo list…"), 0, 0);
      if (!details) {
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(context.isError ? theme.fg("error", text) : text, 0, 0);
      }
      const rows = resultRows(details, expanded, theme);
      const lines = [theme.fg(details.summary ? "success" : "muted", details.summary ?? tally(details)), ...rows.lines];
      if (rows.hidden) lines.push(theme.fg("dim", `… ${rows.hidden} more (${context.keyHint("app.tools.expand", "to expand")})`));
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  const subcommands: Record<string, Status> = { start: "in_progress", done: "done", reopen: "pending" };
  const usage = "Usage: /todos [list|add <text>|start <id>|block <id> [reason]|done <id>|reopen <id>|rm <id>|clear]";
  const id = (value: string) => {
    if (!/^#?\d+$/.test(value)) throw new Error(usage);
    return Number(value.replace("#", ""));
  };
  const change = (ctx: ExtensionContext, op: Operation) => { const result = apply(list, op); save(ctx, result.list); return result; };

  async function panel(ctx: ExtensionCommandContext) {
    let selected: number | undefined;
    for (;;) {
      const action = await showPanel(ctx, list, selected);
      if (!action) return;
      try {
        if (action.kind === "add") {
          const text = await ctx.ui.input("New todo", "Describe the item");
          if (text?.trim()) selected = change(ctx, { action: "add", items: [text] }).list.nextId - 1;
          continue;
        }
        if (action.kind === "clear") {
          const { done } = counts(list.items);
          if (done && await ctx.ui.confirm("Clear finished items?", `Remove ${done} finished item(s) from this session's list?`)) change(ctx, { action: "clear_done" });
          continue;
        }
        selected = action.id;
        const item = list.items.find((entry) => entry.id === action.id)!;
        const update = (next: Item["status"]) => change(ctx, { action: "update", id: item.id, change: { status: next } });
        const editNote = async () => {
          const note = await ctx.ui.editor(`Note for #${item.id} (empty removes it)`, item.note ?? "");
          if (note !== undefined) change(ctx, { action: "update", id: item.id, change: { note } });
        };
        if (action.kind === "toggle") { update(item.status === "done" ? "pending" : "done"); continue; }
        if (action.kind === "note") { await editNote(); continue; }
        const choices: Record<string, () => Promise<unknown> | unknown> = {};
        if (item.status !== "in_progress") choices["Start"] = () => update("in_progress");
        if (item.status !== "done") choices["Mark done"] = () => update("done");
        if (item.status !== "blocked") choices["Mark blocked…"] = async () => {
          const reason = await ctx.ui.input(`What is #${item.id} waiting on?`, "Optional reason");
          if (reason !== undefined) change(ctx, { action: "update", id: item.id, change: { status: "blocked", ...(reason.trim() ? { note: reason } : {}) } });
        };
        if (item.status !== "pending") choices["Mark pending"] = () => update("pending");
        choices["Edit text"] = async () => {
          const text = await ctx.ui.editor(`Edit #${item.id}`, item.text);
          if (text?.trim()) change(ctx, { action: "update", id: item.id, change: { text } });
        };
        choices["Edit note"] = editNote;
        choices["Remove"] = async () => {
          if (await ctx.ui.confirm(`Remove #${item.id}?`, item.text)) change(ctx, { action: "remove", id: item.id });
        };
        const choice = await ctx.ui.select(`#${item.id} ${item.text}`, [...Object.keys(choices), "Back"]);
        if (choice && choices[choice]) await choices[choice]();
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  }

  pi.registerCommand("todos", {
    description: "Show or edit this session's todo list",
    getArgumentCompletions: (prefix) => {
      const items = ["list", "add", "start", "block", "done", "reopen", "rm", "clear"].filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const [verb = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const value = rest.join(" ");
      if (!verb && ctx.mode === "tui") { await panel(ctx); return; }
      if (!verb || verb === "list") { report(ctx, format(list)); return; }
      let op: Operation;
      if (verb === "add" && value) op = { action: "add", items: [value] };
      else if (Object.hasOwn(subcommands, verb) && rest.length === 1) op = { action: "update", id: id(value), change: { status: subcommands[verb] } };
      else if (verb === "block" && rest.length >= 1) {
        const reason = rest.slice(1).join(" ");
        op = { action: "update", id: id(rest[0]), change: { status: "blocked", ...(reason ? { note: reason } : {}) } };
      }
      else if (verb === "rm" && rest.length === 1) op = { action: "remove", id: id(value) };
      else if (verb === "clear" && !value) op = { action: "clear_done" };
      else throw new Error(usage);
      report(ctx, `${change(ctx, op).summary}.`);
    },
  });
}
