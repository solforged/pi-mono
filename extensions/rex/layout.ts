import { atomicWrite } from "../workflows/state.ts";
import type { RexClient } from "./client.ts";
import { plan, rosterCommand, rosterText, type DeckChild, type Op } from "./deck.ts";

export type LayoutBackend = Pick<RexClient, "probe" | "snapshot" | "place" | "resizePane" | "swap" | "detach" | "newWindow" | "rows" | "close">;
export interface Grid { window: string; roster: string }
const MAX_STEPS = 80;

/** Serializes deck/grid reconciliation. Any failed or non-converging mutation
 * pauses automation; nothing is retried or rolled back. */
export class DeckManager {
  grid?: Grid;
  paused?: string;
  readonly dwell = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private again = false;
  private stopped = false;
  private probed = false;
  private readonly opts: {
    rex: LayoutBackend; session: string; parent: string; cwd: string; rosterFile: string;
    children: () => DeckChild[]; roster: () => string[];
    /** Defaults to the parent pane's terminal size (stale if its window was never viewed). */
    size?: (signal: AbortSignal) => Promise<{ columns: number; rows: number }>; onGrid: (grid: Grid | undefined) => void; onPause: (reason: string) => void;
  };
  constructor(opts: DeckManager["opts"]) { this.opts = opts; }

  schedule(delay = 400) {
    if (this.stopped || this.paused) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, delay);
    this.timer.unref?.();
  }
  resume() { this.paused = undefined; this.schedule(0); }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); return this.running ?? Promise.resolve(); }

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
      await atomicWrite(this.opts.rosterFile, `${rosterText(this.opts.roster())}\n`);
      const signal = AbortSignal.timeout(60_000);
      if (!this.probed) { await rex.probe(session, parent, signal); this.probed = true; }
      const size = await (this.opts.size?.(signal) ?? rex.rows(session, parent, signal));
      let previous = "";
      for (let step = 0; step < MAX_STEPS && !this.stopped && !this.paused; step++) {
        const snap = await rex.snapshot(session, signal);
        const op = plan({ ...snap, parent, grid: this.grid, children: this.opts.children(), size, now: Date.now(), dwell: this.dwell });
        if (!op) return;
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

  private async apply(op: Op, signal: AbortSignal) {
    const { rex, session } = this.opts;
    switch (op.kind) {
      case "place":
        await rex.place(session, op.block, op.anchor, op.direction, op.ratio, signal);
        if (op.deck) this.dwell.set(op.block, Date.now());
        return;
      case "resize": return rex.resizePane(session, op.before, op.after, op.direction, op.ratio, signal);
      case "swap": await rex.swap(session, op.into, op.out, signal); this.dwell.set(op.into, Date.now()); return;
      case "detach": return rex.detach(session, op.block, signal);
      case "grid":
        this.grid = await rex.newWindow(session, "Rex agents", "agents", rosterCommand(this.opts.rosterFile, process.pid), this.opts.cwd, signal)
          .then(r => ({ window: r.windowId, roster: r.blockId }));
        this.opts.onGrid(this.grid);
        return;
      case "forget-grid": this.grid = undefined; this.opts.onGrid(undefined); return;
      case "close-grid": {
        const roster = this.grid!.roster;
        this.grid = undefined; this.opts.onGrid(undefined);
        return rex.close(session, roster, signal); // The roster is the window's last block.
      }
    }
  }
}
