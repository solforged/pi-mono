import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface RexExecutionOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  shell: false;
}
export interface RexExecutionResult { stdout: string; stderr: string; code: number }
/** Executors must honor cancellation and bound combined stdout/stderr to maxBytes. */
export type RexExecutor = (command: string, args: string[], options: RexExecutionOptions) => Promise<RexExecutionResult>;

type ObjectValue = Record<string, any>;
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 2 * 1024 * 1024;
const FLAVOR = "com.superlogical.terminal.shell";
/** Upper-right [x, y, w, h]: large enough to read, small enough to keep the parent usable. */
export const PEEK_BOUNDS = [0.5, 0.05, 0.48, 0.62];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS: Record<string, string[]> = {
  "session.new_block": ["session_id", "flavor", "label", "options"],
  "session.move_block": ["session_id", "block_id", "anchor_block_id"],
  "session.detach_block": ["session_id", "block_id"],
  "block.close": ["session_id", "block_id"],
  "session.view": ["session_id"],
  "session.list_blocks": ["session_id"],
  "block_creator.list": [],
};

const LAYOUT_METHODS: Record<string, string[]> = {
  "session.move_block": ["session_id", "block_id", "anchor_block_id", "direction", "side", "ratio"],
  "session.resize_pane": ["session_id", "before_block_id", "after_block_id", "direction", "ratio"],
  "session.swap_blocks": ["session_id", "block_id", "other_block_id"],
  "session.detach_block": ["session_id", "block_id"],
  "session.new_window": ["session_id", "layout", "focus", "window_label"],
  "session.move_window": ["session_id", "window_id", "before_window_id"],
  "session.set_window_label": ["session_id", "window_id", "label"],
  "session.focus_block": ["session_id", "block_id"],
  "session.focus_window": ["session_id", "window_id"],
  "session.zoom_block": ["session_id", "block_id", "zoom"],
  "block.method": ["session_id", "block_id", "method", "args"],
};

