// Ties the Agents tab to its parent's tab in Rex's tab bar. Rex has no tab
// groups, so the link is order (the Agents tab sits right after the parent's)
// and a compact child count. Like the deck, this never overrides the user:
// once they move or rename the Agents tab, that aspect is left alone.

type Obj = Record<string, any>;
export type TabOp =
  | { kind: "move-window"; window: string; before?: string }
  | { kind: "label-window"; window: string; label: string };
export interface TabState {
  /** The window order last seen settled; detects the user moving the Agents tab. */
  order?: string[];
  /** The label last applied; a different label means the user renamed the tab. */
  label?: string;
  unfollowed?: boolean;
  renamed?: boolean;
}

export const windowOrder = (view: Obj): string[] => (view.windows ?? []).map((w: Obj) => w.window_id).filter((id: unknown) => typeof id === "string");

function windowOf(view: Obj, block: string): string | undefined {
  const holds = (node: Obj | undefined): boolean => !!node && (node.block_id === block || holds(node.split?.before) || holds(node.split?.after));
  return (view.windows ?? []).find((w: Obj) => (w.layers ?? []).some((l: Obj) => holds(l.layout) || (l.blocks ?? []).some((b: Obj) => b.block_id === block)))?.window_id;
}

/** Windows (other than the parent's) before the Agents tab, among those present in both orders. */
function precedingOthers(order: string[], grid: string, parent: string, shared: Set<string>) {
  return order.slice(0, Math.max(0, order.indexOf(grid))).filter(id => id !== parent && shared.has(id)).join(" ");
}

/** One step toward the Agents tab sitting after the parent's tab with the wanted label. */
export function tabPlan(input: { view: Obj; parent: string; grid: string; label?: string; state: TabState }): { state: TabState; op?: TabOp } {
  const { view, parent, grid } = input, order = windowOrder(view);
  let state = input.state;
  const gridAt = order.indexOf(grid);
  if (gridAt < 0) return { state };
  const parentWindow = windowOf(view, parent);
  // The user moved the Agents tab if the tabs before it changed, beyond the parent
  // leaving or arriving; new tabs are ignored. A moved parent is followed.
  if (!state.unfollowed && parentWindow && state.order?.includes(grid)) {
    const shared = new Set(order.filter(id => state.order!.includes(id)));
    if (precedingOthers(state.order, grid, parentWindow, shared) !== precedingOthers(order, grid, parentWindow, shared)) state = { ...state, unfollowed: true };
  }
  const current = view.windows.find((w: Obj) => w.window_id === grid)?.label;
  if (!state.renamed && state.label !== undefined && current !== state.label) state = { ...state, renamed: true };
  if (!state.unfollowed && parentWindow && parentWindow !== grid && order[order.indexOf(parentWindow) + 1] !== grid) {
    const before = order[order.indexOf(parentWindow) + 1];
    return { state, op: { kind: "move-window", window: grid, ...(before ? { before } : {}) } };
  }
  if (!state.renamed && input.label && current !== input.label) return { state, op: { kind: "label-window", window: grid, label: input.label } };
  return { state };
}

/** Adjacency carries the parent link; the tab needs only the count and attention. */
export function agentsTabLabel(count: number, attention: number) {
  return `Agents · ${count}${attention ? ` · !${attention}` : ""}`;
}

/** Tab bars take no colours from programs, but they draw colour emoji. Squares, not
 * circles, so they don't read as the ●/✓ status glyphs. */
export const MARKS = ["🟦", "🟩", "🟧", "🟪", "🟥", "🟨", "🟫"];
/** A parent's colour: the least used among marks already in the session's labels,
 * starting from a stable place per parent so ties don't all pick the first. */
export function pickMark(labels: string[], seed: string): string {
  const uses = MARKS.map(mark => labels.filter(label => label.includes(mark)).length);
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  const order = MARKS.map((_, i) => (hash + i) % MARKS.length);
  return MARKS[order.reduce((best, i) => (uses[i] < uses[best] ? i : best), order[0])];
}
