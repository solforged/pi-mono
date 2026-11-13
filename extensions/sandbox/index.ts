// Routes Pi's file and shell tools into a per-worktree Apple container. On by
// default; Ctrl+Shift+S, /sandbox, `--sandbox off`, or settings turn it off.
import {
  createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition,
  createReadToolDefinition, createWriteToolDefinition, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getAgentDir, getPackageDir,
  truncateHead, type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Browser, parseCommand, which } from "./browser.ts";
import { shareCargoTarget } from "./cargo.ts";
import { ContainerCli, runProcess } from "./container.ts";
import { buildPlan, promptNote, type Plan } from "./plan.ts";
import { cacheRoot, commonDirOf, findRoot, probe } from "./probe.ts";
import { imageTag, Sandbox, type Phase } from "./sandbox.ts";
import { chooseEnabled, inheritedSwitch, resolveSettings } from "./settings.ts";
import { savedToggle, saveToggle, togglesFile } from "./toggles.ts";
import { GUEST_COMMAND, SANDBOX_CHANGED, type GuestCommandRequest } from "./guest.ts";
import { repath, shareOutput } from "./output.ts";
import { bashOps, editOps, findOps, grep, lsOps, readOps, writeOps } from "./tools.ts";

const STATUS = "sandbox";
// Nerd Font md-cube; shown only while the sandbox is on.
const ON = "\u{F01A6}";
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
// `__piSolSandboxOn` names the repository the outgoing session had the sandbox on in.
const handoff = globalThis as { __piSolSandbox?: Sandbox; __piSolSandboxBrowser?: Browser; __piSolSandboxOn?: string };
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
  let browserAllowed: boolean | undefined;
  // Why the browser tool is unavailable in this session, if it is.
  let browserProblem: string | undefined = "not started";
  let ui: ExtensionContext | undefined;
  let generation = 0;
  let opening: Promise<void> | undefined;
  let projectRoot: string | undefined;
  let repository: string | undefined;
  let settingsDefault = true;

  // The status line extension shows the marker after the cost; Pi's own footer
  // shows the same marker as an extension status. Off shows nothing.
  const render = (phase?: Phase) => {
    if (!ui?.hasUI) return;
    const state = !enabled ? "off" : failure ? "error" : phase ?? box?.phase ?? "starting";
    if (state === "off") {
      ui.ui.setStatus(STATUS, undefined);
      pi.events.emit("statusline:segment", { key: STATUS });
      return;
    }
    const [text, color] = state === "error" ? [`${ON}!`, "error"]
      : state === "building" ? [`${ON} building`, "muted"]
      : state === "ready" ? [ON, "success"]
      : [`${ON}…`, "muted"];
    ui.ui.setStatus(STATUS, ui.ui.theme.fg(color as any, text));
    pi.events.emit("statusline:segment", { key: STATUS, text, color, priority: 8 });
  };

  // git_commit and browser exist only while the sandbox is on, and never in
  // children started with --tools that leave them out.
  const syncCommitTool = () => {
    const extra = [
      ...(commitAllowed ? ["git_commit"] : []),
      ...(browserAllowed && !browserProblem ? ["browser"] : []),
    ];
    const active = pi.getActiveTools().filter((name) => name !== "git_commit" && name !== "browser");
    const next = enabled ? [...active, ...extra] : active;
    const before = pi.getActiveTools();
    if (next.length !== before.length || next.some((name, i) => name !== before[i])) pi.setActiveTools(next);
  };

  // One browser per Pi process: it survives session switches and closes when
  // the sandbox turns off or Pi quits.
  const browser = () => handoff.__piSolSandboxBrowser ??= new Browser({
    run: runProcess, terminalBrowser: which("terminal-browser")!, rex: which("rex") ?? (process.env.REX_BIN_DIR ? which("rex", process.env.REX_BIN_DIR) : undefined),
    container: which("container")!, stateRoot: join(cacheRoot(), "state"), env: process.env,
  });
  const closeBrowser = async () => {
    const open = handoff.__piSolSandboxBrowser;
    handoff.__piSolSandboxBrowser = undefined;
    await open?.close().catch(() => {});
  };
  const findBrowserProblem = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return "The browser needs interactive Pi.";
    if (process.env.PI_REX_CHILD || process.env.PI_WORKFLOW_CHILD_CONFIG) return "The browser is not available to child agents.";
    if (!process.env.REX_SESSION || !process.env.REX_BLOCK) return "The browser needs Pi running in a Rex pane.";
    if (!which("terminal-browser")) return "terminal-browser is not installed on the host.";
    if (!which("container")) return "The container CLI is not on PATH.";
    return undefined;
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
        box = new Sandbox(plan, { cli: new ContainerCli(), stateRoot: join(cacheRoot(), "state"), cacheRoot: cacheRoot(), imageDir: settings.image ? undefined : IMAGE_DIR, onPhase });
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
    if (!handOver) await closeBrowser();
    if (!old) return;
    if (handOver) { old.options.onPhase = undefined; handoff.__piSolSandbox = old; }
    else await old.release();
  }

  // A toggle or /sandbox on|off is remembered for this project's next launch.
  async function setEnabled(next: boolean, ctx: ExtensionContext) {
    if (projectRoot) {
      try { saveToggle(togglesFile(getAgentDir()), projectRoot, next, settingsDefault); }
      catch (error) { if (ctx.hasUI) ctx.ui.notify(`Could not save the sandbox toggle: ${(error as Error).message}`, "warning"); }
    }
    source = "saved";
    if (next !== enabled) await apply(next, ctx, "saved");
  }
  function publish(next: boolean) {
    // Children inherit this: workflow subagents through the environment, Rex children explicitly.
    process.env.PI_SANDBOX = next ? "on" : "off";
    process.env.PI_SANDBOX_FROM = String(process.pid);
    // Long-lived processes started for the other setting (the workflowz kernel) stop now.
    pi.events.emit(SANDBOX_CHANGED, { enabled: next });
  }
  async function apply(next: boolean, ctx: ExtensionContext, why: string) {
    enabled = next; source = why;
    publish(next);
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
    // started with --tools never get git_commit or browser.
    commitAllowed ??= pi.getActiveTools().includes("git_commit");
    browserAllowed ??= pi.getActiveTools().includes("browser");
    browserProblem = findBrowserProblem(ctx);
    let choice;
    projectRoot = await findRoot(ctx.cwd);
    repository = await commonDirOf(projectRoot);
    const carried = !!repository && handoff.__piSolSandboxOn === repository;
    handoff.__piSolSandboxOn = undefined;
    try {
      const agentDir = getAgentDir();
      const settings = resolveSettings(globalSandboxSettings(agentDir), projectRoot);
      settingsDefault = settings.enabled;
      choice = chooseEnabled(pi.getFlag("sandbox"), inheritedSwitch(process.env), savedToggle(togglesFile(agentDir), projectRoot), settings, carried);
    } catch (error) {
      // An invalid configuration keeps the sandbox on and failing, never silently off.
      await turnOff();
      enabled = true; failure = error as Error; publish(true);
      syncCommitTool(); render();
      if (ctx.hasUI) ctx.ui.notify(`Sandbox unavailable: ${failure.message}`, "error");
      return;
    }
    await apply(choice.enabled, ctx, choice.source);
  });

  pi.on("session_shutdown", async (event) => {
    // The next session republishes it; a reload without this extension must not keep it.
    pi.events.emit("statusline:segment", { key: STATUS });
    // enter_worktree moves a session to another checkout, whose own toggle and
    // settings would otherwise decide: a model could leave the sandbox that way.
    handoff.__piSolSandboxOn = enabled && REPLACED.has(event.reason) ? repository : undefined;
    await turnOff(REPLACED.has(event.reason));
    ui = undefined;
  });

  const toggle = async (ctx: ExtensionContext) => {
    await setEnabled(!enabled, ctx);
    if (ctx.hasUI) ctx.ui.notify(enabled ? "Sandbox on: tools run in the Linux container." : "Sandbox off: tools run on the host.", enabled ? "info" : "warning");
  };
  pi.registerShortcut(SHORTCUT, { description: "Toggle the tool sandbox", handler: toggle });

  pi.registerCommand("sandbox", {
    description: "Sandbox: status, on, off, toggle, or restart",
    getArgumentCompletions: (prefix: string) => ["status", "on", "off", "toggle", "restart"].filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "on" || action === "off") {
        await setEnabled(action === "on", ctx);
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
    const why = ({ flag: "--sandbox", environment: "set by the parent Pi", saved: "saved for this project", session: "kept on from the checkout this session came from", settings: "settings" } as Record<string, string>)[source] ?? source;
    if (!enabled) return `Sandbox off (${why}). Tools run on the host.`;
    if (failure || box?.error) return `Sandbox unavailable: ${(failure ?? box?.error)!.message}`;
    if (!plan) return "Sandbox starting.";
    const mounts = plan.mounts.map((m) => `  ${m.target}${m.target !== m.source ? ` <- ${m.source}` : ""} (${m.label}${m.readonly ? ", read-only" : ""})`);
    const phase = !box || box.phase === "idle" ? "not started (starts on the first tool call)" : box.phase;
    return [`Sandbox ${phase}: ${plan.name} (${plan.image}, ${plan.cpus} CPUs, ${plan.memory})`, "Mounts:", ...mounts,
      ...(plan.readOnlyPaths.length ? ["Read-only in the guest:", ...plan.readOnlyPaths.map((path) => `  ${path}`)] : [])].join("\n");
  }

  // Other extensions run long-lived guest processes through this request, which
  // fails closed like the tools: `answer` resolves to undefined only when off.
  pi.events.on(GUEST_COMMAND, (data) => {
    const request = data as GuestCommandRequest;
    request.answer = current().then((s) => s?.command(request.argv, { cwd: request.cwd }));
  });

  const route = <T extends { execute: (...args: any[]) => any }>(make: (cwd: string, sandbox?: Sandbox) => T) => ({
    ...make(process.cwd()),
    async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
      return make(ctx.cwd, await current()).execute(id, params, signal, onUpdate, ctx);
    },
  });
  pi.registerTool(route((cwd, s) => createReadToolDefinition(cwd, s ? { operations: readOps(s) } : undefined)));
  pi.registerTool(route((cwd, s) => createWriteToolDefinition(cwd, s ? { operations: writeOps(s) } : undefined)));
  pi.registerTool(route((cwd, s) => createEditToolDefinition(cwd, s ? { operations: editOps(s) } : undefined)));
  pi.registerTool({
    ...createBashToolDefinition(process.cwd()),
    async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
      const s = await current();
      if (!s) return createBashToolDefinition(ctx.cwd, { spawnHook: shareCargoTarget }).execute(id, params, signal, onUpdate, ctx);
      // Pi saves long output to the host's temp folder and names that file in
      // the result, where the guest's read and bash cannot reach it. Updates
      // carry the path even when the command fails, so it is taken from them.
      let log: string | undefined;
      const watch = (update: any) => { log = update?.details?.fullOutputPath ?? log; onUpdate?.(update); };
      const shared = async <T,>(outcome: T): Promise<T> => {
        const from: string | undefined = (outcome as any)?.details?.fullOutputPath ?? log;
        if (!from) return outcome;
        const moved = await shareOutput(from, s.plan.outputDir).catch(() => undefined);
        return moved ? repath(outcome, from, moved) : outcome;
      };
      let result;
      try { result = await createBashToolDefinition(ctx.cwd, { operations: bashOps(s) }).execute(id, params, signal, watch, ctx); }
      catch (error) { throw await shared(error); }
      return shared(result);
    },
  });
  // Pi leaves ls, find and grep off unless asked for; registering them here
  // would otherwise switch them on, and their declarations into every request.
  pi.registerTool({ ...route((cwd, s) => createLsToolDefinition(cwd, s ? { operations: lsOps(s) } : undefined)), defaultActive: false });
  pi.registerTool({ ...route((cwd, s) => createFindToolDefinition(cwd, s ? { operations: findOps(s) } : undefined)), defaultActive: false });
  const grepTool = createGrepToolDefinition(process.cwd());
  pi.registerTool({
    ...grepTool,
    defaultActive: false,
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

  // A section, not a returned systemPrompt: a forced prompt makes Pi fold every
  // tool or section change into the leading system message, which rewrites the
  // whole prefix, so Anthropic drops all earlier thinking and re-bills the cache.
  // Sections change as mid-conversation patches instead.
  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions.sections;
    if (enabled && plan) sections.sandbox = promptNote(plan); else delete sections.sandbox;
  });

  pi.registerTool({
    name: "browser",
    label: "browser",
    description: "Drive a real browser shown beside the user's Pi pane. It runs on the macOS host, but all of its traffic goes through the sandbox, so localhost is the sandbox's. Pass one agent-browser command as a list of strings: [\"open\", \"localhost:3000\"] starts the browser or navigates it; then [\"snapshot\", \"-i\"], [\"click\", \"@e3\"], [\"fill\", \"@e2\", \"text\"], [\"press\", \"Enter\"], [\"get\", \"text\", \"h1\"], [\"eval\", \"document.title\"], [\"wait\", \"--text\", \"Saved\"], [\"console\"], [\"errors\"], [\"set\", \"viewport\", \"390\", \"844\"]. [\"screenshot\"] returns the image; add a selector for one element, --full for the whole page, or a .png path to also save it in the sandbox. [\"close\"] closes the pane. Only http and https pages open; commands that touch host files or the clipboard are refused.",
    promptSnippet: "Show and drive a web page in a browser beside the user, with the sandbox's network",
    promptGuidelines: [
      "Use browser, not the terminal-browser command (it is not installed in the sandbox), to view or test a web page.",
    ],
    parameters: Type.Object({
      command: Type.Array(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!enabled) throw new Error("The sandbox is off; use terminal-browser with bash instead.");
      if (browserProblem) throw new Error(browserProblem);
      const command = parseCommand(params.command);
      const box = (await current())!;
      const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });
      if (command.kind === "open") return text(await browser().open(command.url, box.plan.name, signal));
      if (command.kind === "close") return text(await closeBrowser().then(() => "Closed the browser pane."));
      if (command.kind === "screenshot") {
        const png = await browser().screenshot(command.selector, command.flags, signal);
        // terminal-browser's offscreen rendering hands DevTools captures a
        // cached frame that can lag behind the page; no command refreshes it
        // reliably. Its own capturePage path would fix this upstream.
        // Said here, with each image, and not in the description sent with every request.
        const lag = "It can lag behind recent changes; snapshot or get shows the current state.";
        let note = `Screenshot of the page. ${lag}`;
        if (command.save) {
          // Written by the guest, so the path means what it means there.
          const path = resolvePath(command.save, ctx.cwd);
          const saved = await box.exec(["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", path], { input: png, signal, timeoutMs: 30000 });
          if (saved.code !== 0) throw new Error(`Could not save the screenshot to ${path}: ${saved.stderr.trim()}`);
          note = `Screenshot saved to ${path}. ${lag}`;
        }
        return { content: [{ type: "text" as const, text: note }, { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }], details: undefined };
      }
      const output = await browser().action(command.args, signal);
      const cut = truncateHead(output || "Done.", { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      return text(cut.truncated
        ? `${cut.content}\n\n[Output truncated: ${cut.outputLines} of ${cut.totalLines} lines (${formatSize(cut.outputBytes)} of ${formatSize(cut.totalBytes)}). Narrow it, for example snapshot -i or -s SELECTOR.]`
        : cut.content);
    },
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
