// Deck + grid layout for many Rex children.
//
// The deck is a column of 1–3 live slots beside the parent pane; the grid is a
// background "Rex agents" window holding every other child plus a small roster.
// Planning is pure: each step reads the actual Rex view, proposes at most one
// mutation, and the manager re-reads before the next. User placements (floating,
// other windows) are never touched; focused blocks are never moved; uncertain
// mutations pause automation instead of retrying.

type Obj = Record<string, any>;
type Direction = "horizontal" | "vertical";
export interface DeckChild { block: string; name: string; priority: number; pinned: boolean; background: boolean }
export interface Cell { block: string; rect: number[] }
export type Op =
  | { kind: "place"; block: string; anchor: string; direction: Direction; ratio: number; deck: boolean }
  | { kind: "resize"; before: string; after: string; direction: Direction; ratio: number }
  | { kind: "swap"; into: string; out: string }
  | { kind: "detach"; block: string }
  | { kind: "grid" }
  | { kind: "forget-grid" }
  | { kind: "close-grid" };
export interface PlanInput {
  view: Obj; blocks: Obj[]; parent: string; grid?: { window: string; roster: string };
  children: DeckChild[]; size?: { columns: number; rows: number }; now: number; dwell: Map<string, number>;
  /** Set briefly after the deck is created: hold the parent at this share of the width. */
  share?: number;
}
export const PARENT_SHARE = 0.55, DWELL_MS = 8000, TOLERANCE = 0.02;