function object(value: unknown, name: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Rex ${name}: expected a JSON object`);
  return value as ObjectValue;
}
function uuid(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) {
    throw new Error(`Rex ${name}: expected a full, nonzero UUID`);
  }
}
function id(value: unknown, kind: "session" | "block" | "layer" | "window"): asserts value is string {
  if (typeof value !== "string" || !value.startsWith(`${kind}:`)) throw new Error(`Rex requires a full ${kind} ID`);
  uuid(value.slice(kind.length + 1), `${kind} ID`);
}
function allows(schema: any, type: string): boolean {
  return schema?.type === type || (Array.isArray(schema?.type) && schema.type.includes(type));
}
function fields(schema: any, names: string[], name: string): ObjectValue {
  if (!allows(schema, "object")) throw new Error(`Rex ${name}: object schema unavailable`);
  const properties = object(schema.properties ?? {}, `${name} properties`);
  for (const key of names) {
    if (!Object.hasOwn(properties, key)) throw new Error(`Rex ${name}: required capability ${key} unavailable`);
  }
  if ((schema.required ?? []).some((key: string) => !names.includes(key))) {
    throw new Error(`Rex ${name}: unsupported required argument`);
  }
  return properties;
}

const execute: RexExecutor = async (command, args, options) => {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); }
      catch { child.kill(signal); }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 250);
    };
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        failure ??= new Error("Rex CLI combined output limit exceeded");
        stop();
      } else if (!failure) chunks.push(chunk);
    };
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) stop();
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code, signal) => {
      options.signal.removeEventListener("abort", stop);
      if (killTimer) clearTimeout(killTimer);
      kill("SIGKILL"); // Do not leave CLI descendants behind.
      if (options.signal.aborted) reject(options.signal.reason);
      else if (failure) reject(failure);
      else if (signal) reject(new Error(`Rex CLI terminated by ${signal}`));
      else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code: code ?? 1 });
    });
  });
};

/** The block does not exist on the verified local server (e.g. the user closed it). */
export class BlockGone extends Error {
  readonly blockId: string;
  constructor(blockId: string) { super(`Rex block ${blockId} is missing: it no longer exists`); this.blockId = blockId; }
}

function layerOf(view: ObjectValue, blockId: string): any {
  for (const window of view.windows ?? []) for (const layer of window.layers ?? [])
    if ((layer.blocks ?? []).some((b: any) => b.block_id === blockId)) return layer;
}

/** Local-only CLI adapter. No command is interpreted by a shell; mutations are never retried. */
export class RexClient {
  private identity?: { hostId: string; instanceId: string };
  private readonly executor: RexExecutor;
  constructor(executor: RexExecutor = execute) { this.executor = executor; }

  private async cli(args: string[], signal?: AbortSignal): Promise<ObjectValue> {
    signal?.throwIfAborted();
    const env = { ...process.env };
    // Never allow inherited targeting or remote routing, including Rex's silent fallback.
    for (const key of ["REX_SERVER", "REX_CLIENT", "REX_SESSION", "REX_BLOCK"]) delete env[key];
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason ?? new Error("Rex CLI cancelled"));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new Error(`Rex CLI timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    try {
      const result = await Promise.race([
        this.executor("rex", ["--autostart=false", "--timeout=5s", "--color=never", ...args], {
          cwd: process.cwd(), env, signal: controller.signal, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, shell: false,
        }),
        aborted,
      ]);
      controller.signal.throwIfAborted();
      if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_BYTES) throw new Error("Rex CLI combined output limit exceeded");
      if (result.code !== 0) throw new Error(`Rex CLI exited ${result.code}: ${result.stderr.slice(0, 2000).trim() || "no diagnostic"}`);
      let value: unknown;
      try { value = JSON.parse(result.stdout); } catch { throw new Error("Rex CLI returned invalid JSON"); }
      const response = object(value, "response");
      if (response.error) throw new Error(`Rex API error: ${JSON.stringify(response.error).slice(0, 2000)}`);
      return response;
    } catch (error) {
      throw new Error(`Rex ${args[0]} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  private call(sessionId: string, method: string, args: ObjectValue, signal?: AbortSignal) {
    return this.cli(["api", "call", "--session", sessionId, method, JSON.stringify({ ...args, session_id: sessionId })], signal);
  }

  private methodsChecked = false;
  private async preflight(sessionId: string, signal?: AbortSignal, parentBlock?: string) {
    id(sessionId, "session");
    if (parentBlock !== undefined) id(parentBlock, "block");
    const who = await this.cli(["whoami", "--json"], signal);
    if (typeof who.endpoint !== "string" || !who.endpoint.startsWith("unix://") || who.endpoint.length <= 7) {
      throw new Error("Rex requires the local unix:// server; remote routing is refused");
    }
    uuid(who.host_id, "host_id"); uuid(who.instance_id, "instance_id");
    if ((who.session_id !== undefined && who.session_id !== sessionId)
      || (parentBlock !== undefined && who.block_id !== undefined && who.block_id !== parentBlock)) {
      throw new Error("Rex whoami target IDs do not match the requested session/block");
    }
    const identity = { hostId: who.host_id, instanceId: who.instance_id };
    if (this.identity && (this.identity.hostId !== identity.hostId || this.identity.instanceId !== identity.instanceId)) {
      throw new Error("Rex local server identity changed; construct a new client and probe again");
    }
    // A server instance's method schemas do not change, and the identity check
    // above pins this client to one instance, so they are described once.
    if (!this.methodsChecked) {
      for (const [method, args] of Object.entries(METHODS)) {
        const description = await this.cli(["api", "describe", method, "--json"], signal);
        if (description.name !== method || description.invoke?.method !== method) throw new Error(`Rex describe did not match ${method}`);
        fields(description.input_schema, args, method);
      }
    }
    const view = await this.call(sessionId, "session.view", {}, signal);
    if (view.session_id !== sessionId) throw new Error("Rex session.view session ID does not match the requested session");
    const listed = await this.call(sessionId, "session.list_blocks", {}, signal);
    if (!Array.isArray(listed.blocks)) throw new Error("Rex session.list_blocks: blocks unavailable");
    const creators = await this.call(sessionId, "block_creator.list", {}, signal);
    if (!Array.isArray(creators.creators)) throw new Error("Rex block creators unavailable");
    const matches = creators.creators.flatMap((creator: any) => (creator.flavors ?? [])
      .filter((flavor: any) => flavor.flavor === FLAVOR).map((flavor: any) => ({ creator, flavor })));
    if (matches.length !== 1 || matches[0].creator.host_id !== identity.hostId) throw new Error("Rex local terminal creator unavailable (or remote)");
    const options = fields(matches[0].flavor.options_schema, ["shell", "command", "cwd", "size"], "terminal options");
    if (!allows(options.shell, "string") || (options.shell.enum && !options.shell.enum.includes("none"))
      || !allows(options.command, "array") || !allows(options.command.items, "string") || !allows(options.cwd, "string")) {
      throw new Error("Rex terminal does not support direct argv execution");
    }
    const size = fields(options.size, ["columns", "rows"], "terminal size");
    if (!allows(size.columns, "integer") || !allows(size.rows, "integer")) throw new Error("Rex terminal size unsupported");
    this.identity = identity;
    this.methodsChecked = true;
    const state = {
      ...identity, view, blocks: listed.blocks as ObjectValue[],
      keepOpen: allows(options.keep_open, "boolean") && (!options.keep_open.enum || options.keep_open.enum.includes(true)),
    };
    if (parentBlock !== undefined) this.target(state, parentBlock, true);
    return state;
  }

  private target(state: { hostId: string; blocks: ObjectValue[] }, blockId: string, placed = false) {
    const matches = state.blocks.filter((block) => block.block_id === blockId);
    // Read during preflight from the identity-checked local server: absence is certain.
    if (!matches.length) throw new BlockGone(blockId);
    if (matches.length !== 1 || matches[0].host_id !== state.hostId || (placed && matches[0].placement !== "placed")) {
      throw new Error(`Rex block ${blockId} is missing, remote, or not placed as required`);
    }
  }

  async probe(sessionId: string, parentBlock: string, signal?: AbortSignal): Promise<{ hostId: string; instanceId: string; sessionId: string; parentBlock: string }> {
    const { hostId, instanceId } = await this.preflight(sessionId, signal, parentBlock);
    return { hostId, instanceId, sessionId, parentBlock };
  }

  private async mutate(sessionId: string, method: string, args: ObjectValue, signal?: AbortSignal): Promise<ObjectValue> {
    try { return await this.call(sessionId, method, args, signal); }
    catch (error) {
      throw new Error(`Rex ${method} failed; outcome may be unknown. Inspect state before retrying. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async create(sessionId: string, label: string, command: string[], cwd: string, signal?: AbortSignal): Promise<string> {
    if (typeof label !== "string" || !label || [...label].length > 128 || label.includes("\0")) throw new Error("Rex label must contain 1–128 characters without NUL");
    if (!Array.isArray(command) || !command.length || command.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !command[0]) {
      throw new Error("Rex command must be a nonempty argv array without NUL");
    }
    const argv = [...command];
    if (typeof cwd !== "string" || !isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("Rex cwd must be an existing absolute directory");
    const state = await this.preflight(sessionId, signal);
    const result = await this.mutate(sessionId, "session.new_block", {
      flavor: FLAVOR, label, options: { shell: "none", command: argv, cwd, size: { columns: 100, rows: 30 }, ...(state.keepOpen ? { keep_open: true } : {}) },
    }, signal);
    try { id(result.block_id, "block"); }
    catch { throw new Error("Rex session.new_block returned no valid block ID; outcome may be unknown. Inspect state before retrying."); }
    return result.block_id;
  }

  async show(sessionId: string, blockId: string, anchorBlock: string, signal?: AbortSignal): Promise<void> {
    id(blockId, "block"); id(anchorBlock, "block");
    if (blockId === anchorBlock) throw new Error("Rex show requires a distinct anchor block");
    const state = await this.preflight(sessionId, signal);
    this.target(state, blockId); this.target(state, anchorBlock, true);
    if (state.blocks.find((block) => block.block_id === blockId)?.placement !== "detached") {
      throw new Error("Rex show requires a detached block to preserve focus; hide it before moving it");
    }
    // A detached block takes no focus. Do not call any focus/window-selection API.
    await this.mutate(sessionId, "session.move_block", { block_id: blockId, anchor_block_id: anchorBlock }, signal);
  }

  async hide(sessionId: string, blockId: string, signal?: AbortSignal): Promise<void> {
    id(blockId, "block");
    const state = await this.preflight(sessionId, signal);
    this.target(state, blockId);
    await this.mutate(sessionId, "session.detach_block", { block_id: blockId }, signal);
  }

  private placement(view: ObjectValue, blockId: string) {
    if (!Array.isArray(view.windows)) throw new Error("Rex window layout is unavailable");
    const matches = view.windows.flatMap((window: any) => (window.layers ?? [])
      .filter((layer: any) => layer.blocks?.some((block: any) => block.block_id === blockId))
      .map((layer: any) => ({ window, layer })));
    if (matches.length !== 1) throw new Error("Rex block placement changed or is ambiguous; inspect before retrying");
    id(matches[0].layer.layer_id, "layer");
    return matches[0];
  }

  private async capability(method: string, names: string[], signal?: AbortSignal) {
    const description = await this.cli(["api", "describe", method, "--json"], signal);
    if (description.name !== method || description.invoke?.method !== method) throw new Error(`Rex capability unavailable: ${method}`);
    fields(description.input_schema, names, method);
  }

  /** A peek is the actual terminal in a native floating layer, never a second viewer. */
  async peek(sessionId: string, blockId: string, anchorBlock: string, signal?: AbortSignal): Promise<void> {
    id(blockId, "block"); id(anchorBlock, "block");
    if (blockId === anchorBlock) throw new Error("Rex peek requires a distinct anchor");
    let state = await this.preflight(sessionId, signal);
    this.target(state, blockId);
    if (state.blocks.find(b => b.block_id === blockId)?.placement === "detached") {
      this.target(state, anchorBlock, true);
      if (this.placement(state.view, anchorBlock).layer.kind !== "tiled") throw new Error("Peek needs a tiled parent anchor");
      await this.capability("session.float_block", ["session_id", "block_id", "bounds"], signal);
      // Rex cannot float a detached block directly. This two-step operation may
      // briefly resize the anchor; never roll back/retry an uncertain mutation.
      await this.mutate(sessionId, "session.move_block", { block_id: blockId, anchor_block_id: anchorBlock }, signal);
      state = await this.preflight(sessionId, signal);
      this.target(state, blockId);
      const placed = this.placement(state.view, blockId), anchor = this.placement(state.view, anchorBlock);
      if (placed.layer.kind !== "tiled" || placed.layer.layer_id !== anchor.layer.layer_id) throw new Error("Layout changed during peek; child left where the app placed it");
      await this.mutate(sessionId, "session.float_block", { block_id: blockId, bounds: PEEK_BOUNDS }, signal);
      return;
    }
    const { layer } = this.placement(state.view, blockId);
    if (layer.kind === "tiled") return; // Respect a pane the user has kept or moved.
    if (layer.kind !== "floating" || layer.blocks.length !== 1) throw new Error("Refusing to change a shared or unknown floating layer");
    await this.capability("session.set_layer_state", ["session_id", "layer_id", "state", "focus"], signal);
    await this.capability("session.raise_layer", ["session_id", "layer_id"], signal);
    await this.mutate(sessionId, "session.set_layer_state", { layer_id: layer.layer_id, state: "normal", focus: false }, signal);
    await this.mutate(sessionId, "session.raise_layer", { layer_id: layer.layer_id }, signal);
  }

  /** Peek a detached or minimized child; minimize a visible floating one. Tiled panes are left alone. */
  async toggle(sessionId: string, blockId: string, anchorBlock: string, signal?: AbortSignal): Promise<"floating" | "minimized" | "tiled"> {
    id(blockId, "block");
    const state = await this.preflight(sessionId, signal);
    this.target(state, blockId);
    if (state.blocks.find(b => b.block_id === blockId)?.placement !== "detached") {
      const { layer } = this.placement(state.view, blockId);
      if (layer.kind === "tiled") return "tiled";
      if (layer.kind === "floating" && layer.blocks.length === 1 && layer.state !== "minimized") {
        await this.minimize(sessionId, blockId, signal); return "minimized";
      }
    }
    await this.peek(sessionId, blockId, anchorBlock, signal); return "floating";
  }

  async minimize(sessionId: string, blockId: string, signal?: AbortSignal): Promise<void> {
    id(blockId, "block");
    const state = await this.preflight(sessionId, signal);
    this.target(state, blockId, true);
    const { layer } = this.placement(state.view, blockId);
    if (layer.kind !== "floating" || layer.blocks.length !== 1) throw new Error("Minimize requires a floating layer containing only this child; use park to detach a pane");
    await this.capability("session.set_layer_state", ["session_id", "layer_id", "state", "focus"], signal);
    await this.mutate(sessionId, "session.set_layer_state", { layer_id: layer.layer_id, state: "minimized", focus: false }, signal);
  }

  async keep(sessionId: string, blockId: string, anchorBlock: string, signal?: AbortSignal): Promise<void> {
    id(blockId, "block"); id(anchorBlock, "block");
    if (blockId === anchorBlock) throw new Error("Rex keep requires a distinct anchor");
    const state = await this.preflight(sessionId, signal);
    this.target(state, blockId);
    if (state.blocks.find(b => b.block_id === blockId)?.placement === "placed" && this.placement(state.view, blockId).layer.kind === "tiled") return;
    this.target(state, anchorBlock, true);
    const anchor = this.placement(state.view, anchorBlock);
    if (anchor.layer.kind !== "tiled") throw new Error("Keep needs a tiled parent anchor");
    if (state.blocks.find(b => b.block_id === blockId)?.placement === "placed") {
      const source = this.placement(state.view, blockId);
      if (source.window.window_id !== anchor.window.window_id) throw new Error("Child was moved to another window; keep it there using Rex");
      if (source.window.focused_block_id === blockId && state.view.active_window_id !== source.window.window_id) throw new Error("Keeping this child would activate an inactive window; use Rex to move it");
    }
    // Move only the requested block, never the whole floating layer.
    await this.mutate(sessionId, "session.move_block", { block_id: blockId, anchor_block_id: anchorBlock }, signal);
  }

  async close(sessionId: string, blockId: string, signal?: AbortSignal): Promise<void> {
    id(blockId, "block");
    const state = await this.preflight(sessionId, signal);
    this.target(state, blockId);
    const result = await this.mutate(sessionId, "block.close", { block_id: blockId }, signal);
    if (result.block_id !== blockId) throw new Error("Rex block.close returned a different block ID; inspect state before retrying");
  }

  // ---- Layout primitives for the deck/grid manager. Capabilities are checked
  // once per client; identity is rechecked on every snapshot. No retries.
  private layoutChecked = false;
  private async layoutCapabilities(signal?: AbortSignal) {
    if (this.layoutChecked) return;
    for (const [method, names] of Object.entries(LAYOUT_METHODS)) await this.capability(method, names, signal);
    this.layoutChecked = true;
  }
  /** A cheap, identity-checked view for repeated layout decisions. Requires a prior probe. */
  async snapshot(sessionId: string, signal?: AbortSignal): Promise<{ view: ObjectValue; blocks: ObjectValue[] }> {
    id(sessionId, "session");
    if (!this.identity) throw new Error("Probe Rex before layout changes");
    await this.layoutCapabilities(signal);
    const who = await this.cli(["whoami", "--json"], signal);
    if (who.host_id !== this.identity.hostId || who.instance_id !== this.identity.instanceId) throw new Error("Rex local server identity changed; layout paused");
    const view = await this.call(sessionId, "session.view", {}, signal);
    if (view.session_id !== sessionId || !Array.isArray(view.windows)) throw new Error("Rex session.view unavailable");
    const listed = await this.call(sessionId, "session.list_blocks", {}, signal);
    if (!Array.isArray(listed.blocks)) throw new Error("Rex session.list_blocks: blocks unavailable");
    return { view, blocks: listed.blocks.filter((b: any) => b.host_id === this.identity!.hostId) };
  }
  async place(sessionId: string, blockId: string, anchorBlock: string, direction: "horizontal" | "vertical", ratio: number, signal?: AbortSignal, side: "before" | "after" = "after") {
    id(blockId, "block"); id(anchorBlock, "block");
    if (!(ratio > 0 && ratio < 1)) throw new Error("Invalid split ratio");
    await this.mutate(sessionId, "session.move_block", { block_id: blockId, anchor_block_id: anchorBlock, direction, side, ratio }, signal);
  }
  async resizePane(sessionId: string, before: string, after: string, direction: "horizontal" | "vertical", ratio: number, signal?: AbortSignal) {
    id(before, "block"); id(after, "block");
    if (!(ratio > 0 && ratio < 1)) throw new Error("Invalid split ratio");
    await this.mutate(sessionId, "session.resize_pane", { before_block_id: before, after_block_id: after, direction, ratio }, signal);
  }
  async swap(sessionId: string, a: string, b: string, signal?: AbortSignal) {
    id(a, "block"); id(b, "block");
    await this.mutate(sessionId, "session.swap_blocks", { block_id: a, other_block_id: b }, signal);
  }
  async detach(sessionId: string, blockId: string, signal?: AbortSignal) {
    id(blockId, "block");
    await this.mutate(sessionId, "session.detach_block", { block_id: blockId }, signal);
  }
  /** A background window whose first block is a small roster terminal (argv, no shell). */
  async newWindow(sessionId: string, label: string, rosterLabel: string, command: string[], cwd: string, signal?: AbortSignal): Promise<{ windowId: string; blockId: string }> {
    if (!command.length || command.some(arg => typeof arg !== "string" || arg.includes("\0")) || !isAbsolute(cwd)) throw new Error("Invalid roster command");
    const result = await this.mutate(sessionId, "session.new_window", { focus: false, window_label: label.slice(0, 120),
      layout: { block: { flavor: FLAVOR, label: rosterLabel.slice(0, 120), options: { shell: "none", command, cwd } } } }, signal);
    const blockId = Array.isArray(result.block_ids) ? result.block_ids[0] : undefined;
    if (typeof result.window_id !== "string" || !result.window_id.startsWith("window:")) throw new Error("Rex session.new_window returned no window; outcome may be unknown");
    id(blockId, "block");
    return { windowId: result.window_id, blockId };
  }
  /** Reorders a tab; without `before` it goes last. Never changes the active window or focus. */
  async moveWindow(sessionId: string, windowId: string, before?: string, signal?: AbortSignal) {
    id(windowId, "window"); if (before !== undefined) id(before, "window");
    await this.mutate(sessionId, "session.move_window", { window_id: windowId, ...(before ? { before_window_id: before } : {}) }, signal);
  }
  async labelWindow(sessionId: string, windowId: string, label: string, signal?: AbortSignal) {
    id(windowId, "window");
    if (!label || [...label].length > 128 || label.includes("\0")) throw new Error("Rex label must contain 1–128 characters without NUL");
    await this.mutate(sessionId, "session.set_window_label", { window_id: windowId, label }, signal);
  }
  /** Fills the block's window with it (focusing it and activating its window) until focus moves. */
  async zoom(sessionId: string, blockId: string, signal?: AbortSignal) {
    id(blockId, "block");
    await this.mutate(sessionId, "session.zoom_block", { block_id: blockId, zoom: true }, signal);
  }
  async focus(sessionId: string, target: { block?: string; window?: string }, signal?: AbortSignal) {
    if (target.block) { id(target.block, "block"); await this.mutate(sessionId, "session.focus_block", { block_id: target.block }, signal); }
    else if (target.window?.startsWith("window:")) await this.mutate(sessionId, "session.focus_window", { window_id: target.window }, signal);
    else throw new Error("Nothing to focus");
  }
  /** The last `bytes` of a terminal's text (screen plus scrollback), without reading the whole scrollback. */
  async tail(sessionId: string, blockId: string, bytes = 6000, signal?: AbortSignal): Promise<string> {
    id(sessionId, "session"); id(blockId, "block");
    const first = await this.call(sessionId, "block.method", { block_id: blockId, method: "format", args: { trim: true, max_bytes: bytes } }, signal);
    if (typeof first.content !== "string") throw new Error("Rex terminal text unavailable");
    if (first.id === undefined || typeof first.total !== "number" || first.total <= bytes) return first.content;
    // max_bytes counts JSON-escaped bytes, so read from the offset with room to spare.
    const rest = await this.call(sessionId, "block.method", { block_id: blockId, method: "blob_read",
      args: { id: first.id, offset: first.total - bytes, max_bytes: bytes * 4 } }, signal);
    if (typeof rest.data !== "string") throw new Error("Rex terminal text unavailable");
    return rest.data.slice(rest.data.indexOf("\n") + 1); // Drop the partial first line.
  }
  /**
   * A child's way back: focus the parent pane (which ends a zoom). `openedLayer`
   * is the floating layer the parent's hub put the child in to open it; if the
   * child is still alone there, it is detached again so the deck can place it.
   * Any other placement, including a float the user made, is left alone.
   */
  async returnTo(sessionId: string, self: string, parent: string, openedLayer?: string, signal?: AbortSignal): Promise<boolean> {
    id(sessionId, "session"); id(self, "block"); id(parent, "block");
    const who = await this.cli(["whoami", "--json"], signal);
    if (typeof who.endpoint !== "string" || !who.endpoint.startsWith("unix://")) throw new Error("Rex requires the local unix:// server; remote routing is refused");
    const view = await this.call(sessionId, "session.view", {}, signal);
    const layer = layerOf(view, self);
    const ours = !!openedLayer && layer?.kind === "floating" && layer.layer_id === openedLayer && layer.blocks?.length === 1;
    await this.mutate(sessionId, "session.focus_block", { block_id: parent }, signal);
    if (ours) await this.mutate(sessionId, "session.detach_block", { block_id: self }, signal);
    return ours;
  }
  /** Where a block is right now: detached, or its layer's kind and ID. Requires a prior probe. */
  async whereIs(sessionId: string, blockId: string, signal?: AbortSignal): Promise<{ kind: "detached" | "tiled" | "floating" | "missing"; layer?: string; window?: string }> {
    id(blockId, "block");
    const { view, blocks } = await this.snapshot(sessionId, signal);
    const block = blocks.find(b => b.block_id === blockId);
    if (!block) return { kind: "missing" };
    if (block.placement === "detached") return { kind: "detached" };
    for (const window of view.windows ?? []) for (const layer of window.layers ?? [])
      if ((layer.blocks ?? []).some((b: any) => b.block_id === blockId)) return { kind: layer.kind === "floating" ? "floating" : "tiled", layer: layer.layer_id, window: window.window_id };
    return { kind: "missing" };
  }
  async rows(sessionId: string, blockId: string, signal?: AbortSignal): Promise<{ columns: number; rows: number }> {
    id(blockId, "block");
    const size = await this.call(sessionId, "block.method", { block_id: blockId, method: "size" }, signal);
    if (!Number.isInteger(size.columns) || !Number.isInteger(size.rows)) throw new Error("Rex terminal size unavailable");
    return { columns: size.columns, rows: size.rows };
  }
}
