import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { print } from "../shared/context.ts";
import { loadTitlePrompt, registerAutoname } from "./autoname.ts";
import { registerCommit } from "./commit.ts";
import { registerAutolearn } from "./autolearn-ui.ts";
import { registerLearning } from "./learning-ui.ts";
import { addUsage, bounded, emptyUsage, stopped } from "./process.ts";
import { resolveRole, roleNames } from "./roles.ts";
import { RoleStore } from "./role-store.ts";
import { showRoles } from "./roles-ui.ts";
import { describeLineup, registerPresets } from "./presets.ts";
import { createRunner, type Task, type ChildResult } from "./subagents.ts";
import { cancellable } from "./ui.ts";
import { scopeRoot } from "./state.ts";
import { recordUsage, showAuxiliaryUsage } from "./usage.ts";

export default async function (pi: ExtensionAPI) {
  const root = resolve(dirname(await realpath(fileURLToPath(import.meta.url))), "../..");
  const agentDir = getAgentDir();
  const roles = await RoleStore.create(root, agentDir);
  const getConfig = () => roles.snapshot();
  const config = getConfig();
  const lifetime = new AbortController();
  pi.on("session_shutdown", async () => {
    lifetime.abort(new Error("Workflow session closed"));
    // Pi may exit as soon as the handlers return, before a child that ignores SIGTERM is killed.
    await stopped();
  });
  pi.on("session_start", (_event, ctx) => { showAuxiliaryUsage(ctx); });
  let approvedInstructions = "";
  const instructionsText = (files: Array<{ path: string; content: string }> = []) => files.map((f) => `Instructions from ${f.path}:\n${f.content}`).join("\n\n");
  pi.on("before_agent_start", (event) => { approvedInstructions = instructionsText(event.systemPromptOptions.contextFiles); });

  function report(ctx: ExtensionContext, text: string) {
    if (lifetime.signal.aborted) return;
    pi.appendEntry("workflow-report", { text });
    if (!ctx.hasUI) print(ctx, text);
    else if (ctx.mode !== "tui") ctx.ui.notify(text, "info");
  }
  pi.registerEntryRenderer("workflow-report", (entry) => new Text((entry.data as { text: string }).text, 0, 0));
  let editingRoles = false;
  pi.registerCommand("roles", {
    description: "Edit model roles; /roles show or /roles check prints effective settings",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (!["", "show", "check"].includes(action)) throw new Error("Usage: /roles [show|check]");
      if (!action && ctx.mode === "tui") {
        if (editingRoles) { ctx.ui.notify("The roles panel is already open", "info"); return; }
        editingRoles = true;
        try {
          if (await showRoles(ctx, roles, lifetime.signal)) {
            const saved = getConfig();
            report(ctx, `Saved ${saved.profile}${saved.preset === undefined ? "" : ` ${saved.preset} preset`} roles. New tasks use the saved choices; running tasks are unchanged.`);
          }
        } finally { editingRoles = false; }
        return;
      }
      const current = getConfig();
      const lines = [`Workflow profile: ${current.profile}`, ...current.sources.map((source) => `Config: ${source}`), `State: ${await scopeRoot(agentDir, current.profile, ctx.cwd)}`];
      if (current.preset !== undefined) lines.push(`Preset: ${current.preset} of ${current.presets.join(", ")} (/modelpreset switches)`, describeLineup(current)[0]);
      for (const name of roleNames) {
        const role = current.roles[name];
        let line = `${name}: ${role ? `${role.provider}/${role.model} (${role.thinking})` : "not configured"}`;
        if (args.trim() === "check") {
          try { resolveRole(current, name, ctx.modelRegistry); line += " · registered; auth configured (not a network test)"; }
          catch (error) { line += ` · ${String(error)}`; }
        }
        lines.push(line);
      }
      lines.push("Use /roles in the TUI to edit and save without reloading. Manual JSON edits require /reload. No provider fallbacks.");
      report(ctx, lines.join("\n"));
    },
  });
  const run = createRunner(pi, getConfig, root, agentDir, lifetime.signal);
  const item = Type.Object({
    agent: StringEnum(["advisor", "scout", "researcher", "worker"] as const),
    task: Type.String(),
    context: Type.Optional(Type.String()),
  });
  function summarize(results: ChildResult[]) {
    return results.map((r) => `${r.agent} · ${r.provider}/${r.model} · ${r.status}\n${r.text}\nTranscript: ${r.transcript}${r.worktree ? `\nDetached worktree (not integrated): ${r.worktree}` : ""}`).join("\n\n");
  }
  pi.registerTool({
    name: "subagent", label: "Subagent",
    // Sent with every request: keep it short. The runner validates tasks; limits are in docs/subagents.md.
    description: `Run 1-${config.subagents.maxTasks} independent bounded tasks in parallel. advisor/scout/researcher (web) only read; worker edits a clean-HEAD worktree you review and integrate. Give each task its context (not the whole conversation) and the expected result.`,
    parameters: Type.Object({ tasks: Type.Array(item) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const results = await run(params.tasks, ctx, approvedInstructions, signal ?? lifetime.signal, (text) => {
        if (!lifetime.signal.aborted) onUpdate?.({ content: [{ type: "text", text }] });
      });
      const usage = results.reduce((sum, result) => addUsage(sum, result.usage), emptyUsage());
      return { content: [{ type: "text", text: summarize(results) }], details: { results }, usage };
    },
  });
  for (const command of ["advisor", "subagent"] as const) {
    pi.registerCommand(command, {
      description: command === "advisor" ? "Ask the advisor about the current conversation/repository" : "Run /subagent <advisor|scout|researcher|worker> <task>",
      handler: async (args, ctx) => {
        await ctx.waitForIdle(); lifetime.signal.throwIfAborted();
        const match = command === "advisor" ? ["", "advisor", args] : /^(advisor|scout|researcher|worker)\s+([\s\S]+)$/.exec(args.trim());
        if (!match || !match[2]?.trim()) throw new Error(`Usage: /${command} ${command === "subagent" ? "<advisor|scout|researcher|worker> " : ""}<task>`);
        const recent = ctx.sessionManager.getBranch().filter((e: any) => e.type === "message" && ["user", "assistant"].includes(e.message.role)).slice(-8).map((e: any) => {
          const content = e.message.content;
          return `${e.message.role}: ${typeof content === "string" ? content : content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")}`;
        }).join("\n\n");
        const task: Task = { agent: match[1] as Task["agent"], task: match[2], context: bounded(recent, 12000) };
        const instructions = instructionsText(ctx.getSystemPromptOptions().contextFiles);
        const results = await cancellable(ctx, `Running ${task.agent}`, lifetime.signal, (signal) => run([task], ctx, instructions, signal));
        if (!results || lifetime.signal.aborted) return;
        const usage = results.reduce((sum, result) => addUsage(sum, result.usage), emptyUsage());
        recordUsage(pi, ctx, { role: task.agent, usage });
        pi.sendMessage({ customType: "workflow-subagent", content: summarize(results), display: true }, { triggerTurn: false });
        if (!ctx.hasUI) print(ctx, summarize(results));
      },
    });
  }
  registerPresets(pi, roles, agentDir, lifetime.signal, report);
  const titlePrompt = await loadTitlePrompt(root, agentDir);
  registerAutoname(pi, getConfig, titlePrompt, lifetime.signal);
  registerCommit(pi, getConfig, agentDir, lifetime.signal, report);
  registerLearning(pi, getConfig, agentDir, lifetime.signal, report);
  registerAutolearn(pi, getConfig, agentDir, lifetime.signal, report, { list: (cwd) => SessionManager.list(cwd), open: (path) => SessionManager.open(path) });
}
