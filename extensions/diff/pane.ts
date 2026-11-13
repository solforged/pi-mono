// The Pi side of /diff: opens and closes the viewer's Rex pane, opens it on its
// own once Pi starts changing files, and writes refresh hints into a private
// IPC directory. No runtime Pi imports, so tests can drive it with a fake API.
import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hostGit } from "../sandbox/hostgit.ts";
import { SOURCES, type Source } from "./git.ts";
import type { Palette } from "./render.ts";

const VIEWER = join(import.meta.dirname, "viewer.ts");
/** The pane's share of the split it makes with Pi's pane. */
const SHARE = 1 / 3;
/** Pi's share of that split, as Rex takes it. */
export const RATIO = Math.round((1 - SHARE) * 10_000) / 10_000;
/** Tools whose `path` argument names the file they changed. */
const EDITORS = new Set(["edit", "write", "multiedit", "apply_patch"]);
/** Tools that may change files without naming them. */
const SHELLS = new Set(["bash", "shell"]);
const MAX_STATS = 2_000;

export interface Settings {
  /** Open the pane once Pi first changes the working tree in a session. */
  autoOpen: boolean;
  /** Reopen it when Pi starts in a worktree where it was open at the last quit, if changes remain. */
  reopen: boolean;
  /** Pi's narrowest terminal width, in columns, for opening it automatically. */
  minColumns: number;
  /** Link Markdown files in the transcript to the document pane, once the handler app is installed. */
  links: boolean;
}
export const DEFAULT_SETTINGS: Settings = { autoOpen: true, reopen: true, minColumns: 150, links: true };

export const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

