// Deck + grid layout for many Rex children.
//
// The deck is a column of 1–3 live slots beside the parent pane; the grid is a
// background "Rex agents" window holding up to 8 more children plus a small roster.
// Children beyond that stay detached and running. A short "strip" pane atop the
// deck lists every child not in the deck, so nothing is out of sight.
// Planning is pure: each step reads the actual Rex view, proposes at most one
// mutation, and the manager re-reads before the next. User placements (floating,
// other windows) are never touched; focused blocks are never moved; uncertain
// mutations pause automation instead of retrying.

type Obj = Record<string, any>;
type Direction = "horizontal" | "vertical";
export interface DeckChild { block: string; name: string; priority: number; pinned: boolean; background: boolean; /** Strip/roster text. */ line?: string }
export interface Cell { block: string; rect: number[] }
export type Op =
  | { kind: "place"; block: string; anchor: string; direction: Direction; ratio: number; deck: boolean; side?: "before" }
  | { kind: "resize"; before: string; after: string; direction: Direction; ratio: number }
  | { kind: "swap"; into: string; out: string }
  | { kind: "detach"; block: string }
  | { kind: "grid" }
  | { kind: "forget-grid" }
  | { kind: "close-grid" }
  | { kind: "strip" }
  | { kind: "forget-strip" }
  | { kind: "close-strip" };
export interface PlanInput {
  view: Obj; blocks: Obj[]; parent: string; grid?: { window: string; roster: string }; strip?: string;
  children: DeckChild[]; size?: { columns: number; rows: number }; now: number; dwell: Map<string, number>;
  /** Set briefly after the deck is created: hold the parent at this share of the width. */
  share?: number;
}
export const PARENT_SHARE = 0.55, DWELL_MS = 8000, TOLERANCE = 0.02;
/** The grid tops out at 3×3 (roster + 8): smaller cells are not readable TUIs. */
export const GRID_CELLS = 9, STRIP_LINES = 5;

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
  const deckBlocks = new Set(deck.map(d => d.block));
  const offscreen = input.children.filter(ch => !deckBlocks.has(ch.block) && blocks.some(b => b.block_id === ch.block));
  const stripPlaced = !!input.strip && homeCells.some(cell => cell.block === input.strip);
  const stripDetached = !!input.strip && blocks.find(b => b.block_id === input.strip)?.placement === "detached";
  return { home, deck, inGrid, unplaced, focused, activeFocus, gridWindow, gridLayer, gridCells, parentRect, offscreen, stripPlaced, stripDetached };
}
/** The strip's share of the deck column: a header, one line per child (capped), and Rex's title row. */
export function stripFraction(offscreen: number, rows: number) {
  return Math.min(0.4, Math.max(0.06, (Math.min(offscreen, STRIP_LINES) + 2) / Math.max(rows, 1)));
}
/** Strip text: children not in the deck, attention-first as given, capped with a count. */
export function stripText(children: DeckChild[], onDeck: Set<string>) {
  const off = children.filter(ch => !onDeck.has(ch.block));
  const shown = off.length > STRIP_LINES ? off.slice(0, STRIP_LINES - 1) : off;
  return rosterText([`Not in the deck · ${off.length}`, ...shown.map(ch => ch.line ?? ch.name),
    ...(off.length > shown.length ? [`+${off.length - shown.length} more · ctrl+shift+a in the parent`] : [])]);
}

