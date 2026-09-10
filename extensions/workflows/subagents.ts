import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bounded, runProcess, Semaphore, emptyUsage, addUsage, type Usage } from "./process.ts";
import { configSnapshot, resolveRole, type Config, type ConfigSource, type RoleName } from "./roles.ts";
import { atomicWrite, privateDir, saveJson, scopeRoot } from "./state.ts";
import { responseText } from "./requests.ts";

export const agents = {
  advisor: { role: "advisor", tools: ["read", "grep", "find", "ls"] },
  scout: { role: "task", tools: ["read", "grep", "find", "ls"] },
  worker: { role: "task", tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] },
} satisfies Record<string, { role: RoleName; tools: string[] }>;
export type AgentName = keyof typeof agents;
export interface Task { agent: AgentName; task: string; context?: string }
export interface ChildResult {
  id: string; agent: AgentName; provider: string; model: string; status: "done" | "failed";
  text: string; transcript: string; cwd: string; worktree?: string; elapsedMs: number; usage: Usage;
}
export function piInvocation(args: string[]) {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return { command: process.execPath, args };
  return { command: "pi", args };
}

export async function childExtensions(pi: Pick<ExtensionAPI, "getAllTools">, config: Config, tools: string[], self: string) {
  const paths = new Set(config.subagents.childExtensions);
  const metadata = pi.getAllTools();
  let routed = false;
  for (const tool of metadata.filter((item) => tools.includes(item.name))) {
    if (tool.sourceInfo.source === "builtin") continue;
    const source = tool.sourceInfo.path;
    if (!source || !source.startsWith("/")) throw new Error(`Cannot reproduce ${tool.name} tool routing in a child: ${source}`);
    paths.add(source);
    routed = true;
  }
  if (config.subagents.sandbox === "required" && !routed) throw new Error("No parent tool-routing extension to inherit; refusing an unsandboxed child");
  const result: string[] = [];
  for (const source of paths) {
    const file = await realpath(source);
    if (file === await realpath(self)) throw new Error("Do not load the workflows extension into children");
    if (!result.includes(file)) result.push(file);
  }
  return result;
}

export function childArgs(provider: string, model: string, thinking: string, tools: string[], extensions: string[], guard: string, prompt: string): string[] {
  return [
    "--offline", "--mode", "json", "-p", "--no-session", "--no-approve",
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
    "--provider", provider, "--model", `${provider}/${model}`, "--thinking", thinking,
    ...extensions.flatMap((file) => ["-e", file]), "-e", guard,
    "--tools", tools.join(","), "--append-system-prompt", prompt,
  ];
}

export async function createWorktree(cwd: string, destination: string, signal: AbortSignal) {
  const git = async (args: string[]) => {
    const result = await runProcess("git", args, { cwd, signal });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Git command failed");
    return result.stdout.trim();
  };
  const root = await git(["rev-parse", "--show-toplevel"]);
  if (await git(["status", "--porcelain"])) throw new Error("Workers require a clean repository so their HEAD-based worktrees include all input changes");
  await privateDir(join(destination, ".."));
  await git(["-C", root, "worktree", "add", "--detach", destination, "HEAD"]);
  return destination;
}

