import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerAutoname } from "./autoname.ts";
import { registerCommit } from "./commit.ts";
import { registerLearning } from "./learning-ui.ts";
import { addUsage, bounded, emptyUsage } from "./process.ts";
import { resolveRole, roleNames } from "./roles.ts";
import { RoleStore } from "./role-store.ts";
import { showRoles } from "./roles-ui.ts";
import { createRunner, type Task, type ChildResult } from "./subagents.ts";
import { cancellable } from "./ui.ts";
import { scopeRoot } from "./state.ts";

export default async function (pi: ExtensionAPI) {
  const root = resolve(dirname(await realpath(fileURLToPath(import.meta.url))), "../..");
  const agentDir = getAgentDir();
  const roles = await RoleStore.create(root, agentDir);
  const getConfig = () => roles.snapshot();
  const config = getConfig();
  const lifetime = new AbortController();
  pi.on("session_shutdown", () => { lifetime.abort(new Error("Workflow session closed")); });
  let approvedInstructions = "";
  const instructionsText = (files: Array<{ path: string; content: string }> = []) => files.map((f) => `Instructions from ${f.path}:\n${f.content}`).join("\n\n");
  pi.on("before_agent_start", (event) => { approvedInstructions = instructionsText(event.systemPromptOptions.contextFiles); });

  function report(ctx: ExtensionContext, text: string) {
    if (lifetime.signal.aborted) return;
    pi.appendEntry("workflow-report", { text });
    if (!ctx.hasUI) console.log(text);
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
            report(ctx, `Saved ${config.profile} roles. New tasks use the saved choices; running tasks are unchanged.`);
          }
        } finally { editingRoles = false; }
        return;
      }
      const current = getConfig();
      const lines = [`Workflow profile: ${current.profile}`, ...current.sources.map((source) => `Config: ${source}`)];
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
  pi.registerCommand("workflows", {
    description: "Show workflow state location and auxiliary model usage",
    handler: async (_args, ctx) => {
      const usage = emptyUsage();
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "workflow-usage") addUsage(usage, (entry.data as any)?.usage);
      }
      report(ctx, `State: ${await scopeRoot(agentDir, config.profile, ctx.cwd)}\nAuxiliary calls (titles/reviews/command subagents): ${usage.totalTokens} tokens; catalog cost $${usage.cost.total.toFixed(4)}. Tool subagent usage is included in pi's normal totals. Missing provider prices may report zero.\nCommands: /roles, /autoname, /commit, /advisor, /subagent, /learn, /learn-sessions, /learn-review, /curate-skills`);
    },
  });

  const run = createRunner(pi, getConfig, root, agentDir, lifetime.signal);
  const item = Type.Object({
    agent: StringEnum(["advisor", "scout", "worker"] as const),
    task: Type.String({ minLength: 1, maxLength: 16000, description: "Self-contained task and expected result" }),
    context: Type.Optional(Type.String({ maxLength: 16000, description: "Selected context; do not copy the entire conversation" })),
  });
  function summarize(results: ChildResult[]) {
    return results.map((r) => `${r.agent} · ${r.provider}/${r.model} · ${r.status}\n${r.text}\nTranscript: ${r.transcript}${r.worktree ? `\nDetached worktree (not integrated): ${r.worktree}` : ""}`).join("\n\n");
  }
  pi.registerTool({
    name: "subagent", label: "Subagent",
    description: `Delegate 1-${config.subagents.maxTasks} independent tasks. Advisor/scout are read/search-only; workers use separate clean-HEAD Git worktrees. Inherits parent tool-routing extensions, not a new security boundary. No recursive delegation. Results are capped at ${config.subagents.outputBytes} bytes each; full private transcripts are retained.`,
    promptSnippet: "Delegate focused work to an advisor, scout, or isolated editing worker",
    promptGuidelines: ["Use subagent for independent bounded tasks. Include the context it needs and an expected result. Review worker changes before integrating them; never assume a worktree changed the main checkout."],
    parameters: Type.Object({ tasks: Type.Array(item, { minItems: 1, maxItems: config.subagents.maxTasks }) }),
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
      description: command === "advisor" ? "Ask the advisor about the current conversation/repository" : "Run /subagent <advisor|scout|worker> <task>",
      handler: async (args, ctx) => {
        await ctx.waitForIdle(); lifetime.signal.throwIfAborted();
        const match = command === "advisor" ? ["", "advisor", args] : /^(advisor|scout|worker)\s+([\s\S]+)$/.exec(args.trim());
        if (!match || !match[2]?.trim()) throw new Error(`Usage: /${command} ${command === "subagent" ? "<advisor|scout|worker> " : ""}<task>`);
        const recent = ctx.sessionManager.getBranch().filter((e: any) => e.type === "message" && ["user", "assistant"].includes(e.message.role)).slice(-8).map((e: any) => {
          const content = e.message.content;
          return `${e.message.role}: ${typeof content === "string" ? content : content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")}`;
        }).join("\n\n");
        const task: Task = { agent: match[1] as Task["agent"], task: match[2], context: bounded(recent, 12000) };
        const instructions = instructionsText(ctx.getSystemPromptOptions().contextFiles);
        const results = await cancellable(ctx, `Running ${task.agent}`, lifetime.signal, (signal) => run([task], ctx, instructions, signal));
        if (!results || lifetime.signal.aborted) return;
        const usage = results.reduce((sum, result) => addUsage(sum, result.usage), emptyUsage());
        pi.appendEntry("workflow-usage", { role: task.agent, usage });
        pi.sendMessage({ customType: "workflow-subagent", content: summarize(results), display: true }, { triggerTurn: false });
        if (!ctx.hasUI) console.log(summarize(results));
      },
    });
  }
  const titlePrompt = await readFile(join(root, "TITLE_SYSTEM.md"), "utf8");
  registerAutoname(pi, getConfig, titlePrompt, lifetime.signal);
  registerCommit(pi, getConfig, agentDir, lifetime.signal, report);
  registerLearning(pi, getConfig, agentDir, lifetime.signal, report);
}
