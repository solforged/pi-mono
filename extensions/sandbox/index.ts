// Routes Pi's file and shell tools into a per-worktree Apple container. On by
// default; Ctrl+Shift+S, /sandbox, `--sandbox off`, or settings turn it off.
import {
  createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition,
  createReadToolDefinition, createWriteToolDefinition, getAgentDir, getPackageDir,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { ContainerCli, runProcess } from "./container.ts";
import { buildPlan, promptNote, type Plan } from "./plan.ts";
import { cacheRoot, probe } from "./probe.ts";
import { imageTag, Sandbox, type Phase } from "./sandbox.ts";
import { chooseEnabled, resolveSettings } from "./settings.ts";
import { bashOps, editOps, findOps, grep, lsOps, readOps, writeOps } from "./tools.ts";

const STATUS = "sandbox";
const ICON = "\u{F01A7}";
export const SHORTCUT = "ctrl+shift+s";
const IMAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "image");

function globalSandboxSettings(agentDir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).sandbox;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`Cannot read sandbox settings from ${join(agentDir, "settings.json")}: ${error.message}`);
  }
}

const resolvePath = (path: string | undefined, cwd: string) => {
  const raw = (path || ".").replace(/^@/, "");
  return resolve(cwd, raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
};

// A session switch, fork, or reload replaces the extension instance inside one
// process. The running sandbox waits here for the next instance, so the
// container and anything running in it survive.
const handoff = globalThis as { __piSolSandbox?: Sandbox };
const REPLACED = new Set(["reload", "new", "resume", "fork"]);

export default function sandboxExtension(pi: ExtensionAPI) {
  pi.registerFlag("sandbox", { description: "Run tools in the Linux sandbox: on or off (default from settings)", type: "string" });

  let enabled = false;
  let source = "settings";
  let plan: Plan | undefined;
  let box: Sandbox | undefined;
  let inherited: Sandbox | undefined;
  let failure: Error | undefined;
  let commitAllowed: boolean | undefined;
  let ui: ExtensionContext | undefined;
  let generation = 0;
  let opening: Promise<void> | undefined;

  const render = (phase?: Phase) => {
    if (!ui?.hasUI) return;
    const { theme } = ui.ui;
    const state = !enabled ? "off" : failure ? "error" : phase ?? box?.phase ?? "starting";
    const text = state === "off" ? theme.fg("muted", `${ICON} off`)
      : state === "error" ? theme.fg("error", `${ICON}!`)
      : state === "building" ? theme.fg("dim", `${ICON} building`)
      : state === "ready" ? theme.fg("dim", ICON)
      : theme.fg("dim", `${ICON}…`);
    ui.ui.setStatus(STATUS, text);
  };

  const syncCommitTool = () => {
    if (!commitAllowed) return;
    const active = pi.getActiveTools().filter((name) => name !== "git_commit");
    pi.setActiveTools(enabled ? [...active, "git_commit"] : active);
  };

  function turnOn(ctx: ExtensionContext) {
    opening = open(ctx);
    return opening;
  }
  async function open(ctx: ExtensionContext) {
    const mine = ++generation;
    failure = undefined;
    try {
      const agentDir = getAgentDir();
      const facts = await probe(ctx.cwd, agentDir, getPackageDir());
      const settings = resolveSettings(globalSandboxSettings(agentDir), facts.root);
      const image = settings.image ?? await imageTag(IMAGE_DIR);
      if (mine !== generation) return;
      const next = buildPlan(facts, settings, image);
      const onPhase = (phase: Phase, detail?: string) => {
        if (phase === "error" && ui?.hasUI) ui.ui.notify(`Sandbox unavailable: ${detail}`, "error");
        render(phase);
      };
      const kept = inherited;
      inherited = undefined;
      if (kept?.fits(next)) {
        kept.options.onPhase = onPhase;
        plan = next; box = kept;
      } else {
        await kept?.release();
        if (mine !== generation) return;
        plan = next;
        box = new Sandbox(plan, { cli: new ContainerCli(), stateRoot: join(cacheRoot(), "state"), imageDir: settings.image ? undefined : IMAGE_DIR, onPhase });
      }
      render(box.phase === "idle" ? "starting" : box.phase);
      // Interactive sessions start at once so failures show early; print-mode
      // runs and child agents start on their first tool call.
      if (ctx.hasUI) box.ensure().catch(() => {});
    } catch (error) {
      if (mine !== generation) return;
      failure = error instanceof Error ? error : new Error(String(error));
      const kept = inherited;
      inherited = undefined;
      await kept?.release();
      render();
      if (ctx.hasUI) ctx.ui.notify(`Sandbox unavailable: ${failure.message}`, "error");
    }
  }

  async function turnOff(handOver = false) {
    generation++;
    const old = box ?? inherited;
    box = undefined; inherited = undefined; plan = undefined; failure = undefined; opening = undefined;
    if (!old) return;
    if (handOver) { old.options.onPhase = undefined; handoff.__piSolSandbox = old; }
    else await old.release();
  }

  async function setEnabled(next: boolean, ctx: ExtensionContext, why: string) {
    if (next === enabled) return;
    await apply(next, ctx, why);
  }
  async function apply(next: boolean, ctx: ExtensionContext, why: string) {
    enabled = next; source = why;
    // Children inherit this: workflow subagents through the environment, Rex children explicitly.
    process.env.PI_SANDBOX = next ? "on" : "off";
    syncCommitTool();
    if (next) await turnOn(ctx); else { await turnOff(); render(); }
  }

  // Fails closed: with the sandbox on, tools never fall back to the host.
  async function current(): Promise<Sandbox | undefined> {
    if (!enabled) return undefined;
    await opening;
    const reason = failure ?? (box ? await box.ensure().then(() => undefined, (error) => error as Error) : new Error("not started"));
    if (reason) throw new Error(`Sandbox unavailable: ${reason.message}. The user can retry with /sandbox restart or run tools on the host with /sandbox off (${SHORTCUT}).`);
    return box;
  }

  pi.on("session_start", async (_event, ctx) => {
    ui = ctx;
    inherited = handoff.__piSolSandbox;
    handoff.__piSolSandbox = undefined;
    // Checked once: later sessions in this process see our own changes. Children
    // started with --tools never get git_commit.
    commitAllowed ??= pi.getActiveTools().includes("git_commit");
    let choice;
    try {
      const settings = resolveSettings(globalSandboxSettings(getAgentDir()), ctx.cwd);
      choice = chooseEnabled(pi.getFlag("sandbox"), process.env.PI_SANDBOX, settings);
    } catch (error) {
      // An invalid configuration keeps the sandbox on and failing, never silently off.
      await turnOff();
      enabled = true; failure = error as Error; process.env.PI_SANDBOX = "on";
      syncCommitTool(); render();
      if (ctx.hasUI) ctx.ui.notify(`Sandbox unavailable: ${failure.message}`, "error");
      return;
    }
    await apply(choice.enabled, ctx, choice.source);
  });

  pi.on("session_shutdown", async (event) => {
    await turnOff(REPLACED.has(event.reason));
    ui = undefined;
  });

  const toggle = async (ctx: ExtensionContext) => {
    await setEnabled(!enabled, ctx, "toggle");
    if (ctx.hasUI) ctx.ui.notify(enabled ? "Sandbox on: tools run in the Linux container." : "Sandbox off: tools run on the host.", enabled ? "info" : "warning");
  };
  pi.registerShortcut(SHORTCUT, { description: "Toggle the tool sandbox", handler: toggle });

  pi.registerCommand("sandbox", {
    description: "Sandbox: status, on, off, toggle, or restart",
    getArgumentCompletions: (prefix: string) => ["status", "on", "off", "toggle", "restart"].filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "on" || action === "off") {
        await setEnabled(action === "on", ctx, "command");
      } else if (action === "toggle") {
        return toggle(ctx);
      } else if (action === "restart") {
        if (!enabled) return say(ctx, "The sandbox is off.", "warning");
        if (failure || !box) { await turnOff(); await turnOn(ctx); }
        else {
          render("starting");
          await box.restart().catch(() => {});
        }
      } else if (action !== "status") {
        return say(ctx, "Usage: /sandbox [status|on|off|toggle|restart]", "warning");
      }
      say(ctx, describe(), failure ? "error" : "info");
    },
  });

  function say(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error") {
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else console.log(text);
  }

  function describe() {
    if (!enabled) return `Sandbox off (${source}). Tools run on the host.`;
    if (failure || box?.error) return `Sandbox unavailable: ${(failure ?? box?.error)!.message}`;
    if (!plan) return "Sandbox starting.";
    const mounts = plan.mounts.map((m) => `  ${m.target}${m.target !== m.source ? ` <- ${m.source}` : ""} (${m.label}${m.readonly ? ", read-only" : ""})`);
    const phase = !box || box.phase === "idle" ? "not started (starts on the first tool call)" : box.phase;
    return [`Sandbox ${phase}: ${plan.name} (${plan.image}, ${plan.cpus} CPUs, ${plan.memory})`, "Mounts:", ...mounts,
      ...(plan.readOnlyPaths.length ? ["Read-only in the guest:", ...plan.readOnlyPaths.map((path) => `  ${path}`)] : [])].join("\n");
  }

  const route = <T extends { execute: (...args: any[]) => any }>(make: (cwd: string, sandbox?: Sandbox) => T) => ({
    ...make(process.cwd()),
    async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
      return make(ctx.cwd, await current()).execute(id, params, signal, onUpdate, ctx);
    },
  });
  pi.registerTool(route((cwd, s) => createReadToolDefinition(cwd, s ? { operations: readOps(s) } : undefined)));
  pi.registerTool(route((cwd, s) => createWriteToolDefinition(cwd, s ? { operations: writeOps(s) } : undefined)));
  pi.registerTool(route((cwd, s) => createEditToolDefinition(cwd, s ? { operations: editOps(s) } : undefined)));
  pi.registerTool(route((cwd, s) => createBashToolDefinition(cwd, s ? { operations: bashOps(s) } : undefined)));
  pi.registerTool(route((cwd, s) => createLsToolDefinition(cwd, s ? { operations: lsOps(s) } : undefined)));
  pi.registerTool(route((cwd, s) => createFindToolDefinition(cwd, s ? { operations: findOps(s) } : undefined)));
  const grepTool = createGrepToolDefinition(process.cwd());
  pi.registerTool({
    ...grepTool,
    async execute(id, params, signal, onUpdate, ctx) {
      const s = await current();
      if (!s) return createGrepToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
      return grep(s, params, resolvePath(params.path, ctx.cwd), signal);
    },
  });

  pi.on("user_bash", async () => {
    if (!enabled) return;
    try {
      return { operations: bashOps((await current())!) };
    } catch (error) {
      return { result: { output: (error as Error).message, exitCode: 1, cancelled: false, truncated: false } };
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (enabled && plan) return { systemPrompt: `${event.systemPrompt}\n\n${promptNote(plan)}` };
  });

  pi.registerTool({
    name: "git_commit",
    label: "git commit",
    description: "Commit the changes already staged with git add, on the host, where commit hooks and signing run. Use instead of git commit while the sandbox is on.",
    parameters: Type.Object({ message: Type.String({ description: "Complete commit message: header line, then an optional blank line and body" }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!enabled) throw new Error("The sandbox is off; run git commit with bash.");
      const result = await runProcess("git", ["-C", ctx.cwd, "commit", "--file", "-"], { input: params.message, signal, timeoutMs: 120000 });
      const text = `${result.stdout.toString("utf8")}${result.stderr}`.trim();
      if (result.aborted) throw new Error("aborted");
      if (result.code !== 0) throw new Error(text || `git commit exited with code ${result.code}`);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}
