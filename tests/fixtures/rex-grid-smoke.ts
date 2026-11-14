// Explicit live test: fills an Agents tab with placeholder terminals beside a
// stand-in parent window that already has a second pane (as a diff would),
// then removes everything. No Pi children or model calls. 12 children: a 3×3
// grid and 3 detached.
// Run from Rex: node tests/fixtures/rex-grid-smoke.ts [children=6] [--show]
// --show displays the Agents tab in Rex.app (needs Remote Control) for a few
// seconds, where move_block ratios behave differently, then switches back.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { RexClient } from "../../extensions/rex/client.ts";
import { cells, columns, GRID_CELLS, type GridChild } from "../../extensions/rex/grid.ts";
import { GridManager } from "../../extensions/rex/layout.ts";

const session = process.env.REX_SESSION, self = process.env.REX_BLOCK;
if (!session || !self) throw new Error("Run this test from a Rex terminal");
const count = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 6), show = process.argv.includes("--show");
const api = (method: string, args: object) => JSON.parse(execFileSync("rex", ["--autostart=false", "api", "call", method, JSON.stringify(args)], { encoding: "utf8" }));
const app = show ? api("client.list", {}).clients.find((c: any) => c.info?.kind === "app")?.client_id : undefined;
const select = (window: string) => api("client.perform", { client_id: app, action: "session.select", args: { session_id: session, window_id: window } });
if (show && !app) throw new Error("--show needs Rex.app connected");
const rex = new RexClient(), dir = await realpath(await mkdtemp("/tmp/rex-grid-smoke-"));
await rex.probe(session, self);
const created: string[] = [];
let original: string | undefined;
const sleeper = ["/bin/sleep", "900"];
const view = async () => (await rex.snapshot(session)).view;
const focusOf = (v: any) => ({ active: v.active_window_id, focused: Object.fromEntries(v.windows.map((w: any) => [w.window_id, w.focused_block_id])) });
try {
  const before = focusOf(await view());
  original = before.active;
  // A stand-in parent with a second pane beside it, in its own background window.
  const home = await rex.newWindow(session, "rex grid smoke", "parent", sleeper, dir);
  created.push(home.blockId);
  const side = await rex.create(session, "side pane", sleeper, dir);
  created.push(side); await rex.place(session, side, home.blockId, "horizontal", 0.67);
  // Another tab after the parent's: the Agents tab must land between them.
  const spacer = await rex.newWindow(session, "rex grid smoke spacer", "spacer", sleeper, dir);
  created.push(spacer.blockId);
  const parentLayout = JSON.stringify(cells((await view()).windows.find((w: any) => w.window_id === home.windowId).layers[0].layout).map(c => c.block));
  const kids: GridChild[] = [];
  for (let n = 1; n <= count; n++) {
    const block = await rex.create(session, `smoke-${n}`, sleeper, dir);
    created.push(block); kids.push({ block, name: `smoke-${n}`, priority: 3, background: false });
  }
  let grid: string | undefined;
  const pauses: string[] = [];
  const manager = new GridManager({ rex, session, parent: home.blockId, cwd: dir, children: () => kids, tabLabel: () => `Agents · ${kids.length}`,
    onState: s => { grid = s.grid?.window; }, onPause: r => pauses.push(r) });
  const started = Date.now();
  await manager.run();
  assert.deepEqual(pauses, []);
  assert(grid, "the first child opened an Agents tab");
  if (show) { select(grid); await new Promise(r => setTimeout(r, 1500)); await manager.run(); }
  const v = await view(), gridWindow = v.windows.find((w: any) => w.window_id === grid);
  assert.equal(JSON.stringify(cells(v.windows.find((w: any) => w.window_id === home.windowId).layers[0].layout).map(c => c.block)), parentLayout,
    "the parent's window and its side pane are untouched");
  const gridCells = cells(gridWindow.layers[0].layout);
  assert.equal(gridCells.length, Math.min(GRID_CELLS, count));
  assert(gridCells.every(c => kids.some(k => k.block === c.block)), "only children: the placeholder is gone");
  const cols = columns(gridCells);
  assert(Math.max(...cols.map(c => c.length)) - Math.min(...cols.map(c => c.length)) <= 1, "grid columns are even");
  for (const c of gridCells) assert(Math.abs(c.rect[2] - 1 / cols.length) < 0.03, "column widths are even");
  const order = v.windows.map((w: any) => w.window_id);
  assert.equal(order[order.indexOf(home.windowId) + 1], grid, "the Agents tab follows the parent's");
  assert.equal(order[order.indexOf(grid) + 1], spacer.windowId, "and precedes the tab that was there");
  assert.equal(gridWindow.label, `Agents · ${count}`);
  const detached = count - gridCells.length;
  console.log(`Arranged ${count}: grid ${cols.map(c => c.length).join("+")}, ${detached} detached, in ${Date.now() - started} ms`);
  if (!show) assert.deepEqual(focusOf(v).active, before.active, "the active window never changed");
  // A detached child that needs you takes an idle child's cell.
  if (detached) {
    const shown = new Set(gridCells.map(c => c.block));
    // Not the tab's focused pane: focused panes are never moved.
    const waiting = kids.find(k => !shown.has(k.block))!, idle = kids.find(k => shown.has(k.block) && k.block !== gridWindow.focused_block_id)!;
    idle.priority = 1; waiting.priority = 4;
    await manager.run(); assert.deepEqual(pauses, []);
    const after = cells((await view()).windows.find((w: any) => w.window_id === grid).layers[0].layout).map(c => c.block);
    assert(after.includes(waiting.block) && !after.includes(idle.block), "the child that needs you took the idle one's cell");
  }
  // Every child closes: Rex closes the tab with its last block.
  for (const kid of kids.splice(0)) { await rex.close(session, kid.block); created.splice(created.indexOf(kid.block), 1); }
  await manager.run();
  assert(!(await view()).windows.some((w: any) => w.window_id === grid), "the Agents tab closed with its last child");
  if (!show) assert.deepEqual(focusOf(await view()).active, before.active, "the active window never changed");
  console.log("Passed: one Agents tab beside an untouched parent window, placeholder replaced, even grid capped at 3×3, need-you promotion, tab order and label, tab closed with its children; focus preserved. No Pi or model calls.");
} finally {
  if (show && original) { try { select(original); } catch {} }
  for (const block of created.reverse()) await rex.close(session, block).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
