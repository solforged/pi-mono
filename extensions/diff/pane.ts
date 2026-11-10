// The Pi side of /diff: opens and closes the viewer's Rex pane, opens it on its
// own once Pi starts changing files, and writes refresh hints into a private
// IPC directory. No runtime Pi imports, so tests can drive it with a fake API.
import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SOURCES, type Source } from "./git.ts";
import type { Palette } from "./render.ts";

const VIEWER = join(import.meta.dirname, "viewer.ts");
const RATIO = 40;
/** Tools whose `path` argument names the file they changed. */
const EDITORS = new Set(["edit", "write", "multiedit", "apply_patch"]);
/** Tools that may change files without naming them. */
const SHELLS = new Set(["bash", "shell"]);
const MAX_STATS = 2_000;

export interface Settings {
  /** Open the pane once Pi first changes the working tree in a session. */
  autoOpen: boolean;
  /** Pi's narrowest terminal width, in columns, for opening it automatically. */
  minColumns: number;
}
export const DEFAULT_SETTINGS: Settings = { autoOpen: true, minColumns: 150 };

/** The `diff` object in the agent directory's settings.json. */
export function readSettings(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): Settings {
  try {
    const value = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).diff ?? {};
    return {
      autoOpen: typeof value.autoOpen === "boolean" ? value.autoOpen : DEFAULT_SETTINGS.autoOpen,
      minColumns: Number.isInteger(value.minColumns) && value.minColumns > 0 ? value.minColumns : DEFAULT_SETTINGS.minColumns,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const ipcDir = () => join(tmpdir(), `pi-diff-${userInfo().uid}`);

/** highlight.js as shipped with Pi for HTML export, beside the running binary. */
export function bundledHighlighter(execPath = process.execPath): string | undefined {
  const file = join(dirname(execPath), "export-html", "vendor", "highlight.min.js");
  return existsSync(file) ? file : undefined;
}

type Run = (command: string, args: string[], cwd: string) => Promise<string>;
const run: Run = (command, args, cwd) => new Promise((resolve, reject) => {
  // Optional locks off: a status check must never block Pi's own Git commands.
  execFile(command, args, { cwd, timeout: 10_000, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
    (error, stdout, stderr) => error ? reject(new Error(stderr.trim().split("\n").at(-1) || error.message)) : resolve(stdout));
});

/** Resolves a program on PATH to an absolute path; Rex starts it without a shell. */
export function which(name: string, path = process.env.PATH ?? ""): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  return undefined;
}

function viewerPid(dir: string, piPid: number): number | undefined {
  try {
    const pid = Number(readFileSync(join(dir, `${piPid}.viewer`), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

function isViewer(pid: number): boolean {
  try { return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2_000 }).includes(VIEWER); }
  catch { return false; }
}

let sequence = 0;
/** Tells an open viewer to refresh, optionally following an edited file. */
export function tick(dir: string, piPid: number, message: { event: string; path?: string }) {
  if (viewerPid(dir, piPid) === undefined) return;
  const target = join(dir, `${piPid}.tick`);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ ...message, seq: ++sequence }), { mode: 0o600 });
    renameSync(temporary, target);
  } catch {}
}

/**
 * The working tree's state: changed and untracked paths with their sizes and
 * modification times, so another edit to an already-changed file still counts.
 */
export async function treeState(exec: Run, root: string): Promise<string> {
  const entries = (await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], root)).split("\0").filter(Boolean);
  return entries.map((entry, i) => {
    if (i >= MAX_STATS) return entry;
    try { const stat = statSync(join(root, entry.slice(3))); return `${entry}\t${stat.size}\t${stat.mtimeMs}`; }
    catch { return entry; }
  }).join("\n");
}

export interface Options {
  palette: (ctx: ExtensionContext) => Partial<Palette>;
  highlighter?: string;
  run?: Run; dir?: string; env?: NodeJS.ProcessEnv; pid?: number;
  isViewer?: (pid: number) => boolean;
  settings?: () => Settings;
  columns?: () => number;
}

