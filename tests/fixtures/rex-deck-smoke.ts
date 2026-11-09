// Explicit live test: builds a deck, strip and capped grid in two background Rex
// windows with placeholder terminals, then removes everything. No Pi children or
// model calls. 14 children: strip + 3 slots, roster + 8 in a 3×3 grid, 3 detached.
// Run from Rex: node tests/fixtures/rex-deck-smoke.ts [children=8] [--show]
// --show displays the test window in Rex.app (needs Remote Control) for a few
// seconds, where move_block ratios behave differently, then switches back.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { RexClient } from "../../extensions/rex/client.ts";
import { cells, columns, GRID_CELLS, type DeckChild } from "../../extensions/rex/deck.ts";
import { DeckManager } from "../../extensions/rex/layout.ts";

const session = process.env.REX_SESSION, self = process.env.REX_BLOCK;
if (!session || !self) throw new Error("Run this test from a Rex terminal");
const count = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 8), show = process.argv.includes("--show");
const api = (method: string, args: object) => JSON.parse(execFileSync("rex", ["--autostart=false", "api", "call", method, JSON.stringify(args)], { encoding: "utf8" }));
const app = show ? api("client.list", {}).clients.find((c: any) => c.info?.kind === "app")?.client_id : undefined;
const select = (window: string) => api("client.perform", { client_id: app, action: "session.select", args: { session_id: session, window_id: window } });
if (show && !app) throw new Error("--show needs Rex.app connected");
const rex = new RexClient(), dir = await realpath(await mkdtemp("/tmp/rex-deck-smoke-"));
await rex.probe(session, self);
const created: string[] = [], windows: string[] = [];
let original: string | undefined;
const sleeper = ["/bin/sleep", "900"];
const view = async () => (await rex.snapshot(session)).view;
const focusOf = (v: any) => ({ active: v.active_window_id, focused: Object.fromEntries(v.windows.map((w: any) => [w.window_id, w.focused_block_id])) });
try {
  const before = focusOf(await view());
  original = before.active;
  // A stand-in parent pane in its own background window.
  const home = await rex.newWindow(session, "rex deck smoke", "parent", sleeper, dir);
  windows.push(home.windowId); created.push(home.blockId);
  if (show) { select(home.windowId); await new Promise(r => setTimeout(r, 1000)); }
  const kids: DeckChild[] = [];
  for (let n = 1; n <= count; n++) {
    const block = await rex.create(session, `smoke-${n}`, sleeper, dir);
    created.push(block); kids.push({ block, name: `smoke-${n}`, priority: 3, pinned: false, background: false, line: `● smoke-${n}  sleeping` });
  }
  let grid: { window: string; roster: string } | undefined, strip: string | undefined;
  const pauses: string[] = [];
  const manager = new DeckManager({ rex, session, parent: home.blockId, cwd: dir, rosterFile: join(dir, "roster.txt"), stripFile: join(dir, "strip.txt"),
    // Background windows report a default 80×24 until viewed; size the deck from this pane.
    size: signal => rex.rows(session, self, signal), children: () => kids, roster: () => ["Rex deck smoke", ...kids.map(k => `${k.name} ${k.priority}`)],
    onState: s => {
      if (s.grid && s.grid !== grid) { windows.push(s.grid.window); created.push(s.grid.roster); }
      if (s.strip && s.strip !== strip) created.push(s.strip);
      grid = s.grid; strip = s.strip;
    }, onPause: r => pauses.push(r) });
  const started = Date.now();
  await manager.run();
  assert.deepEqual(pauses, []);
  const v = await view(), homeWin = v.windows.find((w: any) => w.window_id === home.windowId);
  const column = cells(homeWin.layers[0].layout).filter(c => c.block !== home.blockId);
  const deck = column.filter(c => c.block !== strip), stripCell = column.find(c => c.block === strip);
  assert(Math.abs(homeWin.layers[0].layout.split.ratio - 0.55) < 0.02, `parent keeps 55% (got ${homeWin.layers[0].layout.split.ratio})`);
  assert(deck.length >= 1 && deck.length <= 3, `deck has ${deck.length}`);
  assert(stripCell, "the strip lists children outside the deck");
  assert(deck.every(c => c.rect[1] > stripCell.rect[1]), "the strip is on top");
  for (const c of deck) assert(Math.abs(c.rect[3] - (1 - stripCell.rect[3]) / deck.length) < 0.05, "deck rows are even");
  assert(grid, "overflow opened a grid window");
  const gridCells = cells(v.windows.find((w: any) => w.window_id === grid!.window).layers[0].layout);
  assert.equal(gridCells.length, Math.min(GRID_CELLS, count - deck.length + 1));
  const detached = count - deck.length - (gridCells.length - 1);
  const cols = columns(gridCells);
  assert(Math.max(...cols.map(c => c.length)) - Math.min(...cols.map(c => c.length)) <= 1, "grid columns are even");
  console.log(`Arranged ${count}: strip ${Math.round(stripCell.rect[3] * 100)}% + deck ${deck.length}, grid ${cols.map(c => c.length).join("+")} (incl. roster), ${detached} detached, in ${Date.now() - started} ms`);
  // The strip pane redraws its file within a second.
  await new Promise(r => setTimeout(r, 1500));
  const stripScreen = execFileSync("rex", ["--autostart=false", "capture", "-s", session, "-b", strip!, "--trim"], { encoding: "utf8" });
  assert.match(stripScreen, new RegExp(`Not in the deck · ${count - deck.length}`)); assert.match(stripScreen, /smoke-\d+ {2}sleeping/);
  // Attention promotes into the deck: from the grid by swapping, or from overflow via a grid cell.
  const shown = new Set([...column, ...gridCells].map(c => c.block));
  const promoted = (detached ? kids.find(k => !shown.has(k.block)) : kids.find(k => gridCells.some(c => c.block === k.block)))!;
  promoted.priority = 4; await manager.run(); assert.deepEqual(pauses, []);
  const after = await view();
  assert(cells(after.windows.find((w: any) => w.window_id === home.windowId).layers[0].layout).some(c => c.block === promoted.block), "promoted into the deck");
  if (!show) {
    assert.deepEqual(focusOf(after).active, before.active, "the active window never changed");
    assert.equal(focusOf(after).focused[before.active], before.focused[before.active], "focus in the user's window never changed");
  }
  // The share holds after Rex.app's delayed relayout and the manager's re-checks.
  await new Promise(r => setTimeout(r, show ? 5000 : 500));
  const settled = (await view()).windows.find((w: any) => w.window_id === home.windowId).layers[0].layout.split.ratio;
  assert(Math.abs(settled - 0.55) < 0.02, `parent keeps 55% after settling (got ${settled})`);
  await manager.stop();
  console.log("Passed: deck slots, strip, capped grid overflow, even sizes, attention promotion; focus preserved. No Pi or model calls.");
} finally {
  if (show && original) { try { select(original); } catch {} }
  for (const block of created.reverse()) await rex.close(session, block).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
