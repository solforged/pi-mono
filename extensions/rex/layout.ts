import type { RexClient } from "./client.ts";
import { plan, PLACEHOLDER, type Grid, type GridChild, type Op } from "./grid.ts";
import { tabPlan, windowOrder, type TabOp, type TabState } from "./tabs.ts";

export type LayoutBackend = Pick<RexClient, "probe" | "snapshot" | "place" | "resizePane" | "detach" | "newWindow" | "close" | "moveWindow" | "labelWindow">;
/** Persisted across /reload so the Agents tab this parent made is reused, not duplicated. */
export interface LayoutState { grid?: Grid }
const MAX_STEPS = 60;

/** Serializes Agents tab reconciliation. Any failed or non-converging mutation
 * pauses automation; nothing is retried or rolled back. */
export class GridManager {
  grid?: Grid;
  paused?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private again = false;
  private stopped = false;
  private probed = false;
  /** Agents tab bookkeeping not worth persisting: the settled window order and the label last applied. */
  private tabOrder?: string[];
  private tabLabel?: string;
  private readonly opts: {
    rex: LayoutBackend; session: string; parent: string; cwd: string;
    children: () => GridChild[];
    /** The Agents tab's label, with child and attention counts; recomputed every settle. */
    tabLabel?: () => string;
    onState: (state: LayoutState) => void; onPause: (reason: string) => void;
  };
  constructor(opts: GridManager["opts"]) { this.opts = opts; }

  schedule(delay = 400) {
    if (this.stopped || this.paused) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, delay);
    this.timer.unref?.();
  }
  resume() { this.paused = undefined; this.schedule(0); }
  /** Children keep their panes: a session that comes back plans from what it finds. */
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); return this.running ?? Promise.resolve(); }
  private persist() { this.opts.onState({ grid: this.grid }); }

  run(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do { this.again = false; await this.reconcile(); } while (this.again && !this.stopped && !this.paused);
      } finally { this.running = undefined; }
    })();
    return this.running;
  }

  private async reconcile() {
    const { rex, session, parent } = this.opts;
    try {
      const signal = AbortSignal.timeout(60_000);
      if (!this.probed) { await rex.probe(session, parent, signal); this.probed = true; }
      let previous = "";
      for (let step = 0; step < MAX_STEPS && !this.stopped && !this.paused; step++) {
        const snap = await rex.snapshot(session, signal);
        const op: Op | TabOp | undefined = plan({ ...snap, grid: this.grid, children: this.opts.children() }) ?? this.tabs(snap.view);
        if (!op) { this.tabOrder = windowOrder(snap.view); return; }
        const key = JSON.stringify(op);
        if (key === previous) throw new Error(`Rex layout did not converge (${op.kind})`);
        previous = key;
        await this.apply(op, signal);
      }
    } catch (error) {
      if (this.stopped) return;
      this.paused = error instanceof Error ? error.message : String(error);
      this.opts.onPause(this.paused);
    }
  }

  /** Once panes settle: the Agents tab follows the parent's tab and updates its counts. */
  private tabs(view: Record<string, any>): TabOp | undefined {
    if (!this.grid) return undefined;
    const before: TabState = { order: this.tabOrder, label: this.tabLabel, unfollowed: this.grid.unfollowed, renamed: this.grid.renamed };
    const { state, op } = tabPlan({ view, parent: this.opts.parent, grid: this.grid.window, label: this.opts.tabLabel?.(), state: before });
    if (state.unfollowed !== before.unfollowed || state.renamed !== before.renamed) {
      this.grid = { ...this.grid, ...(state.unfollowed ? { unfollowed: true } : {}), ...(state.renamed ? { renamed: true } : {}) };
      this.persist();
    }
    return op;
  }

  private async apply(op: Op | TabOp, signal: AbortSignal) {
    const { rex, session } = this.opts;
    switch (op.kind) {
      case "move-window":
        // Our own move must not read as the user's on the next step.
        this.tabOrder = undefined;
        return rex.moveWindow(session, op.window, op.before, signal);
      case "label-window":
        await rex.labelWindow(session, op.window, op.label, signal);
        this.tabLabel = op.label;
        return;
      case "place": return rex.place(session, op.block, op.anchor, op.direction, op.ratio, signal);
      case "resize": return rex.resizePane(session, op.before, op.after, op.direction, op.ratio, signal);
      case "detach": return rex.detach(session, op.block, signal);
      case "window": {
        this.tabLabel = this.opts.tabLabel?.() || "Agents"; this.tabOrder = undefined;
        const created = await rex.newWindow(session, this.tabLabel, "starting agents", PLACEHOLDER, this.opts.cwd, signal);
        this.grid = { window: created.windowId, placeholder: created.blockId };
        this.persist();
        return;
      }
      case "close-placeholder": {
        const placeholder = this.grid!.placeholder!;
        this.grid = { ...this.grid!, placeholder: undefined }; this.persist();
        return rex.close(session, placeholder, signal).catch(() => {}); // It may have exited already.
      }
      // Rex closes a window with its last block.
      case "forget-grid": this.grid = undefined; this.persist(); return;
    }
  }
}