/** Every block in a layout tree with its window-relative rect. */
export function cells(node: Obj | undefined): Cell[] {
  if (!node) return [];
  if (typeof node.block_id === "string") return [{ block: node.block_id, rect: node.rect }];
  return node.split ? [...cells(node.split.before), ...cells(node.split.after)] : [];
}
const contains = (node: Obj | undefined, block: string) => cells(node).some(c => c.block === block);
/** The ratio of the innermost `direction` split with `a` before and `b` after (what resize_pane targets). */
export function ratioBetween(node: Obj | undefined, a: string, b: string, direction: Direction): number | undefined {
  const split = node?.split;
  if (!split) return undefined;
  for (const side of [split.before, split.after]) {
    const inner = ratioBetween(side, a, b, direction);
    if (inner !== undefined) return inner;
  }
  return split.direction === direction && contains(split.before, a) && contains(split.after, b) ? split.ratio : undefined;
}
function locate(view: Obj, block: string) {
  for (const window of view.windows ?? []) for (const layer of window.layers ?? [])
    if ((layer.blocks ?? []).some((b: Obj) => b.block_id === block)) return { window, layer };
}
const byPosition = (a: Cell, b: Cell) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0];
export function columns(list: Cell[]): Cell[][] {
  const groups = new Map<number, Cell[]>();
  for (const cell of list) {
    const x = Math.round(cell.rect[0] * 1000);
    groups.set(x, [...(groups.get(x) ?? []), cell]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group.sort(byPosition));
}
/** Live deck slots from the parent window's size: none when too narrow to split. */
export function slotsFor(windowColumns: number, deckRows: number) {
  if (windowColumns < 160) return 0;
  return deckRows >= 60 ? 3 : deckRows >= 40 ? 2 : 1;
}
const columnsFor = (cells: number) => Math.max(1, Math.ceil(Math.sqrt(cells)));

export function classify(input: PlanInput) {
  const { view, blocks, parent, grid } = input;
  const home = locate(view, parent);
  // Moving a window's focused block activates its new window, so moves and detaches
  // skip every window's focus. Swaps only move focus within the active window.
  const focused = new Set<string>((view.windows ?? []).map((w: Obj) => w.focused_block_id).filter(Boolean));
  const activeFocus: string | undefined = (view.windows ?? []).find((w: Obj) => w.window_id === view.active_window_id)?.focused_block_id;
  const deck: Array<DeckChild & Cell> = [], inGrid: Array<DeckChild & Cell> = [], unplaced: DeckChild[] = [];
  const homeCells = home?.layer.kind === "tiled" ? cells(home.layer.layout) : [];
  const gridWindow = grid && (view.windows ?? []).find((w: Obj) => w.window_id === grid.window);
  const gridLayer = gridWindow?.layers?.find((l: Obj) => l.kind === "tiled");
  const gridCells = cells(gridLayer?.layout);
  for (const child of input.children) {
    const placed = blocks.find(b => b.block_id === child.block);
    if (!placed) continue; // Closed or remote: nothing to arrange.
    if (placed.placement === "detached") { if (!child.background) unplaced.push(child); continue; }
    const deckCell = homeCells.find(c => c.block === child.block && c.block !== parent);
    const gridCell = gridCells.find(c => c.block === child.block);
    if (deckCell) deck.push({ ...child, ...deckCell });
    else if (gridCell) inGrid.push({ ...child, ...gridCell });
    // Anything else (floating, another window) is the user's placement.
  }
  deck.sort(byPosition);
  const parentRect = homeCells.find(c => c.block === parent)?.rect;
  return { home, deck, inGrid, unplaced, focused, activeFocus, gridWindow, gridLayer, gridCells, parentRect };
}

export function plan(input: PlanInput): Op | undefined {
  const c = classify(input);
  if (input.grid && !c.gridWindow) return { kind: "forget-grid" };
  if (!c.home || c.home.layer.kind !== "tiled" || !c.parentRect) return undefined; // Parent floating/detached: wait.
  // Slots follow the parent plus deck width, so an existing deck does not shrink itself.
  const size = input.size, share = (c.parentRect[2] + (c.deck[0]?.rect[2] ?? 0)) / Math.max(c.parentRect[2], 0.01);
  const slots = size ? slotsFor(Math.round(size.columns * share), size.rows) : 0;
  const free = (block: string) => !c.focused.has(block);
  const deckPlace = (block: string): Op => c.deck.length
    ? { kind: "place", block, anchor: c.deck.at(-1)!.block, direction: "vertical", ratio: 0.5, deck: true }
    : { kind: "place", block, anchor: input.parent, direction: "horizontal", ratio: PARENT_SHARE, deck: true };

  // 1. Place new or re-adopted children: deck first, then the grid.
  const forGrid = Math.max(0, c.unplaced.length - Math.max(0, slots - c.deck.length));
  for (const child of c.unplaced) {
    if (c.deck.length < slots) return deckPlace(child.block);
    if (!input.grid || !c.gridLayer) return input.grid ? undefined : { kind: "grid" };
    return gridPlace(child.block, c.gridCells, c.gridCells.length + forGrid, c.inGrid.filter(g => free(g.block)).map(g => g.block));
  }
  // 2. A free deck slot takes the most important grid child.
  const candidates = c.inGrid.filter(g => free(g.block)).sort((a, b) => rank(b) - rank(a));
  if (c.deck.length < slots && candidates.length) return deckPlace(candidates[0].block);
  // 3. Promote by swapping when a grid child outranks the weakest deck child.
  const swappable = (block: string) => block !== c.activeFocus;
  const victims = c.deck.filter(d => swappable(d.block) && !d.pinned).sort((a, b) => rank(a) - rank(b) || (input.dwell.get(a.block) ?? 0) - (input.dwell.get(b.block) ?? 0));
  const best = c.inGrid.filter(g => swappable(g.block)).sort((a, b) => rank(b) - rank(a))[0], weakest = victims[0];
  if (best && weakest && rank(best) > rank(weakest)
    && (best.priority >= 4 || best.pinned || input.now - (input.dwell.get(weakest.block) ?? 0) >= DWELL_MS)) return { kind: "swap", into: best.block, out: weakest.block };
  // 4. Keep deck rows and grid rows/columns even.
  const parentLayout = c.home.layer.layout;
  if (input.share && c.deck.length) {
    const have = ratioBetween(parentLayout, input.parent, c.deck[0].block, "horizontal");
    if (have !== undefined && Math.abs(have - input.share) > TOLERANCE) return { kind: "resize", before: input.parent, after: c.deck[0].block, direction: "horizontal", ratio: input.share };
  }
  const deckBalance = balance(parentLayout, c.deck.map(d => d.block), "vertical");
  if (deckBalance) return deckBalance;
  if (c.gridLayer) {
    const cols = columns(c.gridCells);
    const across = balance(c.gridLayer.layout, cols.map(col => col[0].block), "horizontal");
    if (across) return across;
    for (const col of cols) { const down = balance(c.gridLayer.layout, col.map(cell => cell.block), "vertical"); if (down) return down; }
  }
  // 5. An empty grid window goes away; it returns when the deck overflows again.
  if (input.grid && !c.inGrid.length && c.gridCells.every(cell => cell.block === input.grid!.roster)) return { kind: "close-grid" };
  return undefined;
}
const rank = (child: DeckChild) => child.pinned ? 10 + child.priority : child.priority;

function gridPlace(block: string, gridCells: Cell[], target: number, movable: string[]): Op {
  const cols = columns(gridCells), want = columnsFor(target);
  if (cols.length < want) {
    if (cols.every(col => col.length === 1)) return { kind: "place", block, anchor: cols.at(-1)![0].block, direction: "horizontal", ratio: 0.5, deck: false };
    // A full-height column can only be added to a single-row grid: re-lay it out.
    const last = cols.flatMap(col => col.slice(1)).reverse().find(cell => movable.includes(cell.block));
    if (last) return { kind: "detach", block: last.block };
  }
  const shortest = [...cols].sort((a, b) => a.length - b.length)[0];
  return { kind: "place", block, anchor: shortest.at(-1)!.block, direction: "vertical", ratio: 0.5, deck: false };
}
/** Right-nested splits are even when the i-th border gives 1/(n−i) to the cell before it. */
function balance(layout: Obj, ordered: string[], direction: Direction): Op | undefined {
  for (let i = 0; i < ordered.length - 1; i++) {
    const want = 1 / (ordered.length - i), have = ratioBetween(layout, ordered[i], ordered[i + 1], direction);
    if (have !== undefined && Math.abs(have - want) > TOLERANCE) return { kind: "resize", before: ordered[i], after: ordered[i + 1], direction, ratio: want };
  }
}

/** Roster text for the grid's first pane; control characters are stripped. */
export function rosterText(lines: string[]) {
  return lines.map(line => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")).join("\n").slice(0, 16_000);
}
/** argv for the roster pane: redraws on change; exits when the parent process does. */
export function rosterCommand(file: string, parentPid: number): string[] {
  const script = 'printf "\\033[?25l"; old=; while kill -0 "$2" 2>/dev/null; do new=$(cat "$1" 2>/dev/null); '
    + 'if [ "$new" != "$old" ]; then printf "\\033[H\\033[2J%s\\n" "$new"; old=$new; fi; sleep 1; done';
  return ["/bin/sh", "-c", script, "rex-roster", file, String(parentPid)];
}
