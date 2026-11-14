// The Pi side of the document pane: shows a Markdown file beside Pi, in the
// diff pane's place while that is open, and gives the place back when the
// document closes. Requests come from /md, and from ⌘-clicks on pi-open:// links
// through the handler app, which drops them into the IPC directory. No runtime
// Pi imports, so tests can drive it with a fake API. See docs/diff.md.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { atomicWriteSync } from "../shared/system.ts";
import { docUrl, isMarkdown, linkDocs, parseDocUrl, resolveTarget } from "./links.ts";
import { agentDir, ipcDir, keepShare, RATIO, readSettings, rexCall, rexSetup, run as defaultRun, splitBeside, viewerPid, type DiffPane, type RexSetup, type Run, type Settings } from "./pane.ts";
import type { Palette } from "./render.ts";

const DOC_VIEWER = join(import.meta.dirname, "doc.ts");
/** The app that receives pi-open:// links; `pm-install` builds it on macOS. */
export const handlerApp = (dir = agentDir()) => join(dir, "apps", "Pi Open.app");
/** How long to wait for Rex to drop the closed document before giving the diff its place back. */
const SETTLE_MS = 2_000;

// The document pane belongs to the Pi process, but /new, /resume, /fork and
// /reload replace this extension with a new instance. The old one hands the
// open pane over here, so the new one can still give the diff its place back.
const HANDOFF: Map<string, { block: string; swapped?: string; setup: RexSetup }> = ((globalThis as any)[Symbol.for("pi-mono.diff.docs")] ??= new Map());

export interface DocOptions {
  palette: (ctx: ExtensionContext) => Partial<Palette>;
  highlighter?: string;
  marked?: string;
  diff: DiffPane;
  run?: Run; dir?: string; env?: NodeJS.ProcessEnv; pid?: number;
  settings?: () => Settings;
  /** Whether pi-open:// links have an app to open them. */
  handler?: () => boolean;
  /** Resolves once the Rex block ends; the default runs `rex wait`. */
  wait?: (rex: string, session: string, block: string) => { done: Promise<void>; stop(): void };
  sleep?: (ms: number) => Promise<void>;
}

export interface Docs {
  /** Whether this Pi's document pane is open. */
  open(): boolean;
}

function rexWait(rex: string, session: string, block: string) {
  const child = spawn(rex, ["wait", "--session", session, block], { stdio: "ignore" });
  child.unref();
  return {
    done: new Promise<void>((resolve) => { child.on("exit", () => resolve()); child.on("error", () => resolve()); }),
    stop: () => { child.removeAllListeners("exit"); child.kill(); },
  };
}