/** The `diff` object in the agent directory's settings.json. */
export function readSettings(dir = agentDir()): Settings {
  try {
    const value = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).diff ?? {};
    return {
      autoOpen: typeof value.autoOpen === "boolean" ? value.autoOpen : DEFAULT_SETTINGS.autoOpen,
      reopen: typeof value.reopen === "boolean" ? value.reopen : DEFAULT_SETTINGS.reopen,
      minColumns: Number.isInteger(value.minColumns) && value.minColumns > 0 ? value.minColumns : DEFAULT_SETTINGS.minColumns,
      links: typeof value.links === "boolean" ? value.links : DEFAULT_SETTINGS.links,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const ipcDir = () => join(tmpdir(), `pi-diff-${userInfo().uid}`);

/**
 * Worktrees, by Git root, whose pane was open when Pi last quit there. Only a
 * Pi that opened a pane in a worktree updates that worktree's entry.
 */
type Panes = Record<string, { pid: number; at: number }>;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export function readPanes(file: string): Panes {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Records `pid`'s pane at `root`, or forgets it with `undefined`; `moved` also drops `pid`'s entries for other worktrees. */
function writePane(file: string, root: string, pid: number | undefined, moved?: number) {
  const panes = readPanes(file);
  if (moved !== undefined) for (const [key, value] of Object.entries(panes)) if (key !== root && value.pid === moved) delete panes[key];
  if (pid === undefined) delete panes[root];
  else panes[root] = { pid, at: Date.now() };
  savePanes(file, panes);
}

/** Forgets every pane `pid` recorded, whichever session of that Pi opened it. */
function forgetPanes(file: string, pid: number) {
  const panes = readPanes(file);
  const mine = Object.keys(panes).filter((key) => panes[key].pid === pid);
  if (!mine.length) return;
  for (const key of mine) delete panes[key];
  savePanes(file, panes);
}

function savePanes(file: string, panes: Panes) {
  for (const [key, value] of Object.entries(panes)) if (!(Date.now() - value.at < KEEP_MS)) delete panes[key];
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(panes, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch {}
}

/** highlight.js as shipped with Pi for HTML export, beside the running binary. */
export function bundledHighlighter(execPath = process.execPath): string | undefined {
  const file = join(dirname(execPath), "export-html", "vendor", "highlight.min.js");
  return existsSync(file) ? file : undefined;
}

export type Run = (command: string, args: string[], cwd: string) => Promise<string>;
export const run: Run = (command, args, cwd) => new Promise((resolve, reject) => {
  const call = command === "git" ? hostGit(cwd, args) : { args, env: process.env };
  // Optional locks off: a status check must never block Pi's own Git commands.
  execFile(command, call.args, { cwd, timeout: 10_000, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...call.env, GIT_OPTIONAL_LOCKS: "0" } },
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

/** The live process named by a PID file in the IPC directory, such as `<pi>.viewer`. */
export function viewerPid(dir: string, piPid: number, kind = "viewer"): number | undefined {
  try {
    const pid = Number(readFileSync(join(dir, `${piPid}.${kind}`), "utf8").trim());
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

/**
 * The pane's likely size from Pi's unsplit pane: the same rows, and its share
 * of the columns less the two that the border between them takes.
 */
export function paneSize(pi: { columns?: unknown; rows?: unknown }): { columns: number; rows: number } | undefined {
  const { columns, rows } = pi;
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || (columns as number) < 1 || (rows as number) < 1) return undefined;
  return { columns: Math.max(20, Math.round((columns as number) * SHARE) - 2), rows: rows as number };
}

/** What a pane beside Pi needs from Rex: the session, Pi's block, and the programs to run. */
export interface RexSetup { session: string; block: string; rex: string; node: string }

export async function rexSetup(env: NodeJS.ProcessEnv, exec: Run, cwd: string, name: string): Promise<RexSetup> {
  const session = env.REX_SESSION, block = env.REX_BLOCK;
  if (!session || !block) throw new Error(`${name} needs Pi running in a Rex pane (REX_SESSION and REX_BLOCK are unset)`);
  const rex = which("rex", env.PATH) ?? (env.REX_BIN_DIR && which("rex", env.REX_BIN_DIR));
  if (!rex) throw new Error(`${name} needs the rex CLI on PATH`);
  const node = which("node", env.PATH);
  if (!node) throw new Error(`${name} needs Node on PATH to run the viewer`);
  const version = (await exec(node, ["--version"], cwd)).trim();
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new Error(`${name} needs Node 22.18 or later for the viewer (found ${version})`);
  return { session, block, rex, node };
}

export const rexCall = (exec: Run, rex: string, session: string, method: string, args: object, cwd: string) =>
  exec(rex, ["api", "call", "--session", session, method, JSON.stringify({ session_id: session, ...args })], cwd);

/**
 * Splits Pi's pane and runs `command` in the new pane, which gets a third of
 * the width. Returns the new block's ID, or undefined when Rex returned none.
 */
export async function splitBeside(exec: Run, setup: RexSetup, cwd: string, label: string, command: string[], warn: (why: string) => void, split?: () => void): Promise<string | undefined> {
  const { session, block, rex } = setup;
  // A new terminal is 80x24 until Rex shows it, so start it at about its
  // final size; the viewer then lays out once rather than per size.
  const size = await exec(rex, ["block", "call", "-s", session, "-b", block, "size"], cwd)
    .then((out) => paneSize(JSON.parse(out)), () => undefined);
  const created = await rexCall(exec, rex, session, "session.new_split", {
    anchor_id: block, direction: "horizontal", side: "after", focus: false, ratio: RATIO,
    layout: { block: { flavor: "com.superlogical.terminal.shell", label, options: { shell: "none", cwd, ...(size ? { size } : {}), command } } },
  }, cwd);
  split?.();
  let pane: unknown;
  try { pane = JSON.parse(created).block_ids?.[0]; } catch {}
  if (typeof pane !== "string") { warn("Rex returned no block ID"); return undefined; }
  await keepShare(exec, setup, pane, cwd).catch((error: Error) => warn(error.message));
  return pane;
}

/** Rex splits evenly whatever ratio it is given, so move the border to give `pane` its third. */
export function keepShare(exec: Run, setup: RexSetup, pane: string, cwd: string) {
  return rexCall(exec, setup.rex, setup.session, "session.resize_pane", { direction: "horizontal", before_block_id: setup.block, after_block_id: pane, ratio: RATIO }, cwd);
}

/** The diff pane, for the document pane to take its place and give it back. */
export interface DiffPane {
  /** The diff's Rex block, while this Pi's viewer runs. */
  block(): string | undefined;
}

export interface Options {
  palette: (ctx: ExtensionContext) => Partial<Palette>;
  highlighter?: string;
  run?: Run; dir?: string; env?: NodeJS.ProcessEnv; pid?: number;
  isViewer?: (pid: number) => boolean;
  /** Whether a process is still running, for the Pi that recorded a pane. */
  alive?: (pid: number) => boolean;
  settings?: () => Settings;
  columns?: () => number;
  /** Where open panes are remembered across restarts. */
  panes?: string;
  /** Whether opening on its own should wait, such as while a document has the pane's place. */
  held?: () => boolean;
}

export function registerDiff(pi: ExtensionAPI, options: Options): DiffPane {
  const exec = options.run ?? run;
  const dir = options.dir ?? ipcDir();
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;
  const settings = options.settings ?? (() => readSettings());
  const columns = options.columns ?? (() => process.stdout.columns ?? 0);
  const alive = options.alive ?? ((other: number) => {
    try { process.kill(other, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  });
  const paths = new Map<string, string>();
  const panes = options.panes ?? join(agentDir(), "diff-panes.json");
  /** The worktree of the last pane this Pi opened. */
  let opened: string | undefined;
  // The pane belongs to the Pi process, but /new, /resume, /fork and /reload
  // build a new instance of this extension, so its block is kept beside the
  // viewer's PID file rather than in a variable.
  const blockFile = join(dir, `${pid}.block`);
  const recordBlock = (block: string | undefined) => {
    try { if (block) writeFileSync(blockFile, block, { mode: 0o600 }); else rmSync(blockFile, { force: true }); } catch {}
  };
  const recordedBlock = () => { try { return readFileSync(blockFile, "utf8").trim() || undefined; } catch { return undefined; } };
  const gitRoot = (cwd: string) => exec("git", ["rev-parse", "--show-toplevel"], cwd).then((out) => out.trim(), () => "");

  async function open(ctx: ExtensionContext, source: Source, focus?: string) {
    const setup = await rexSetup(env, exec, ctx.cwd, "/diff");
    const root = await gitRoot(ctx.cwd);
    if (!root) throw new Error("/diff needs a Git working tree");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const command = [
      setup.node, VIEWER, "--root", root, "--ipc", dir, "--pi-pid", String(pid),
      "--palette", JSON.stringify(options.palette(ctx)), "--source", source,
      ...(options.highlighter ? ["--highlighter", options.highlighter] : []),
      ...(focus ? ["--focus", focus] : []),
    ];
    // The pane is open before its border moves, so a failure there only leaves
    // it wider; say so rather than leaving an even split unexplained.
    const widened = (why: string) => ctx.ui.notify(`The diff pane opened at Rex's default width: ${why}`, "warning");
    recordBlock(undefined);
    recordBlock(await splitBeside(exec, setup, root, "Diff", command, widened, () => {
      opened = root;
      writePane(panes, root, pid);
    }));
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

  async function arm(ctx: ExtensionContext, reason: string) {
    const session = ++auto.session;
    auto.armed = false;
    auto.focus = undefined;
    const { autoOpen, reopen, minColumns } = settings();
    if ((!autoOpen && !reopen) || ctx.mode !== "tui") return;
    if (!env.REX_SESSION || !env.REX_BLOCK || env.PI_REX_CHILD || env.PI_WORKFLOW_CHILD_CONFIG) return;
    if (viewerPid(dir, pid) !== undefined) return;
    const root = await gitRoot(ctx.cwd);
    if (!root || session !== auto.session) return;
    const baseline = await treeState(exec, root).catch(() => undefined);
    if (baseline === undefined || session !== auto.session) return;
    // A fresh Pi reopens the pane it quit with, while there is still something to show.
    // The entry is written when a pane opens, so one whose Pi still runs is that
    // Pi's open pane, not one left at a quit.
    const last = readPanes(panes)[root];
    if (reopen && reason === "startup" && baseline && last && (last.pid === pid || !alive(last.pid)) && columns() >= minColumns) {
      try { await open(ctx, "uncommitted"); return; }
      catch (error) { ctx.ui.notify(`Could not reopen the diff pane: ${(error as Error).message}`, "warning"); }
    }
    if (autoOpen) Object.assign(auto, { armed: true, root, baseline });
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
        if (options.held?.()) continue; // Stay armed until the document pane closes.
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

  /**
   * Points an open pane at the session's worktree after a switch to a session in
   * another directory, such as a move into a worktree with /wt. The pane outlives
   * the switch because it belongs to the Pi process, not the session.
   */
  async function follow(ctx: ExtensionContext) {
    if (viewerPid(dir, pid) === undefined) return;
    const root = await gitRoot(ctx.cwd);
    if (!root) return;
    opened = root;
    writePane(panes, root, pid, pid);
    tick(dir, pid, { event: "root", root });
  }

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") void follow(ctx);
    void arm(ctx, event.reason);
  });

  // On quit, remember whether this Pi's pane is still open, then tell the
  // viewer to close now rather than wait for its poll to notice Pi has gone.
  pi.on("session_shutdown", (event) => {
    if (event.reason !== "quit") return;
    // By process ID, not by what this instance opened: an earlier session of
    // this Pi may have opened a pane that was closed before this one started.
    if (viewerPid(dir, pid) === undefined) forgetPanes(panes, pid);
    else if (opened) writePane(panes, opened, pid);
    tick(dir, pid, { event: "quit" });
    recordBlock(undefined);
  });

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

  return { block: () => viewerPid(dir, pid) !== undefined ? recordedBlock() : undefined };
}
