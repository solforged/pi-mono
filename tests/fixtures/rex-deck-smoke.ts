// Explicit live test: builds a deck and grid in two background Rex windows with
// placeholder terminals, then removes everything. No Pi children or model calls.
// Run from Rex: node tests/fixtures/rex-deck-smoke.ts [children=8]
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { RexClient } from "../../extensions/rex/client.ts";
import { cells, columns, type DeckChild } from "../../extensions/rex/deck.ts";
import { DeckManager } from "../../extensions/rex/layout.ts";

const session = process.env.REX_SESSION, self = process.env.REX_BLOCK;
if (!session || !self) throw new Error("Run this test from a Rex terminal");
const count = Number(process.argv[2] ?? 8);
const rex = new RexClient(), dir = await realpath(await mkdtemp("/tmp/rex-deck-smoke-"));
await rex.probe(session, self);
const created: string[] = [], windows: string[] = [];
const sleeper = ["/bin/sleep", "900"];
const view = async () => (await rex.snapshot(session)).view;
const focusOf = (v: any) => ({ active: v.active_window_id, focused: Object.fromEntries(v.windows.map((w: any) => [w.window_id, w.focused_block_id])) });
try {
  const before = focusOf(await view());
  // A stand-in parent pane in its own background window.
  const home = await rex.newWindow(session, "rex deck smoke", "parent", sleeper, dir);
  windows.push(home.windowId); created.push(home.blockId);
  const kids: DeckChild[] = [];
  for (let n = 1; n <= count; n++) {
    const block = await rex.create(session, `smoke-${n}`, sleeper, dir);
    created.push(block); kids.push({ block, name: `smoke-${n}`, priority: 3, pinned: false, background: false });
  }
  let grid: { window: string; roster: string } | undefined;
  const pauses: string[] = [];
  const manager = new DeckManager({ rex, session, parent: home.blockId, cwd: dir, rosterFile: join(dir, "roster.txt"),
    // Background windows report a default 80×24 until viewed; size the deck from this pane.
    size: signal => rex.rows(session, self, signal), children: () => kids, roster: () => ["Rex deck smoke", ...kids.map(k => `${k.name} ${k.priority}`)],
    onGrid: g => { grid = g; if (g) { windows.push(g.window); created.push(g.roster); } }, onPause: r => pauses.push(r) });
  const started = Date.now();
  await manager.run();
  assert.deepEqual(pauses, []);
  const v = await view(), homeWin = v.windows.find((w: any) => w.window_id === home.windowId);
  const deck = cells(homeWin.layers[0].layout).filter(c => c.block !== home.blockId);
  assert(deck.length >= 1 && deck.length <= 3, `deck has ${deck.length}`);
  for (const c of deck) assert(Math.abs(c.rect[3] - 1 / deck.length) < 0.05, "deck rows are even");
  assert(grid, "overflow opened a grid window");
  const gridCells = cells(v.windows.find((w: any) => w.window_id === grid!.window).layers[0].layout);
  assert.equal(gridCells.length, count - deck.length + 1);
  const cols = columns(gridCells);
  assert(Math.max(...cols.map(c => c.length)) - Math.min(...cols.map(c => c.length)) <= 1, "grid columns are even");
  console.log(`Arranged ${count}: deck ${deck.length}, grid ${cols.map(c => c.length).join("+")} (incl. roster) in ${Date.now() - started} ms`);
  // Attention promotes a grid child into the deck by swapping.
  const promoted = kids.find(k => gridCells.some(c => c.block === k.block))!;
  promoted.priority = 4; await manager.run(); assert.deepEqual(pauses, []);
  const after = await view();
  assert(cells(after.windows.find((w: any) => w.window_id === home.windowId).layers[0].layout).some(c => c.block === promoted.block), "promoted into the deck");
  assert.deepEqual(focusOf(after).active, before.active, "the active window never changed");
  assert.equal(focusOf(after).focused[before.active], before.focused[before.active], "focus in the user's window never changed");
  await manager.stop();
  console.log("Passed: deck slots, grid overflow, even sizes, attention swap; focus preserved. No Pi or model calls.");
} finally {
  for (const block of created.reverse()) await rex.close(session, block).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