/** Pi's hyperlink setting: pi-open:// links only help where links are clickable. */
function hyperlinks(env: NodeJS.ProcessEnv): boolean {
  if (env.PI_HYPERLINKS === "0") return false;
  try { return JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8")).terminal?.hyperlinks !== false; }
  catch { return true; }
}

export function registerDocs(pi: ExtensionAPI, options: DocOptions): Docs {
  const exec = options.run ?? defaultRun;
  const dir = options.dir ?? ipcDir();
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;
  const settings = options.settings ?? (() => readSettings());
  const handler = options.handler ?? (() => existsSync(handlerApp()));
  const wait = options.wait ?? rexWait;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const live = () => viewerPid(dir, pid, "doc-viewer") !== undefined;
  /** In a Rex pane of a top-level Pi, where a pane can open beside it. */
  const inRex = () => !!env.REX_SESSION && !!env.REX_BLOCK && !env.PI_REX_CHILD && !env.PI_WORKFLOW_CHILD_CONFIG;
  const handoff = `${dir}:${pid}`;

  let ctx: ExtensionContext | undefined;
  let cwd = process.cwd();
  let linking = false;
  /** The open document's block, and the diff block it took the place of. */
  let pane: { block: string; swapped?: string; stop(): void } | undefined;
  let opening: Promise<void> | undefined;
  let queued: { path: string; anchor?: string } | undefined;
  let requests: FSWatcher | undefined;

  function send(message: { event: string; path?: string; anchor?: string }) {
    try { atomicWriteSync(join(dir, `${pid}.doc`), JSON.stringify({ ...message, at: Date.now() })); } catch {}
  }

  async function show(context: ExtensionContext, path: string, anchor?: string) {
    if (live()) {
      send({ event: "open", path, ...(anchor ? { anchor } : {}) });
      if (pane) void exec(...label(pane.block, path), context.cwd).catch(() => {});
      return;
    }
    if (opening) { queued = { path, anchor }; return; }
    opening = place(context, path, anchor).finally(() => { opening = undefined; });
    await opening;
    if (queued) {
      const next = queued;
      queued = undefined;
      await show(context, next.path, next.anchor);
    }
  }

  let setup: RexSetup | undefined;
  /** Follows an open document's block until it closes, on behalf of `context`'s session. */
  function track(context: ExtensionContext, block: string, swapped?: string) {
    const waiting = wait(setup!.rex, setup!.session, block);
    const current = { block, swapped, stop: waiting.stop };
    pane = current;
    void waiting.done.then(() => closed(current, context));
  }
  const label = (block: string, path: string): [string, string[]] => [setup!.rex, [
    "api", "call", "--session", setup!.session, "session.set_block_label", JSON.stringify({ session_id: setup!.session, block_id: block, label: basename(path) }),
  ]];

  /** Whether a block is placed in one of the session's windows. */
  async function placed(block: string, cwd: string): Promise<boolean> {
    const view = await rexCall(exec, setup!.rex, setup!.session, "session.view", {}, cwd);
    return view.includes(JSON.stringify(block));
  }

  async function place(context: ExtensionContext, path: string, anchor?: string) {
    setup = await rexSetup(env, exec, context.cwd, "The Markdown pane");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const command = [
      setup.node, DOC_VIEWER, "--file", path, "--ipc", dir, "--pi-pid", String(pid), "--root", context.cwd,
      "--palette", JSON.stringify(options.palette(context)),
      ...(options.highlighter ? ["--highlighter", options.highlighter] : []),
      ...(options.marked ? ["--marked", options.marked] : []),
      ...(anchor ? ["--anchor", anchor] : []),
    ];
    const layout = (size?: object) => ({ block: { flavor: "com.superlogical.terminal.shell", label: basename(path), options: {
      shell: "none", cwd: dirname(path), ...(size ? { size } : {}), command,
    } } });
    const diff = options.diff.block();
    let block: string | undefined, swapped: string | undefined;
    if (diff && await placed(diff, context.cwd).catch(() => false)) {
      // Split the diff's pane and take the diff out, so the document fills its place at its size.
      const size = await exec(setup.rex, ["block", "call", "-s", setup.session, "-b", diff, "size"], context.cwd)
        .then((out) => { const { columns, rows } = JSON.parse(out); return Number.isInteger(columns) && Number.isInteger(rows) ? { columns, rows } : undefined; }, () => undefined);
      const created = await rexCall(exec, setup.rex, setup.session, "session.new_split", {
        anchor_id: diff, direction: "horizontal", side: "after", focus: false, ratio: 0.5, layout: layout(size),
      }, context.cwd);
      try { block = JSON.parse(created).block_ids?.[0]; } catch {}
      if (typeof block !== "string") throw new Error("Rex returned no block ID for the Markdown pane");
      try {
        await rexCall(exec, setup.rex, setup.session, "session.detach_block", { block_id: diff }, context.cwd);
        swapped = diff;
      } catch (error) {
        context.ui.notify(`The Markdown pane opened beside the diff: ${(error as Error).message}`, "warning");
      }
    } else {
      block = await splitBeside(exec, setup, dirname(path), basename(path), command,
        (why) => context.ui.notify(`The Markdown pane opened at Rex's default width: ${why}`, "warning"));
      if (!block) return;
    }
    track(context, block, swapped);
  }

  /** The document closed: give its place back to the diff it replaced, if both are still around. */
  async function closed(current: NonNullable<typeof pane>, context: ExtensionContext) {
    if (pane !== current) return;
    pane = undefined;
    const diff = current.swapped;
    if (!diff || !setup || options.diff.block() !== diff) return;
    try {
      // Rex ends the program before it drops the block; moving the diff in
      // first would split the space the document is about to give up.
      for (let waited = 0; waited < SETTLE_MS && await placed(current.block, context.cwd); waited += 50) await sleep(50);
      if (await placed(diff, context.cwd)) return; // Already placed again by hand.
      await rexCall(exec, setup.rex, setup.session, "session.move_block", {
        block_id: diff, anchor_block_id: setup.block, direction: "horizontal", side: "after", ratio: RATIO,
      }, context.cwd);
      await keepShare(exec, setup, diff, context.cwd).catch(() => {});
    } catch (error) {
      context.ui.notify(`Could not bring the diff pane back: ${(error as Error).message}`, "warning");
    }
  }

  /** Opens the requests the handler app left for this Pi; anything else is dropped. */
  function drain() {
    let names: string[];
    try { names = readdirSync(dir).filter((name) => name.startsWith(`${pid}.open.`)); } catch { return; }
    for (const name of names) {
      const entry = join(dir, name);
      let url = "";
      try { url = readFileSync(entry, "utf8"); } catch {}
      try { rmSync(entry, { force: true }); } catch {}
      const request = parseDocUrl(url);
      if (!request || request.pid !== pid || !ctx) continue;
      let file = false;
      try { file = statSync(request.path).isFile(); } catch {}
      if (!file) { ctx.ui.notify(`No such file: ${request.path}`, "warning"); continue; }
      const context = ctx;
      void show(context, request.path, request.anchor).catch((error: Error) => context.ui.notify(error.message, "error"));
    }
  }

  function listen() {
    if (requests) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      drain(); // Left over from a Pi that had this process ID before.
      requests = watch(dir, (_event, name) => { if (name === null || String(name).startsWith(`${pid}.open.`)) drain(); });
      requests.unref();
    } catch {}
  }

  pi.registerMarkdownTransformer((markdown) =>
    linking ? linkDocs(markdown, cwd, (path, anchor) => docUrl(pid, path, anchor)) : markdown);

  pi.registerCommand("md", {
    description: "Show a Markdown file beside Pi (Rex), in the diff pane's place while it is open",
    getArgumentCompletions: (prefix: string) => {
      const base = ctx?.cwd ?? cwd;
      const folder = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/") + 1) : "";
      try {
        return readdirSync(resolve(base, folder || "."), { withFileTypes: true })
          .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || isMarkdown(entry.name)))
          .map((entry) => `${folder}${entry.name}${entry.isDirectory() ? "/" : ""}`)
          .filter((value) => value.startsWith(prefix))
          .slice(0, 50)
          .map((value) => ({ value, label: value }));
      } catch {
        return [];
      }
    },
    handler: async (args, context) => {
      const arg = args.trim();
      if (!arg) { context.ui.notify("Usage: /md PATH", "error"); return; }
      if (context.mode !== "tui") { context.ui.notify("/md needs interactive mode", "error"); return; }
      const target = resolveTarget(arg, context.cwd) ?? { path: resolve(context.cwd, arg) };
      try {
        if (!statSync(target.path).isFile()) throw new Error("not a file");
      } catch {
        context.ui.notify(`No such file: ${arg}`, "error");
        return;
      }
      try { await show(context, target.path, "anchor" in target ? target.anchor : undefined); }
      catch (error) { context.ui.notify((error as Error).message, "error"); }
    },
  });

  pi.on("session_start", (_event, context) => {
    ctx = context;
    cwd = context.cwd;
    const usable = context.mode === "tui" && inRex();
    linking = usable && settings().links && hyperlinks(env) && handler();
    if (usable) listen();
    const kept = HANDOFF.get(handoff);
    HANDOFF.delete(handoff);
    if (kept && usable) { setup = kept.setup; track(context, kept.block, kept.swapped); }
  });

  // Every shutdown stops this instance: its context goes stale, and a watcher
  // left behind would race the next instance's for each request.
  pi.on("session_shutdown", (event) => {
    requests?.close();
    requests = undefined;
    const open = pane;
    pane?.stop();
    pane = undefined;
    if (event.reason !== "quit") {
      if (open && setup) HANDOFF.set(handoff, { block: open.block, swapped: open.swapped, setup });
      return;
    }
    HANDOFF.delete(handoff);
    if (live()) send({ event: "quit" });
  });

  return { open: () => live() || opening !== undefined };
}
