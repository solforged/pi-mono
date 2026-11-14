import assert from "node:assert/strict";
import test from "node:test";
import { cells, columns, GRID_CELLS, plan, ratioBetween, type GridChild, type PlanInput } from "../extensions/rex/grid.ts";
import { GridManager } from "../extensions/rex/layout.ts";

type Spec = string | { d: "horizontal" | "vertical"; r?: number; a: Spec; b: Spec };
const B = (n: string | number) => `block:${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const P = B("p"), H = B("h"), X = B("x");
function tree(spec: Spec, rect = [0, 0, 1, 1]): any {
  if (typeof spec === "string") return { rect, block_id: spec };
  const r = spec.r ?? 0.5, [x, y, w, h] = rect;
  const [ra, rb] = spec.d === "horizontal" ? [[x, y, w * r, h], [x + w * r, y, w * (1 - r), h]] : [[x, y, w, h * r], [x, y + h * r, w, h * (1 - r)]];
  return { rect, split: { direction: spec.d, ratio: r, before: tree(spec.a, ra), after: tree(spec.b, rb) } };
}
const win = (id: string, spec: Spec, focused?: string) => {
  const layout = tree(spec);
  return { window_id: id, focused_block_id: focused ?? cells(layout)[0].block, layers: [{ layer_id: `layer:${id}`, kind: "tiled", layout, blocks: cells(layout).map(c => ({ block_id: c.block })) }] };
};
const child = (n: number, extra: Partial<GridChild> = {}): GridChild => ({ block: B(n), name: `c${n}`, priority: 1, background: false, ...extra });
const home = (spec: Spec = P) => win("window:home", spec, P);
function input(windows: any[], children: GridChild[], extra: Partial<PlanInput> = {}): PlanInput {
  const placed = new Set(windows.flatMap(w => w.layers.flatMap((l: any) => l.blocks.map((b: any) => b.block_id))));
  const blocks = [P, H, X, ...children.map(c => c.block)].map(block_id => ({ block_id, placement: placed.has(block_id) ? "placed" : "detached" }));
  return { view: { active_window_id: "window:home", windows }, blocks, children, ...extra };
}
const grid = { window: "window:grid" };

test("ratios and columns are read from the actual layout", () => {
  const layout = tree({ d: "horizontal", a: { d: "vertical", r: 1 / 3, a: B(1), b: B(2) }, b: B(3) });
  assert.equal(ratioBetween(layout, B(1), B(3), "horizontal"), 0.5);
  assert.equal(ratioBetween(layout, B(1), B(2), "vertical"), 1 / 3);
  assert.equal(ratioBetween(layout, B(2), B(1), "vertical"), undefined);
  assert.deepEqual(columns(cells(layout)).map(c => c.map(x => x.block)), [[B(1), B(2)], [B(3)]]);
});

test("the first child opens the Agents tab, replaces its placeholder, and the parent's window is never touched", () => {
  // Even a parent window with room to spare, or with a diff beside it.
  for (const parent of [home(), home({ d: "horizontal", r: 0.67, a: P, b: X })]) {
    assert.deepEqual(plan(input([parent], [child(1)])), { kind: "window" });
    const opened = { window: "window:grid", placeholder: H };
    assert.deepEqual(plan(input([parent, win("window:grid", H)], [child(1)], { grid: opened })), { kind: "place", block: B(1), anchor: H, direction: "horizontal", ratio: 0.5 });
    assert.deepEqual(plan(input([parent, win("window:grid", { d: "horizontal", a: H, b: B(1) })], [child(1), child(2)], { grid: opened })), { kind: "close-placeholder" });
    assert.equal(plan(input([parent, win("window:grid", B(1))], [child(1)], { grid })), undefined);
  }
});

test("the grid adds columns while single-row, then fills the shortest column, and keeps sizes even", () => {
  const kids = [1, 2, 3, 4, 5].map(n => child(n));
  assert.deepEqual(plan(input([home(), win("window:grid", B(1))], kids.slice(0, 2), { grid })), { kind: "place", block: B(2), anchor: B(1), direction: "horizontal", ratio: 0.5 });
  const two = win("window:grid", { d: "horizontal", a: B(1), b: B(2) });
  assert.deepEqual(plan(input([home(), two], kids.slice(0, 3), { grid })), { kind: "place", block: B(3), anchor: B(1), direction: "vertical", ratio: 0.5 }, "3 cells: two columns");
  assert.deepEqual(plan(input([home(), two], kids, { grid })), { kind: "place", block: B(3), anchor: B(2), direction: "horizontal", ratio: 0.5 }, "5 cells: three columns");
  const uneven = win("window:grid", { d: "horizontal", a: B(1), b: { d: "horizontal", a: B(2), b: B(3) } });
  assert.deepEqual(plan(input([home(), uneven], kids.slice(0, 3), { grid })), { kind: "resize", before: B(1), after: B(2), direction: "horizontal", ratio: 1 / 3 });
  const three = win("window:grid", { d: "horizontal", a: { d: "vertical", a: B(1), b: B(3) }, b: B(2) });
  assert.deepEqual(plan(input([home(), three], kids.slice(0, 4), { grid })), { kind: "place", block: B(4), anchor: B(2), direction: "vertical", ratio: 0.5 });
  const twoByTwo = (focused?: string) => win("window:grid", { d: "horizontal", a: { d: "vertical", a: B(1), b: B(3) }, b: { d: "vertical", a: B(2), b: B(4) } }, focused);
  // A grid that needs another column is re-laid out by detaching a movable cell, never a focused one.
  const seven = [...kids, child(6), child(7)];
  assert.deepEqual(plan(input([home(), twoByTwo()], seven, { grid })), { kind: "detach", block: B(4) });
  assert.deepEqual(plan(input([home(), twoByTwo(B(4))], seven, { grid })), { kind: "detach", block: B(3) });
});

test("a full 3×3 grid leaves the rest detached; only a child that needs you or is working takes an idle child's cell", () => {
  const spec: Spec = { d: "horizontal", r: 1 / 3, a: { d: "vertical", r: 1 / 3, a: B(1), b: { d: "vertical", a: B(2), b: B(3) } },
    b: { d: "horizontal", a: { d: "vertical", r: 1 / 3, a: B(4), b: { d: "vertical", a: B(5), b: B(6) } }, b: { d: "vertical", r: 1 / 3, a: B(7), b: { d: "vertical", a: B(8), b: B(9) } } } };
  assert.equal(cells(tree(spec)).length, GRID_CELLS);
  const kids = (p10: number, p5 = 1) => [...[1, 2, 3, 4, 6, 7, 8, 9].map(n => child(n, { priority: 3 })), child(5, { priority: p5 }), child(10, { priority: p10 })];
  assert.equal(plan(input([home(), win("window:grid", spec)], kids(2), { grid })), undefined, "an unread result waits for a free cell");
  assert.deepEqual(plan(input([home(), win("window:grid", spec)], kids(3), { grid })), { kind: "detach", block: B(5) });
  assert.deepEqual(plan(input([home(), win("window:grid", spec)], kids(4), { grid })), { kind: "detach", block: B(5) });
  assert.equal(plan(input([home(), win("window:grid", spec)], kids(3, 3), { grid })), undefined, "equals never swap");
  assert.deepEqual(plan(input([home(), win("window:grid", spec, B(5))], kids(4), { grid })), { kind: "detach", block: B(1) }, "a focused cell stays; need-you outranks working");
});

test("user placements, background children and a closed tab are respected", () => {
  const floating = { ...home(), layers: [home().layers[0], { layer_id: "layer:f", kind: "floating", blocks: [{ block_id: B(1) }] }] };
  assert.equal(plan(input([floating], [child(1)])), undefined);
  assert.equal(plan(input([home({ d: "horizontal", a: P, b: B(1) })], [child(1)])), undefined, "a pane the user moved beside the parent stays");
  assert.equal(plan(input([home()], [child(1, { background: true })])), undefined);
  assert.deepEqual(plan(input([home()], [child(1)], { grid })), { kind: "forget-grid" });
});

// A small Rex layout simulator: binary split trees with move/resize/detach semantics.
function simulator() {
  const windows = new Map<string, Spec>([["window:home", { d: "horizontal", r: 0.67, a: P, b: X }]]), focus = new Map<string, string>([["window:home", P]]);
  const remove = (spec: Spec, block: string): Spec | undefined => {
    if (typeof spec === "string") return spec === block ? undefined : spec;
    const a = remove(spec.a, block), b = remove(spec.b, block);
    return a === undefined ? b : b === undefined ? a : { ...spec, a, b };
  };
  // Rex closes a window with its last block.
  const detach = (block: string) => { for (const [id, spec] of windows) { const next = remove(spec, block); if (next === undefined) windows.delete(id); else windows.set(id, next); } };
  const replace = (spec: Spec, anchor: string, f: (leaf: string) => Spec): Spec =>
    typeof spec === "string" ? (spec === anchor ? f(spec) : spec) : { ...spec, a: replace(spec.a, anchor, f), b: replace(spec.b, anchor, f) };
  const has = (spec: Spec, block: string): boolean => typeof spec === "string" ? spec === block : has(spec.a, block) || has(spec.b, block);
  const resize = (spec: Spec, a: string, b: string, d: string, r: number): boolean => {
    if (typeof spec === "string") return false;
    if (resize(spec.a, a, b, d, r) || resize(spec.b, a, b, d, r)) return true;
    if (spec.d === d && has(spec.a, a) && has(spec.b, b)) { spec.r = r; return true; }
    return false;
  };
  const all = new Set<string>([P, X]), labels = new Map<string, string>();
  const rex: any = {
    calls: [] as string[],
    async probe() {},
    async snapshot() {
      const view = { active_window_id: "window:home", windows: [...windows].map(([id, spec]) => ({ ...win(id, spec, focus.get(id)), label: labels.get(id) ?? id })) };
      const placed = new Set(view.windows.flatMap(w => cells(w.layers[0].layout).map(c => c.block)));
      return { view, blocks: [...all].map(block_id => ({ block_id, placement: placed.has(block_id) ? "placed" : "detached" })) };
    },
    async place(_s: string, block: string, anchor: string, d: any, r: number) {
      rex.calls.push("place"); detach(block);
      for (const [id, spec] of windows) windows.set(id, replace(spec, anchor, leaf => ({ d, r, a: leaf, b: block })));
    },
    async resizePane(_s: string, a: string, b: string, d: string, r: number) { rex.calls.push("resize"); for (const spec of windows.values()) resize(spec, a, b, d, r); },
    async detach(_s: string, block: string) { rex.calls.push("detach"); detach(block); },
    async newWindow(_s: string, label: string, _blockLabel: string, command: string[]) {
      rex.calls.push("window"); assert.equal(command[0], "/bin/sleep");
      windows.set("window:grid", H); labels.set("window:grid", label); focus.set("window:grid", H); all.add(H); return { windowId: "window:grid", blockId: H };
    },
    async moveWindow(_s: string, id: string, before?: string) {
      rex.calls.push("move-window");
      const entries = [...windows].filter(([w]) => w !== id), at = before ? entries.findIndex(([w]) => w === before) : entries.length;
      entries.splice(at, 0, [id, windows.get(id)!]); windows.clear(); for (const [w, spec] of entries) windows.set(w, spec);
    },
    async labelWindow(_s: string, id: string, label: string) { rex.calls.push("label-window"); labels.set(id, label); },
    async close(_s: string, block: string) { rex.calls.push("close"); detach(block); all.delete(block); },
  };
  return { rex, windows, all, focus, labels };
}

test("the manager converges 12 children into one Agents tab of 3×3 beside an untouched parent window, then cleans up", async () => {
  const sim = simulator(), kids = new Map<number, GridChild>(), states: any[] = [], pauses: string[] = [];
  const O = B("o"); sim.windows.set("window:other", O); sim.all.add(O); // Another tab, already open after the parent's.
  const manager = new GridManager({ rex: sim.rex, session: "session:x", parent: P, cwd: "/tmp",
    children: () => [...kids.values()], tabLabel: () => `Agents · ${kids.size}`, onState: g => states.push(g), onPause: r => pauses.push(r) });
  const parentWindow = JSON.stringify(sim.windows.get("window:home"));
  for (let n = 1; n <= 12; n++) { kids.set(n, child(n, { priority: 3 })); sim.all.add(B(n)); await manager.run(); }
  assert.deepEqual(pauses, []);
  assert.equal(JSON.stringify(sim.windows.get("window:home")), parentWindow, "the parent's window and its diff pane are untouched");
  const gridCells = cells(tree(sim.windows.get("window:grid")!));
  assert.equal(gridCells.length, 9); assert(!gridCells.some(c => c.block === H), "the placeholder is gone");
  assert(!sim.all.has(H));
  assert.deepEqual(columns(gridCells).map(c => c.length), [3, 3, 3]);
  for (const c of gridCells) { assert(Math.abs(c.rect[2] - 1 / 3) < 0.03); assert(Math.abs(c.rect[3] - 1 / 3) < 0.03); }
  // The Agents tab sits right after the parent's, labelled.
  assert.deepEqual([...sim.windows.keys()], ["window:home", "window:grid", "window:other"]);
  assert.equal(sim.labels.get("window:grid"), "Agents · 12");
  // A detached child that needs you takes an idle child's cell.
  const shown = new Set(gridCells.map(c => c.block));
  const waiting = [...kids.keys()].find(k => !shown.has(B(k)))!, idle = [...kids.keys()].find(k => shown.has(B(k)))!;
  kids.set(idle, { ...kids.get(idle)!, priority: 1 }); kids.set(waiting, { ...kids.get(waiting)!, priority: 4 });
  await manager.run(); assert.deepEqual(pauses, []);
  const after = cells(tree(sim.windows.get("window:grid")!)).map(c => c.block);
  assert(after.includes(B(waiting)) && !after.includes(B(idle))); assert.equal(after.length, 9);
  // Once the user drags the Agents tab away or renames it, it stays as they left it.
  await sim.rex.moveWindow("", "window:grid"); sim.labels.set("window:grid", "mine");
  kids.delete(12); await sim.rex.close("", B(12)); await manager.run();
  assert.deepEqual([...sim.windows.keys()], ["window:home", "window:other", "window:grid"]); assert.equal(sim.labels.get("window:grid"), "mine");
  assert.equal(states.at(-1).grid.unfollowed, true); assert.equal(states.at(-1).grid.renamed, true);
  // When every child closes, Rex closes the tab and the manager forgets it.
  for (const k of [...kids.keys()]) { await sim.rex.close("", B(k)); kids.delete(k); }
  await manager.run();
  assert(!sim.windows.has("window:grid")); assert.deepEqual(states.at(-1), { grid: undefined });
  // The next child opens a fresh tab.
  kids.set(20, child(20)); sim.all.add(B(20)); await manager.run();
  assert.deepEqual(cells(tree(sim.windows.get("window:grid")!)).map(c => c.block), [B(20)]);
});

test("a failing or non-converging mutation pauses layout instead of retrying", async () => {
  const sim = simulator(), pauses: string[] = [];
  sim.all.add(B(1));
  sim.rex.place = async () => { sim.rex.calls.push("place"); }; // Rex accepted nothing.
  const manager = new GridManager({ rex: sim.rex, session: "session:x", parent: P, cwd: "/tmp", children: () => [child(1)], onState: () => {}, onPause: r => pauses.push(r) });
  await manager.run();
  assert.match(pauses[0], /did not converge/); assert.equal(sim.rex.calls.filter((c: string) => c === "place").length, 1);
  const calls = sim.rex.calls.length;
  manager.schedule(0); await new Promise(r => setTimeout(r, 20)); assert.equal(sim.rex.calls.length, calls, "paused managers stay idle");
  sim.rex.place = async () => { throw new Error("outcome may be unknown"); };
  manager.resume(); await new Promise(r => setTimeout(r, 20)); await manager.run();
  assert.match(pauses[1], /outcome may be unknown/);
});
