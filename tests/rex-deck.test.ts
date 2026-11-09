import assert from "node:assert/strict";
import test from "node:test";
import { cells, columns, GRID_CELLS, plan, ratioBetween, rosterCommand, rosterText, slotsFor, stripFraction, stripText, type DeckChild, type PlanInput } from "../extensions/rex/deck.ts";

type Spec = string | { d: "horizontal" | "vertical"; r?: number; a: Spec; b: Spec };
const B = (n: string | number) => `block:${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const P = B("p"), R = B("r");
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
const child = (n: number, extra: Partial<DeckChild> = {}): DeckChild => ({ block: B(n), name: `c${n}`, priority: 1, pinned: false, background: false, ...extra });
function input(windows: any[], children: DeckChild[], extra: Partial<PlanInput> = {}): PlanInput {
  const placed = new Set(windows.flatMap(w => w.layers.flatMap((l: any) => l.blocks.map((b: any) => b.block_id))));
  const blocks = [P, R, ...children.map(c => c.block)].map(block_id => ({ block_id, placement: placed.has(block_id) ? "placed" : "detached" }));
  return { view: { active_window_id: "window:home", windows }, blocks, parent: P, children, size: { columns: 240, rows: 63 }, now: 100_000, dwell: new Map(), ...extra };
}
const grid = { window: "window:grid", roster: R };
const S = "block:0000005f-0000-4000-8000-000000000000";
const deck3 = (focused?: string): Spec => ({ d: "horizontal", r: 0.55, a: P, b: { d: "vertical", r: 1 / 3, a: B(1), b: { d: "vertical", a: B(2), b: B(3) } } });

test("ratios, columns and slots are read from the actual layout", () => {
  const layout = tree(deck3());
  assert.equal(ratioBetween(layout, P, B(2), "horizontal"), 0.55);
  assert.equal(ratioBetween(layout, B(1), B(2), "vertical"), 1 / 3);
  assert.equal(ratioBetween(layout, B(2), B(3), "vertical"), 0.5);
  assert.equal(ratioBetween(layout, B(3), B(2), "vertical"), undefined);
  assert.deepEqual(columns(cells(tree({ d: "horizontal", a: { d: "vertical", a: R, b: B(1) }, b: B(2) }))).map(c => c.map(x => x.block)), [[R, B(1)], [B(2)]]);
  assert.deepEqual([slotsFor(240, 63), slotsFor(240, 45), slotsFor(240, 30), slotsFor(140, 63)], [3, 2, 1, 0]);
});

test("new children fill deck slots beside the parent, then the deck balances evenly", () => {
  const children = [child(1), child(2), child(3)];
  assert.deepEqual(plan(input([win("window:home", P)], children)), { kind: "place", block: B(1), anchor: P, direction: "horizontal", ratio: 0.55, deck: true });
  assert.deepEqual(plan(input([win("window:home", { d: "horizontal", r: 0.55, a: P, b: B(1) })], children)),
    { kind: "place", block: B(2), anchor: B(1), direction: "vertical", ratio: 0.5, deck: true });
  const uneven = win("window:home", { d: "horizontal", r: 0.55, a: P, b: { d: "vertical", a: B(1), b: { d: "vertical", a: B(2), b: B(3) } } });
  assert.deepEqual(plan(input([uneven], children)), { kind: "resize", before: B(1), after: B(2), direction: "vertical", ratio: 1 / 3 });
  assert.equal(plan(input([win("window:home", deck3())], children)), undefined);
});

test("right after the deck opens, the parent's share is held; afterwards the user's resize stands", () => {
  const evenSplit = win("window:home", { d: "horizontal", r: 0.5, a: P, b: B(1) });
  assert.deepEqual(plan(input([evenSplit], [child(1)], { share: 0.55, size: { columns: 240, rows: 30 } })), { kind: "resize", before: P, after: B(1), direction: "horizontal", ratio: 0.55 });
  assert.equal(plan(input([evenSplit], [child(1)], { size: { columns: 240, rows: 30 } })), undefined);
});

test("overflow opens the grid window, adds columns while single-row, then fills the shortest column", () => {
  const children = [1, 2, 3, 4, 5, 6].map(n => child(n)), home = win("window:home", deck3());
  assert.deepEqual(plan(input([home], children)), { kind: "grid" });
  assert.deepEqual(plan(input([home, win("window:grid", R)], children, { grid })), { kind: "place", block: B(4), anchor: R, direction: "horizontal", ratio: 0.5, deck: false });
  const two = win("window:grid", { d: "horizontal", a: R, b: B(4) });
  // Roster + 3 overflow children target a 2×2 grid: two columns exist, so fill the shortest.
  assert.deepEqual(plan(input([home, two], children, { grid })), { kind: "place", block: B(5), anchor: R, direction: "vertical", ratio: 0.5, deck: false });
  assert.deepEqual(plan(input([home, two], [...children, child(7), child(8)], { grid })), { kind: "place", block: B(5), anchor: B(4), direction: "horizontal", ratio: 0.5, deck: false }, "2 + 3 cells target three columns");
  const four = win("window:grid", { d: "horizontal", r: 1 / 3, a: { d: "vertical", a: R, b: B(6) }, b: { d: "horizontal", a: B(4), b: B(5) } });
  const seven = [...children, child(7)];
  assert.deepEqual(plan(input([home, four], seven, { grid })), { kind: "place", block: B(7), anchor: B(4), direction: "vertical", ratio: 0.5, deck: false });
});

test("a grid that needs another column is re-laid out by detaching movable cells, never the roster or focused cells", () => {
  const home = win("window:home", deck3());
  const twoByTwo = (focused?: string) => win("window:grid", { d: "horizontal", a: { d: "vertical", a: R, b: B(5) }, b: { d: "vertical", a: B(4), b: B(6) } }, focused);
  const children = [1, 2, 3, 4, 5, 6, 7].map(n => child(n));
  assert.deepEqual(plan(input([home, twoByTwo()], children, { grid })), { kind: "detach", block: B(6) });
  assert.deepEqual(plan(input([home, twoByTwo(B(6))], children, { grid })), { kind: "detach", block: B(5) });
});

test("attention and pins are promoted by swapping out the weakest unfocused, unpinned deck child after its dwell", () => {
  const home = (focused?: string) => win("window:home", deck3(), focused ?? P), g = win("window:grid", { d: "horizontal", a: R, b: B(4) });
  const kids = (p4: number, extra: Partial<DeckChild> = {}) => [child(1, { priority: 3 }), child(2, { priority: 1 }), child(3, { priority: 2 }), child(4, { priority: p4, ...extra })];
  assert.deepEqual(plan(input([home(), g], kids(4), { grid })), { kind: "swap", into: B(4), out: B(2) });
  const recent = new Map([[B(2), 99_000]]);
  assert.deepEqual(plan(input([home(), g], kids(3), { grid, dwell: recent })), { kind: "strip" }, "running waits for the dwell; the strip is next");
  assert.deepEqual(plan(input([home(), g], kids(4), { grid, dwell: recent })), { kind: "swap", into: B(4), out: B(2) }, "attention does not wait");
  assert.deepEqual(plan(input([home(), g], kids(1, { pinned: true }), { grid })), { kind: "swap", into: B(4), out: B(2) });
  assert.deepEqual(plan(input([home(B(2)), g], kids(4), { grid })), { kind: "swap", into: B(4), out: B(3) }, "focused deck child stays");
  const pinnedDeck = [child(1, { pinned: true }), child(2, { pinned: true }), child(3, { pinned: true }), child(4, { priority: 4 })];
  assert.deepEqual(plan(input([home(), g], pinnedDeck, { grid })), { kind: "strip" }, "a pinned deck is never swapped");
});

test("swaps protect only the active window's focus; moves still skip any window's focused pane", () => {
  const home = win("window:home", deck3(), P);
  const g = (focused: string) => win("window:grid", { d: "horizontal", a: R, b: { d: "vertical", a: B(4), b: B(5) } }, focused);
  const kids = [child(1, { priority: 3 }), child(2, { priority: 1 }), child(3, { priority: 3 }), child(4, { priority: 4 }), child(5, { priority: 2 })];
  // Rex may leave a swapped-in grid pane as that (inactive) window's focus; it can still swap.
  assert.deepEqual(plan(input([home, g(B(4))], kids, { grid })), { kind: "swap", into: B(4), out: B(2) });
  const active = { ...input([home, g(B(4))], kids, { grid }) };
  active.view = { ...active.view, active_window_id: "window:grid" };
  assert.deepEqual(plan(active), { kind: "swap", into: B(5), out: B(2) }, "not while the user is focused on it");
  const twoSlots = input([win("window:home", { d: "horizontal", r: 0.55, a: P, b: B(1) }), g(B(4))], [kids[0], kids[3], kids[4]], { grid, size: { columns: 240, rows: 45 } });
  assert.deepEqual(plan(twoSlots), { kind: "place", block: B(5), anchor: B(1), direction: "vertical", ratio: 0.5, deck: true }, "a free slot never moves a focused pane");
});

test("user placements, background children, narrow windows and stale grids are respected", () => {
  const floating = { window_id: "window:home", focused_block_id: P, layers: [win("window:home", P).layers[0], { layer_id: "layer:f", kind: "floating", blocks: [{ block_id: B(1) }] }] };
  assert.equal(plan(input([floating], [child(1)])), undefined);
  assert.equal(plan(input([win("window:home", P)], [child(1, { background: true })])), undefined);
  assert.deepEqual(plan(input([win("window:home", P)], [child(1)], { size: { columns: 120, rows: 63 } })), { kind: "grid" });
  assert.deepEqual(plan(input([win("window:home", P)], [], { grid })), { kind: "forget-grid" });
  assert.deepEqual(plan(input([win("window:home", P), win("window:grid", R)], [], { grid })), { kind: "close-grid" });
  const detachedParent = input([], [child(1)]);
  assert.equal(plan(detachedParent), undefined);
});

test("the strip sits atop the deck while a child is out of it, and closes before the deck empties", () => {
  const withStrip = (windows: any[], kids: DeckChild[], placed: boolean) => {
    const i = input(windows, kids, { strip: S, ...(windows.length > 1 ? { grid } : {}) }); i.blocks.push({ block_id: S, placement: placed ? "placed" : "detached" }); return i;
  };
  const g = win("window:grid", { d: "horizontal", a: R, b: B(4) });
  const kids = [child(1), child(2), child(3), child(4)];
  assert.deepEqual(plan(input([win("window:home", deck3()), g], kids, { grid })), { kind: "strip" });
  assert.deepEqual(plan(withStrip([win("window:home", deck3()), g], kids, false)),
    { kind: "place", block: S, anchor: B(1), direction: "vertical", ratio: 0.25, deck: false, side: "before" });
  // Placed inside the first slot's leaf: weights still give it header + 1 line + title row.
  const stacked: Spec = { d: "horizontal", r: 0.55, a: P, b: { d: "vertical", r: 1 / 3, a: { d: "vertical", r: 0.5, a: S, b: B(1) }, b: { d: "vertical", a: B(2), b: B(3) } } };
  const f = stripFraction(1, 63), slot = (1 - f) / 3;
  const resize: any = plan(withStrip([win("window:home", stacked), g], kids, true));
  assert.deepEqual({ ...resize, ratio: undefined }, { kind: "resize", before: B(1), after: B(2), direction: "vertical", ratio: undefined });
  assert(Math.abs(resize.ratio - (f + slot)) < 1e-9);
  // Every child in the deck: the strip goes; and it goes first when the deck empties.
  assert.deepEqual(plan(withStrip([win("window:home", stacked)], kids.slice(0, 3), true)), { kind: "close-strip" });
  assert.deepEqual(plan(withStrip([win("window:home", { d: "horizontal", a: P, b: S })], [child(5)], true)), { kind: "close-strip" });
  const gone = input([win("window:home", deck3())], kids.slice(0, 3), { strip: S });
  assert.deepEqual(plan(gone), { kind: "forget-strip" }, "a strip Rex no longer has is forgotten, never recreated blindly");
});

test("strip text lists children outside the deck, attention-first, capped with a count", () => {
  const kids = [1, 2, 3, 4, 5, 6, 7].map(n => child(n, { line: `line ${n}\u001b[2J` }));
  assert.equal(stripText(kids.slice(0, 3), new Set([B(1)])), "Not in the deck · 2\nline 2 [2J\nline 3 [2J");
  assert.match(stripText(kids, new Set()), /^Not in the deck · 7\n(line \d \[2J\n){4}\+3 more · ctrl\+shift\+a in the parent$/);
  assert.equal(stripFraction(0, 63), 4 / 63, "a header and pane chrome"); assert.equal(stripFraction(0, 200), 0.06); assert.equal(stripFraction(20, 63), 9 / 63); assert.equal(stripFraction(3, 10), 0.4);
});

test("a full 3×3 grid leaves the rest detached; only an outranking child takes a cell, after the dwell", () => {
  const gridSpec: Spec = { d: "horizontal", r: 1 / 3, a: { d: "vertical", r: 1 / 3, a: R, b: { d: "vertical", a: B(4), b: B(5) } },
    b: { d: "horizontal", a: { d: "vertical", r: 1 / 3, a: B(6), b: { d: "vertical", a: B(7), b: B(8) } }, b: { d: "vertical", r: 1 / 3, a: B(9), b: { d: "vertical", a: B(10), b: B(11) } } } };
  const g = win("window:grid", gridSpec), home = win("window:home", { d: "horizontal", r: 0.55, a: P, b: { d: "vertical", r: 0.2, a: S, b: { d: "vertical", r: 1 / 3, a: B(1), b: { d: "vertical", a: B(2), b: B(3) } } } });
  assert.equal(cells(tree(gridSpec)).length, GRID_CELLS);
  const kids = (p12: number) => [...[1, 2, 3].map(n => child(n, { priority: 3 })), ...[4, 5, 6, 7, 8, 9, 10, 11].map(n => child(n, { priority: n === 6 ? 1 : 2 })), child(12, { priority: p12 })];
  const at = (p12: number, dwell = new Map<string, number>()) => { const i = input([home, g], kids(p12), { grid, strip: S, dwell, size: { columns: 240, rows: 63 } }); i.blocks.push({ block_id: S, placement: "placed" }); return i; };
  const settled = plan(at(1));
  assert(!settled || settled.kind === "resize", `an ordinary overflow child stays detached (got ${JSON.stringify(settled)})`);
  assert.notDeepEqual(plan(at(3, new Map([[B(6), 99_000]]))), { kind: "detach", block: B(6) }, "running waits for the grid child's dwell");
  assert.deepEqual(plan(at(3)), { kind: "detach", block: B(6) }, "running outranks the idle grid child");
  assert.deepEqual(plan(at(4, new Map([[B(6), 99_000]]))), { kind: "detach", block: B(6) }, "attention does not wait");
});

test("roster text strips control sequences and its command exits with the parent", () => {
  assert.equal(rosterText(["a\u001b[2Jb", "c\u0007"]), "a [2Jb\nc ");
  const argv = rosterCommand("/tmp/roster.txt", 1234);
  assert.equal(argv[0], "/bin/sh"); assert.deepEqual(argv.slice(-3), ["rex-roster", "/tmp/roster.txt", "1234"]);
  assert.match(argv[2], /kill -0 "\$2"/);
});

// A small Rex layout simulator: binary split trees with move/resize/swap/detach semantics.
function simulator(slotsRows = 63, ignoreRatio = false) {
  const windows = new Map<string, Spec>([["window:home", P]]), focus = new Map<string, string>([["window:home", P]]);
  const remove = (spec: Spec, block: string): Spec | undefined => {
    if (typeof spec === "string") return spec === block ? undefined : spec;
    const a = remove(spec.a, block), b = remove(spec.b, block);
    return a === undefined ? b : b === undefined ? a : { ...spec, a, b };
  };
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
  const swapIn = (spec: Spec, a: string, b: string): Spec => typeof spec === "string" ? (spec === a ? b : spec === b ? a : spec) : { ...spec, a: swapIn(spec.a, a, b), b: swapIn(spec.b, a, b) };
  const all = new Set<string>([P]);
  const rex: any = {
    calls: [] as string[],
    async probe() {}, async rows() { return { columns: 240, rows: slotsRows }; },
    async snapshot() {
      const view = { active_window_id: "window:home", windows: [...windows].map(([id, spec]) => win(id, spec, focus.get(id))) };
      const placed = new Set(view.windows.flatMap(w => cells(w.layers[0].layout).map(c => c.block)));
      return { view, blocks: [...all].map(block_id => ({ block_id, placement: placed.has(block_id) ? "placed" : "detached" })) };
    },
    async place(_s: string, block: string, anchor: string, d: any, r: number, _signal?: unknown, side = "after") {
      rex.calls.push("place"); detach(block);
      for (const [id, spec] of windows) windows.set(id, replace(spec, anchor, leaf => side === "before" ? { d, r: ignoreRatio ? 0.5 : r, a: block, b: leaf } : { d, r: ignoreRatio ? 0.5 : r, a: leaf, b: block }));
    },
    async create() { rex.calls.push("create"); all.add(S); return S; },
    async resizePane(_s: string, a: string, b: string, d: string, r: number) { rex.calls.push("resize"); for (const spec of windows.values()) resize(spec, a, b, d, r); },
    async swap(_s: string, a: string, b: string) { rex.calls.push("swap"); for (const [id, spec] of windows) windows.set(id, swapIn(spec, a, b)); },
    async detach(_s: string, block: string) { rex.calls.push("detach"); detach(block); },
    async newWindow() { rex.calls.push("window"); windows.set("window:grid", R); focus.set("window:grid", R); all.add(R); return { windowId: "window:grid", blockId: R }; },
    async close(_s: string, block: string) { rex.calls.push("close"); detach(block); all.delete(block); },
  };
  return { rex, windows, all, focus };
}

test("the manager converges 14 children into a 3-slot deck under a strip, a 3×3 grid and 3 detached, then promotes and cleans up", async t => {
  const { DeckManager } = await import("../extensions/rex/layout.ts");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const dir = await mkdtemp("/tmp/rex-deck-"); t.after(() => rm(dir, { recursive: true, force: true }));
  // Like a window the Rex app is showing: move_block ignores ratio; resize_pane does not.
  const sim = simulator(63, true), kids = new Map<number, DeckChild>(), states: any[] = [], pauses: string[] = [];
  const manager = new DeckManager({ rex: sim.rex, session: "session:x", parent: P, cwd: dir, rosterFile: `${dir}/roster.txt`, stripFile: `${dir}/strip.txt`,
    children: () => [...kids.values()], roster: () => ["Rex agents", ...[...kids.values()].map(k => k.name)],
    onState: g => states.push(g), onPause: r => pauses.push(r) });
  for (let n = 1; n <= 14; n++) { kids.set(n, child(n, { priority: 3, line: `line ${n}` })); sim.all.add(B(n)); await manager.run(); }
  assert.deepEqual(pauses, []);
  const home = cells(tree(sim.windows.get("window:home")!)), gridCells = cells(tree(sim.windows.get("window:grid")!));
  assert.equal(home.length, 5, "parent, strip and 3 slots"); assert.equal(gridCells.length, 9, "roster + 8");
  assert.equal(sim.all.size - home.length - gridCells.length, 3, "three children stay detached");
  assert.equal((sim.windows.get("window:home") as any).r, 0.55, "the parent keeps its share");
  const strip = home.find(c => c.block === S)!, slots = home.filter(c => c.block !== P && c.block !== S);
  assert(Math.abs(strip.rect[3] - 9 / 63) < 0.025, `the strip keeps a header, five lines and pane chrome (got ${strip.rect[3]})`);
  assert(slots.every(c => c.rect[1] > strip.rect[1]), "the strip sits on top");
  for (const c of slots) assert(Math.abs(c.rect[3] - (1 - 9 / 63) / 3) < 0.03, "deck rows are even below it");
  assert.deepEqual(columns(gridCells).map(c => c.length), [3, 3, 3]);
  for (const c of gridCells) { assert(Math.abs(c.rect[2] - 1 / 3) < 0.03); assert(Math.abs(c.rect[3] - 1 / 3) < 0.03); }
  assert.match(await readFile(`${dir}/roster.txt`, "utf8"), /^Rex agents\nc1\n/);
  assert.match(await readFile(`${dir}/strip.txt`, "utf8"), /^Not in the deck · 11\nline \d+\n(line \d+\n){3}\+7 more/);
  assert.equal(states.at(-1).strip, S);
  // A detached overflow child needing attention takes a grid cell, then a deck slot.
  const shown = new Set(cells(tree(sim.windows.get("window:home")!)).concat(cells(tree(sim.windows.get("window:grid")!))).map(c => c.block));
  const overflow = [...kids.keys()].find(k => !shown.has(B(k)))!;
  kids.set(overflow, { ...kids.get(overflow)!, priority: 4 }); await manager.run();
  assert.deepEqual(pauses, []);
  assert(cells(tree(sim.windows.get("window:home")!)).some(c => c.block === B(overflow)));
  assert.equal(cells(tree(sim.windows.get("window:grid")!)).length, 9, "the grid stays capped");
  // When every child closes, the strip and the grid's roster close.
  for (const k of [...kids.keys()]) { sim.rex.detach("", B(k)); sim.all.delete(B(k)); kids.delete(k); }
  await manager.run();
  assert(!sim.windows.has("window:grid")); assert.deepEqual(states.at(-1), { grid: undefined, strip: undefined });
  assert.deepEqual(cells(tree(sim.windows.get("window:home")!)).map(c => c.block), [P]);
});

test("a failing or non-converging mutation pauses layout instead of retrying", async t => {
  const { DeckManager } = await import("../extensions/rex/layout.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const dir = await mkdtemp("/tmp/rex-deck-"); t.after(() => rm(dir, { recursive: true, force: true }));
  const sim = simulator(), pauses: string[] = [];
  sim.all.add(B(1));
  sim.rex.place = async () => { sim.rex.calls.push("place"); }; // Rex accepted nothing.
  const manager = new DeckManager({ rex: sim.rex, session: "session:x", parent: P, cwd: dir, rosterFile: `${dir}/roster.txt`, stripFile: `${dir}/strip.txt`,
    children: () => [child(1)], roster: () => [], onState: () => {}, onPause: r => pauses.push(r) });
  await manager.run();
  assert.match(pauses[0], /did not converge/); assert.equal(sim.rex.calls.filter((c: string) => c === "place").length, 1);
  const calls = sim.rex.calls.length;
  manager.schedule(0); await new Promise(r => setTimeout(r, 20)); assert.equal(sim.rex.calls.length, calls, "paused managers stay idle");
  sim.rex.place = async () => { throw new Error("outcome may be unknown"); };
  manager.resume(); await new Promise(r => setTimeout(r, 20)); await manager.run();
  assert.match(pauses[1], /outcome may be unknown/);
});