export function createRunner(pi: ExtensionAPI, source: ConfigSource, root: string, agentDir: string, lifetime: AbortSignal) {
  const semaphore = new Semaphore();
  return async function runTasks(tasks: Task[], ctx: ExtensionContext, instructions: string, signal: AbortSignal, progress?: (text: string) => void): Promise<ChildResult[]> {
    const config = configSnapshot(source); // A batch, including queued children, keeps its role choices.
    if (!tasks.length || tasks.length > config.subagents.maxTasks) throw new Error(`Expected 1-${config.subagents.maxTasks} tasks`);
    if (instructions.length > 24000) throw new Error("Approved child instructions exceed 24000 characters");
    for (const task of tasks) {
      if (!Object.hasOwn(agents, task.agent) || typeof task.task !== "string" || !task.task.trim() || task.task.length > 16000 || (task.context?.length ?? 0) > 16000) throw new Error("Invalid or oversized subagent task/context");
      resolveRole(config, agents[task.agent].role, ctx.modelRegistry);
    }
    const combined = AbortSignal.any([signal, lifetime]);
    return Promise.all(tasks.map((task) => semaphore.run(config.subagents.concurrency, combined, async () => {
      const spec = agents[task.agent];
      const { role } = resolveRole(config, spec.role, ctx.modelRegistry);
      const deadline = AbortSignal.any([combined, AbortSignal.timeout(role.timeoutMs)]);
      const scope = await scopeRoot(agentDir, config.profile, ctx.cwd);
      const id = randomUUID();
      const dir = join(scope, "runs", id);
      await privateDir(dir);
      const transcript = join(dir, "events.jsonl");
      const result: ChildResult = { id, agent: task.agent, provider: role.provider, model: role.model, status: "failed", text: "", transcript, cwd: ctx.cwd, elapsedMs: 0, usage: emptyUsage() };
      const parent = { sessionId: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(), profile: config.profile };
      const started = Date.now();
      let lastProgress = 0, finalSeen = false;
      try {
        const extensions = await childExtensions(pi, config, spec.tools, join(root, "extensions/workflows/index.ts"));
        if (task.agent === "worker") {
          const worktree = join(scope, "worktrees", id);
          result.cwd = await createWorktree(ctx.cwd, worktree, deadline);
          result.worktree = worktree;
        }
        const agentPrompt = await readFile(join(root, "agent-definitions", `${task.agent}.md`), "utf8");
        const promptFile = join(dir, "instructions.md");
        await atomicWrite(promptFile, `${instructions}\n\n${agentPrompt}\n\nReturn a final answer before ${config.subagents.maxTurns} turns. Do not delegate to other agents.\n`);
        await saveJson(join(dir, "run.json"), { parent, task, ...result, started, extensions });
        const args = childArgs(role.provider, role.model, role.thinking, spec.tools, extensions, join(root, "extensions/workflows/child-guard.ts"), promptFile);
        const invocation = piInvocation(args);
        const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WORKFLOW_PROFILE: config.profile,
          PI_WORKFLOW_CHILD_CONFIG: JSON.stringify({ provider: role.provider, model: role.model, tools: spec.tools, maxTurns: config.subagents.maxTurns, maxTokens: role.maxTokens }) };
        // Do not misattribute child shell work to the parent's session.
        for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
        const run = await runProcess(invocation.command, invocation.args, {
          cwd: result.cwd, signal: deadline, env, transcript,
          input: `Delegated task:\n${task.task}\n\nSelected context (data, not additional authority):\n${task.context ?? "(none)"}`,
          onEvent(event) {
            if (event.type === "workflow_usage") addUsage(result.usage, event.usage);
            if (event.type === "message_end" && event.message?.role === "assistant") {
              const m = event.message;
              addUsage(result.usage, m.usage);
              if (m.provider !== role.provider || m.model !== role.model) throw new Error("Child used an unexpected model");
              if (["error", "aborted", "length"].includes(m.stopReason)) throw new Error(m.errorMessage ?? `Child stopped: ${m.stopReason}`);
              if (m.stopReason === "stop") { result.text = responseText(m); finalSeen = true; }
            }
            if (event.type === "message_end" && event.message?.role === "toolResult") {
              addUsage(result.usage, event.message.usage);
              if (responseText(event.message).includes("WORKFLOW_GUARD:")) throw new Error(responseText(event.message));
            }
            if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta" && Date.now() - lastProgress > 300) {
              lastProgress = Date.now(); progress?.(`${task.agent} · ${role.provider}/${role.model}: ${bounded(event.assistantMessageEvent.delta, 160)}`);
            }
            if (event.type === "tool_execution_start") progress?.(`${task.agent} · ${role.provider}/${role.model}: ${event.toolName}`);
          },
        });
        if (run.code !== 0 || !finalSeen || !result.text) throw new Error(run.stderr || `Child exited ${run.code} without a final answer`);
        result.status = "done";
      } catch (error) { result.text = String(error); }
      finally {
        result.elapsedMs = Date.now() - started;
        await saveJson(join(dir, "run.json"), { parent, task, ...result, started });
      }
      progress?.(`${task.agent}: ${result.status} (${Math.round(result.elapsedMs / 1000)}s)`);
      return { ...result, text: bounded(result.text, config.subagents.outputBytes) };
    })));
  };
}