export function registerDiff(pi: ExtensionAPI, options: Options) {
  const exec = options.run ?? run;
  const dir = options.dir ?? ipcDir();
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;
  const settings = options.settings ?? (() => readSettings());
  const columns = options.columns ?? (() => process.stdout.columns ?? 0);
  const paths = new Map<string, string>();
  const gitRoot = (cwd: string) => exec("git", ["rev-parse", "--show-toplevel"], cwd).then((out) => out.trim(), () => "");

  async function open(ctx: ExtensionContext, source: Source, focus?: string) {
    const session = env.REX_SESSION, block = env.REX_BLOCK;
    if (!session || !block) throw new Error("/diff needs Pi running in a Rex pane (REX_SESSION and REX_BLOCK are unset)");
    const rex = which("rex", env.PATH) ?? (env.REX_BIN_DIR && which("rex", env.REX_BIN_DIR));
    if (!rex) throw new Error("/diff needs the rex CLI on PATH");
    const node = which("node", env.PATH);
    if (!node) throw new Error("/diff needs Node on PATH to run the viewer");
    const version = (await exec(node, ["--version"], ctx.cwd)).trim();
    const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 18)) throw new Error(`/diff needs Node 22.18 or later for the viewer (found ${version})`);
    const root = await gitRoot(ctx.cwd);
    if (!root) throw new Error("/diff needs a Git working tree");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await exec(rex, [
      "split", "-s", session, "-b", block, "--split=right", "--ratio", String(RATIO), "--focus=false",
      "--label", "Diff", "--shell=none", "-c", root, "--",
      node, VIEWER, "--root", root, "--ipc", dir, "--pi-pid", String(pid),
      "--palette", JSON.stringify(options.palette(ctx)), "--source", source,
      ...(options.highlighter ? ["--highlighter", options.highlighter] : []),
      ...(focus ? ["--focus", focus] : []),
    ], ctx.cwd);
  }

  // Automatic opening: armed per session, with a baseline of the tree's state
  // taken at the session's start and again at each prompt (so your own edits
  // between prompts do not count), checked after tools that can change files,
  // and spent once it opens or you run /diff yourself.
  const auto = {
    session: 0, armed: false, root: "", baseline: "", ready: Promise.resolve(),
    checking: false, again: false, notified: false, focus: undefined as string | undefined,
  };

  async function rebaseline() {
    const session = auto.session;
    const baseline = await treeState(exec, auto.root).catch(() => undefined);
    if (baseline !== undefined && session === auto.session) auto.baseline = baseline;
  }

  async function arm(ctx: ExtensionContext) {
    const session = ++auto.session;
    auto.armed = false;
    auto.focus = undefined;
    if (!settings().autoOpen || ctx.mode !== "tui") return;
    if (!env.REX_SESSION || !env.REX_BLOCK || env.PI_REX_CHILD || env.PI_WORKFLOW_CHILD_CONFIG) return;
    if (viewerPid(dir, pid) !== undefined) return;
    const root = await gitRoot(ctx.cwd);
    if (!root || session !== auto.session) return;
    const baseline = await treeState(exec, root).catch(() => undefined);
    if (baseline === undefined || session !== auto.session) return;
    Object.assign(auto, { armed: true, root, baseline });
  }

  async function check(ctx: ExtensionContext, focus?: string) {
    if (focus) auto.focus = focus;
    if (auto.checking) { auto.again = true; return; }
    auto.checking = true;
    try {
      do {
        auto.again = false;
        await auto.ready;
        const session = auto.session;
        const state = await treeState(exec, auto.root).catch(() => undefined);
        if (!auto.armed || session !== auto.session || state === undefined || state === auto.baseline) continue;
        if (viewerPid(dir, pid) !== undefined) { auto.armed = false; return; }
        if (columns() < settings().minColumns) continue; // Stay armed: the window may widen.
        auto.armed = false;
        try { await open(ctx, "uncommitted", auto.focus); }
        catch (error) {
          if (!auto.notified) ctx.ui.notify(`Could not open the diff pane: ${(error as Error).message}`, "warning");
          auto.notified = true;
        }
        return;
      } while (auto.again);
    } finally {
      auto.checking = false;
    }
  }

  pi.registerCommand("diff", {
    description: "Toggle a live Git diff pane beside Pi (Rex). Optional source: uncommitted, staged, branch",
    getArgumentCompletions: (prefix: string) => [...SOURCES, "close"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg && arg !== "close" && !SOURCES.includes(arg as Source)) {
        ctx.ui.notify(`Usage: /diff [${SOURCES.join("|")}|close]`, "error");
        return;
      }
      auto.armed = false; // The user is managing the pane this session.
      const running = viewerPid(dir, pid);
      // A stale PID file can name an unrelated process; only signal the viewer.
      if (running !== undefined && (options.isViewer ?? isViewer)(running)) {
        if (arg && arg !== "close") { ctx.ui.notify("The diff pane is already open; press s in it to switch source", "info"); return; }
        process.kill(running, "SIGTERM");
        return;
      }
      if (arg === "close") return;
      if (ctx.mode !== "tui") { ctx.ui.notify("/diff needs interactive mode", "error"); return; }
      try { await open(ctx, (arg || "uncommitted") as Source); }
      catch (error) { ctx.ui.notify((error as Error).message, "error"); }
    },
  });

  pi.on("session_start", (_event, ctx) => { void arm(ctx); });

  pi.on("tool_execution_start", (event, ctx) => {
    const path = (event.args as { path?: unknown; file_path?: unknown } | undefined);
    const value = typeof path?.path === "string" ? path.path : typeof path?.file_path === "string" ? path.file_path : undefined;
    if (EDITORS.has(event.toolName) && value) paths.set(event.toolCallId, isAbsolute(value) ? value : resolve(ctx.cwd, value));
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const path = paths.get(event.toolCallId);
    paths.delete(event.toolCallId);
    if (path && !event.isError) tick(dir, pid, { event: "edit", path });
    else if (SHELLS.has(event.toolName) || path) tick(dir, pid, { event: "refresh" });
    if (auto.armed && (EDITORS.has(event.toolName) || SHELLS.has(event.toolName))) void check(ctx, path && !event.isError ? path : undefined);
  });

  pi.on("agent_start", () => {
    tick(dir, pid, { event: "agent_start" });
    if (auto.armed) auto.ready = rebaseline();
  });
}
