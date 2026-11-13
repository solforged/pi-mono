// Ties the Agents tab to its parent's tab in Rex's tab bar. Rex has no tab
// groups, so the link is order (the Agents tab sits right after the parent's)
// and a label naming the parent. Like the deck, this never overrides the user:
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

const NAME_MAX = 24;
/** "↳ !1 · 4 agents · fix-login": what needs you first, since narrow tabs truncate the end. */
export function agentsTabLabel(parentName: string, count: number, attention: number) {
  const clean = parentName.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
  const name = [...clean].length > NAME_MAX ? `${[...clean].slice(0, NAME_MAX - 1).join("").trimEnd()}…` : clean;
  return ["↳", [attention ? `!${attention}` : "", `${count} agent${count === 1 ? "" : "s"}`, name].filter(Boolean).join(" · ")].join(" ");
}