export function plan(input: PlanInput): Op | undefined {
  const c = classify(input);
  if (input.grid && !c.gridWindow) return { kind: "forget-grid" };
  if (input.strip && !input.blocks.some(b => b.block_id === input.strip)) return { kind: "forget-strip" };
  // A strip without a deck would anchor the next deck beside it: close it first.
  if (input.strip && !c.deck.length && (c.stripPlaced || c.stripDetached)) return { kind: "close-strip" };
  if (!c.home || c.home.layer.kind !== "tiled" || !c.parentRect) return undefined; // Parent floating/detached: wait.
  // Slots follow the parent plus deck width, so an existing deck does not shrink itself.
  const size = input.size, share = (c.parentRect[2] + (c.deck[0]?.rect[2] ?? 0)) / Math.max(c.parentRect[2], 0.01);
  const slots = size ? slotsFor(Math.round(size.columns * share), size.rows) : 0;
  const free = (block: string) => !c.focused.has(block);
  const deckPlace = (block: string): Op => c.deck.length
    ? { kind: "place", block, anchor: c.deck.at(-1)!.block, direction: "vertical", ratio: 0.5, deck: true }
    : { kind: "place", block, anchor: input.parent, direction: "horizontal", ratio: PARENT_SHARE, deck: true };

  // 1. Place new or re-adopted children, most important first: deck, then the
  // grid while it has room. The rest stay detached (still running, listed in the strip).
  const unplaced = [...c.unplaced].sort((a, b) => rank(b) - rank(a));
  const forGrid = Math.max(0, unplaced.length - Math.max(0, slots - c.deck.length));
  for (const child of unplaced) {
    if (c.deck.length < slots) return deckPlace(child.block);
    if (!input.grid || !c.gridLayer) return input.grid ? undefined : { kind: "grid" };
    if (c.gridCells.length >= GRID_CELLS) break;
    return gridPlace(child.block, c.gridCells, Math.min(GRID_CELLS, c.gridCells.length + forGrid), c.inGrid.filter(g => free(g.block)).map(g => g.block));
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
  // 3b. With a full grid, an overflow child that outranks the weakest grid child
  // takes its cell: detach that one (it keeps running); step 1 then places the other.
  if (unplaced.length && c.gridCells.length >= GRID_CELLS) {
    const overflow = unplaced[0], gridWeakest = c.inGrid.filter(g => free(g.block) && !g.pinned)
      .sort((a, b) => rank(a) - rank(b) || (input.dwell.get(a.block) ?? 0) - (input.dwell.get(b.block) ?? 0))[0];
    if (gridWeakest && rank(overflow) > rank(gridWeakest)
      && (overflow.priority >= 4 || overflow.pinned || input.now - (input.dwell.get(gridWeakest.block) ?? 0) >= DWELL_MS)) return { kind: "detach", block: gridWeakest.block };
  }
  // 4. The strip sits atop the deck while any child is out of the deck.
  const wantStrip = c.deck.length > 0 && c.offscreen.length > 0 && !!size;
  const fraction = size ? stripFraction(c.offscreen.length, size.rows) : 0;
  if (wantStrip && !input.strip) return { kind: "strip" };
  if (wantStrip && c.stripDetached) return { kind: "place", block: input.strip!, anchor: c.deck[0].block, direction: "vertical", ratio: 0.25, deck: false, side: "before" };
  if (!wantStrip && (c.stripPlaced || c.stripDetached)) return { kind: "close-strip" };
  // 5. Keep deck rows and grid rows/columns even; the strip keeps its few rows.
  const parentLayout = c.home.layer.layout;
  if (input.share && c.deck.length) {
    const have = ratioBetween(parentLayout, input.parent, c.deck[0].block, "horizontal");
    if (have !== undefined && Math.abs(have - input.share) > TOLERANCE) return { kind: "resize", before: input.parent, after: c.deck[0].block, direction: "horizontal", ratio: input.share };
  }
  const weights = new Map<string, number>(c.deck.map(d => [d.block, 1]));
  if (c.stripPlaced && c.deck.length) weights.set(input.strip!, fraction * c.deck.length / (1 - fraction));
  const deckBalance = balanceTree(parentLayout, weights, "vertical");
  if (deckBalance) return deckBalance;
  if (c.gridLayer) {
    const cols = columns(c.gridCells);
    const across = balance(c.gridLayer.layout, cols.map(col => col[0].block), "horizontal");
    if (across) return across;
    for (const col of cols) { const down = balance(c.gridLayer.layout, col.map(cell => cell.block), "vertical"); if (down) return down; }
  }
  // 6. An empty grid window goes away; it returns when the deck overflows again.
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
/** Each split between weighted blocks gives its before side its share of the weight, whatever the nesting. */
function balanceTree(node: Obj | undefined, weights: Map<string, number>, direction: Direction): Op | undefined {
  const split = node?.split;
  if (!split) return undefined;
  const before = cells(split.before), after = cells(split.after);
  if (split.direction === direction && before.length && after.length && [...before, ...after].every(cell => weights.has(cell.block))) {
    const weigh = (list: Cell[]) => list.reduce((sum, cell) => sum + weights.get(cell.block)!, 0);
    const want = weigh(before) / (weigh(before) + weigh(after));
    // resize_pane picks the innermost split with these two on opposite sides: this one.
    if (Math.abs(split.ratio - want) > TOLERANCE) return { kind: "resize", before: before.at(-1)!.block, after: after[0].block, direction, ratio: want };
  }
  return balanceTree(split.before, weights, direction) ?? balanceTree(split.after, weights, direction);
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
