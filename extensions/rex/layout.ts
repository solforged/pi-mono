import { atomicWrite } from "../workflows/state.ts";
import type { RexClient } from "./client.ts";
import { classify, PARENT_SHARE, plan, rosterCommand, rosterText, stripText, type DeckChild, type Op } from "./deck.ts";

export type LayoutBackend = Pick<RexClient, "probe" | "snapshot" | "place" | "resizePane" | "swap" | "detach" | "newWindow" | "rows" | "close" | "create">;
export interface Grid { window: string; roster: string }
/** Persisted across /reload so panes created by this parent are reused, not duplicated. */
export interface LayoutState { grid?: Grid; strip?: string }
const MAX_STEPS = 80, SHARE_MS = 5000;

/** Serializes deck/grid reconciliation. Any failed or non-converging mutation
 * pauses automation; nothing is retried or rolled back. */
export class DeckManager {
  grid?: Grid;
  strip?: string;
  paused?: string;
  /** Where each child block was at the last converged step; absent means detached or unknown. */
  where = new Map<string, "deck" | "grid" | "elsewhere">();
  readonly dwell = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private again = false;
  private stopped = false;
  private probed = false;
  private shareUntil = 0;
  private written = new Map<string, string>();
  private readonly opts: {
    rex: LayoutBackend; session: string; parent: string; cwd: string; rosterFile: string; stripFile: string;
    children: () => DeckChild[]; roster: () => string[];
    /** Defaults to the parent pane's terminal size (stale if its window was never viewed). */
    size?: (signal: AbortSignal) => Promise<{ columns: number; rows: number }>; onState: (state: LayoutState) => void; onPause: (reason: string) => void;
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
  /** Rewrites the roster and strip text without touching Rex (activity, elapsed time, cost). */
  async refresh() {
    if (this.stopped) return;
    const kids = this.opts.children(), onDeck = new Set(kids.filter(k => this.where.get(k.block) === "deck").map(k => k.block));
    await this.write(this.opts.rosterFile, rosterText(this.opts.roster()));
    await this.write(this.opts.stripFile, stripText(kids, onDeck));
  }
  private async write(file: string, text: string) {
    if (this.written.get(file) === text) return;
    await atomicWrite(file, `${text}\n`); this.written.set(file, text);
  }
  private persist() { this.opts.onState({ grid: this.grid, strip: this.strip }); }

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
      await this.refresh();
      const signal = AbortSignal.timeout(60_000);
      if (!this.probed) { await rex.probe(session, parent, signal); this.probed = true; }
      const size = await (this.opts.size?.(signal) ?? rex.rows(session, parent, signal));
      let previous = "";
      for (let step = 0; step < MAX_STEPS && !this.stopped && !this.paused; step++) {
        const snap = await rex.snapshot(session, signal);
        const now = Date.now();
        const input = { ...snap, parent, grid: this.grid, strip: this.strip, children: this.opts.children(), size, now, dwell: this.dwell,
          ...(now < this.shareUntil ? { share: PARENT_SHARE } : {}) };
        const op = plan(input);
        if (!op) {
          const c = classify(input);
          this.where = new Map([...c.deck.map(d => [d.block, "deck"] as const), ...c.inGrid.map(g => [g.block, "grid"] as const),
            ...input.children.filter(k => snap.blocks.some(b => b.block_id === k.block && b.placement !== "detached") && !c.deck.some(d => d.block === k.block) && !c.inGrid.some(g => g.block === k.block))
              .map(k => [k.block, "elsewhere"] as const)]);
          await this.refresh();
          return;
        }
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
        await rex.place(session, op.block, op.anchor, op.direction, op.ratio, signal, op.side);
        // In a window Rex.app is showing, move_block splits 50/50 and the app may
        // reset the split again shortly afterwards; resize_pane is honored. Hold
        // the parent's share briefly after creating the deck, then leave it to the user.
        if (op.deck && op.anchor === this.opts.parent) {
          this.shareUntil = Date.now() + SHARE_MS;
          for (const delay of [700, 2000, 4000]) setTimeout(() => this.schedule(0), delay).unref?.();
        }
        if (op.block !== this.strip) this.dwell.set(op.block, Date.now());
        return;
      case "resize": return rex.resizePane(session, op.before, op.after, op.direction, op.ratio, signal);
      case "swap": await rex.swap(session, op.into, op.out, signal); this.dwell.set(op.into, Date.now()); return;
      case "detach": return rex.detach(session, op.block, signal);
      case "grid":
        this.grid = await rex.newWindow(session, "Rex agents", "agents", rosterCommand(this.opts.rosterFile, process.pid), this.opts.cwd, signal)
          .then(r => ({ window: r.windowId, roster: r.blockId }));
        this.persist();
        return;
      case "forget-grid": this.grid = undefined; this.persist(); return;
      case "close-grid": {
        const roster = this.grid!.roster;
        this.grid = undefined; this.persist();
        return rex.close(session, roster, signal); // The roster is the window's last block.
      }
      case "strip":
        // Created detached; the next step places it atop the deck.
        await this.write(this.opts.stripFile, stripText(this.opts.children(), new Set([...this.where].filter(([, w]) => w === "deck").map(([b]) => b))));
        this.strip = await rex.create(session, "not in the deck", rosterCommand(this.opts.stripFile, process.pid), this.opts.cwd, signal);
        this.persist();
        return;
      case "forget-strip": this.strip = undefined; this.persist(); return;
      case "close-strip": {
        const strip = this.strip!;
        this.strip = undefined; this.persist();
        return rex.close(session, strip, signal);
      }
    }
  }
}
