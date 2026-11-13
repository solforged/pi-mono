import assert from "node:assert/strict";
import test from "node:test";
import { agentsTabLabel, MARKS, pickMark, tabPlan, type TabState } from "../extensions/rex/tabs.ts";

const P = "block:p", G = "window:grid";
const tab = (id: string, block = `block:${id}`, label = id) =>
  ({ window_id: id, label, layers: [{ kind: "tiled", layout: { block_id: block }, blocks: [{ block_id: block }] }] });
const view = (...windows: any[]) => ({ windows });
const step = (v: any, state: TabState = {}, label?: string) => tabPlan({ view: v, parent: P, grid: G, label, state });

test("the Agents tab moves right after the parent's tab, or last after a last parent", () => {
  assert.deepEqual(step(view(tab("window:home", P), tab("window:a"), tab(G))).op, { kind: "move-window", window: G, before: "window:a" });
  assert.deepEqual(step(view(tab(G), tab("window:a"), tab("window:home", P))).op, { kind: "move-window", window: G });
  assert.equal(step(view(tab("window:a"), tab("window:home", P), tab(G), tab("window:b"))).op, undefined);
  // A floating parent still counts as being in its window.
  const floating = { window_id: "window:home", label: "home", layers: [{ kind: "tiled", layout: { block_id: "block:x" }, blocks: [] }, { kind: "floating", blocks: [{ block_id: P }] }] };
  assert.deepEqual(step(view(floating, tab("window:a"), tab(G))).op, { kind: "move-window", window: G, before: "window:a" });
  assert.equal(step(view(tab("window:a"), tab(G))).op, undefined, "a detached parent has no tab to follow");
});

test("the Agents tab follows a moved parent and new tabs, but not the user's own move", () => {
  const order = ["window:a", "window:home", G, "window:b"];
  // Parent dragged to the end: follow it.
  const moved = step(view(tab("window:a"), tab(G), tab("window:b"), tab("window:home", P)), { order });
  assert.deepEqual(moved, { state: { order }, op: { kind: "move-window", window: G } });
  // A new tab opened between them: snap back next to the parent.
  assert.deepEqual(step(view(tab("window:a"), tab("window:home", P), tab("window:new"), tab(G), tab("window:b")), { order }).op,
    { kind: "move-window", window: G, before: "window:new" });
  // The user dragged the Agents tab elsewhere: it stays there, for good.
  const left = step(view(tab(G), tab("window:a"), tab("window:home", P), tab("window:b")), { order }, "↳ 1 agent · x");
  assert.equal(left.state.unfollowed, true);
  assert.deepEqual(left.op, { kind: "label-window", window: G, label: "↳ 1 agent · x" }, "it is still labelled");
  assert.equal(step(view(tab("window:home", P), tab("window:a"), tab(G)), { unfollowed: true }).op, undefined);
});

test("the label is kept current until the user renames the tab", () => {
  const v = (label: string) => view(tab("window:home", P), tab(G, "block:r", label));
  assert.deepEqual(step(v("↳ 1 agent · x"), { label: "↳ 1 agent · x" }, "↳ 2 agents · x").op, { kind: "label-window", window: G, label: "↳ 2 agents · x" });
  assert.equal(step(v("↳ 2 agents · x"), { label: "↳ 2 agents · x" }, "↳ 2 agents · x").op, undefined);
  const renamed = step(v("mine"), { label: "↳ 1 agent · x" }, "↳ 2 agents · x");
  assert.deepEqual(renamed, { state: { label: "↳ 1 agent · x", renamed: true } });
  assert.equal(step(view(tab("window:home", P)), {}, "y").op, undefined, "a missing grid is the layout's business");
});

test("labels put what needs you first and shorten long parent names", () => {
  assert.equal(agentsTabLabel("fix-login", 1, 0), "↳ 1 agent · fix-login");
  assert.equal(agentsTabLabel("fix-login", 4, 2), "↳ !2 · 4 agents · fix-login");
  assert.equal(agentsTabLabel("Improve Pi and Rex agent tab links\u001b[2J", 3, 0), "↳ 3 agents · Improve Pi and Rex agen…");
});

test("a parent's colour mark avoids marks already in the session, stably per parent", () => {
  assert.equal(agentsTabLabel("fix-login", 4, 1, "🟦"), "↳ 🟦 !1 · 4 agents · fix-login");
  const first = pickMark([], "session-a");
  assert.equal(pickMark([], "session-a"), first, "the same parent gets the same mark");
  assert(MARKS.includes(first));
  const taken = MARKS.filter(m => m !== "🟪").map(m => `${m} birch · scout`);
  assert.equal(pickMark(taken, "session-b"), "🟪", "the only unused mark wins");
  const crowded = [...taken, "↳ 🟪 1 agent · x", "🟦 oak · worker"], picked = pickMark(crowded, "session-b");
  assert.notEqual(picked, "🟦", "otherwise one of the least used");
});
