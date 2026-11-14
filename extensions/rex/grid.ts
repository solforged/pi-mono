// Where children go: one Agents tab per parent, holding them in an even grid.
// The parent's own window is never touched, so its other panes (a diff, a
// shell) keep their space. Up to 9 children are tiled; the rest stay detached
// and running until a cell frees, or until one needs you or starts working
// while an idle one holds a cell.
// Planning is pure: each step reads the actual Rex view and proposes at most
// one mutation; the manager re-reads before the next. Panes the user floats or
// moves to another window are left alone, and focused panes are never moved.

type Obj = Record<string, any>;
type Direction = "horizontal" | "vertical";
export interface GridChild { block: string; name: string; priority: number; background: boolean }
export interface Cell { block: string; rect: number[] }
/** The Agents tab. A new window must start with a block, so it starts with a placeholder the first child replaces. */
export interface Grid { window: string; placeholder?: string; unfollowed?: true; renamed?: true }
export type Op =
  | { kind: "place"; block: string; anchor: string; direction: Direction; ratio: number }
  | { kind: "resize"; before: string; after: string; direction: Direction; ratio: number }
  | { kind: "detach"; block: string }
  | { kind: "window" }
  | { kind: "close-placeholder" }
  | { kind: "forget-grid" };
export interface PlanInput { view: Obj; blocks: Obj[]; grid?: Grid; children: GridChild[] }
export const TOLERANCE = 0.02;
/** At most 3×3: smaller cells are not readable TUIs. */
export const GRID_CELLS = 9;
/** Priorities (see ui.ts): needs you 4, working 3. Only these take a cell from an idle child. */
const PROMOTE = 3;

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
const byPosition = (a: Cell, b: Cell) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0];
export function columns(list: Cell[]): Cell[][] {
  const groups = new Map<number, Cell[]>();
  for (const cell of list) {
    const x = Math.round(cell.rect[0] * 1000);
    groups.set(x, [...(groups.get(x) ?? []), cell]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group.sort(byPosition));
}
const columnsFor = (count: number) => Math.max(1, Math.ceil(Math.sqrt(count)));

export function classify(input: PlanInput) {
  const { view, blocks, grid } = input;
  // Moving a window's focused block activates its new window: moves and detaches skip every window's focus.
  const focused = new Set<string>((view.windows ?? []).map((w: Obj) => w.focused_block_id).filter(Boolean));
  const gridWindow = grid && (view.windows ?? []).find((w: Obj) => w.window_id === grid.window);
  const gridLayer = gridWindow?.layers?.find((l: Obj) => l.kind === "tiled");
  const gridCells = cells(gridLayer?.layout);
  const inGrid: Array<GridChild & Cell> = [], unplaced: GridChild[] = [];
  for (const child of input.children) {
    const placed = blocks.find(b => b.block_id === child.block);
    if (!placed) continue; // Closed: nothing to arrange.
    if (placed.placement === "detached") { if (!child.background) unplaced.push(child); continue; }
    const cell = gridCells.find(c => c.block === child.block);
    if (cell) inGrid.push({ ...child, ...cell });
    // Anything else (floating, another window) is the user's placement.
  }
  const childCells = gridCells.filter(c => c.block !== grid?.placeholder);
  return { focused, gridWindow, gridLayer, gridCells, childCells, inGrid, unplaced };
}

export function plan(input: PlanInput): Op | undefined {
  const c = classify(input), grid = input.grid;
  if (grid && !c.gridWindow) return { kind: "forget-grid" };
  // The placeholder goes as soon as a child holds the tab open.
  if (grid?.placeholder && c.childCells.length && c.gridCells.some(cell => cell.block === grid.placeholder)) return { kind: "close-placeholder" };
  const free = (block: string) => !c.focused.has(block);
  // 1. Place detached children, the most important first, while the grid has room.
  const unplaced = [...c.unplaced].sort((a, b) => b.priority - a.priority);
  if (unplaced.length) {
    if (!grid) return { kind: "window" };
    if (!c.gridLayer) return undefined; // The tab is there but not tiled yet: wait.
    if (c.childCells.length < GRID_CELLS) {
      const target = Math.min(GRID_CELLS, c.childCells.length + unplaced.length);
      return gridPlace(unplaced[0].block, c.childCells, grid.placeholder, target, c.inGrid.filter(g => free(g.block)).map(g => g.block));
    }
    // 1b. A full grid: a child that needs you or is working takes an idle child's cell.
    // The idle one is detached (it keeps running); step 1 then places the other.
    const weakest = c.inGrid.filter(g => free(g.block)).sort((a, b) => a.priority - b.priority)[0];
    if (weakest && unplaced[0].priority >= PROMOTE && unplaced[0].priority > weakest.priority) return { kind: "detach", block: weakest.block };
  }
  // 2. Keep columns, and rows within each column, even.
  if (c.gridLayer && c.childCells.length > 1) {
    const cols = columns(c.gridCells);
    const across = balance(c.gridLayer.layout, cols.map(col => col[0].block), "horizontal");
    if (across) return across;
    for (const col of cols) { const down = balance(c.gridLayer.layout, col.map(cell => cell.block), "vertical"); if (down) return down; }
  }
  return undefined;
}

function gridPlace(block: string, childCells: Cell[], placeholder: string | undefined, target: number, movable: string[]): Op {
  if (!childCells.length) return { kind: "place", block, anchor: placeholder!, direction: "horizontal", ratio: 0.5 };
  const cols = columns(childCells), want = columnsFor(target);
  if (cols.length < want) {
    if (cols.every(col => col.length === 1)) return { kind: "place", block, anchor: cols.at(-1)![0].block, direction: "horizontal", ratio: 0.5 };
    // A full-height column can only be added to a single-row grid: re-lay it out.
    const last = cols.flatMap(col => col.slice(1)).reverse().find(cell => movable.includes(cell.block));
    if (last) return { kind: "detach", block: last.block };
  }
  const shortest = [...cols].sort((a, b) => a.length - b.length)[0];
  return { kind: "place", block, anchor: shortest.at(-1)!.block, direction: "vertical", ratio: 0.5 };
}
/** Right-nested splits are even when the i-th border gives 1/(n−i) to the cell before it. */
function balance(layout: Obj, ordered: string[], direction: Direction): Op | undefined {
  for (let i = 0; i < ordered.length - 1; i++) {
    const want = 1 / (ordered.length - i), have = ratioBetween(layout, ordered[i], ordered[i + 1], direction);
    if (have !== undefined && Math.abs(have - want) > TOLERANCE) return { kind: "resize", before: ordered[i], after: ordered[i + 1], direction, ratio: want };
  }
}
/** The placeholder's argv: it exits on its own if the manager never gets to close it. */
export const PLACEHOLDER = ["/bin/sleep", "120"];
