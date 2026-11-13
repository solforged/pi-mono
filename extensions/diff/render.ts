// Lays out the diff pane as styled rows. Pure: the viewer owns terminal I/O.
import type { DiffLine, FileDiff, Hunk, Snapshot } from "./git.ts";
import type { Highlighter, Piece, Token } from "./syntax.ts";
import { clipSpans, luminance, mix, sanitize, truncate, truncateStart, width, wrapSpans, type Row, type Span, type Style } from "./text.ts";

export interface Palette {
  text: string; muted: string; dim: string; accent: string; border: string;
  added: string; removed: string; context: string; selectedBg: string;
  success: string; warning: string; error: string;
  /** Terminal background, reported by the terminal or guessed. */
  bg: string;
  /** Pi's syntax colors; tokens without one use the line's text color. */
  syntax?: Partial<Record<Token, string>>;
  /** Pi's Markdown colors, for the document pane. */
  md?: Partial<Record<"heading" | "link" | "code" | "quote" | "quoteBorder" | "hr" | "bullet", string>>;
}

export const DEFAULT_PALETTE: Palette = {
  text: "#d4d4d4", muted: "#9aa0a6", dim: "#7f848e", accent: "#b392f0", border: "#5c6370",
  added: "#73c991", removed: "#f14c4c", context: "#9aa0a6", selectedBg: "#2c313a",
  success: "#73c991", warning: "#cca700", error: "#f14c4c", bg: "#1e1e1e",
  syntax: {
    comment: "#7f848e", keyword: "#569cd6", function: "#dcdcaa", variable: "#9cdcfe", string: "#ce9178",
    number: "#b5cea8", type: "#4ec9b0", operator: "#9aa0a6", punctuation: "#9aa0a6",
  },
};

export interface View {
  snapshot?: Snapshot;
  error?: string;
  loading: boolean;
  selected: number;
  scroll: number;
  wrap: boolean;
  follow: boolean;
  help: boolean;
  columns: number;
  rows: number;
  palette: Palette;
  highlighter?: Highlighter;
  /** What the mouse pointer is over. */
  hover?: Target;
}

/** Something on screen that reacts to the mouse. */
export type Target = { area: "file"; index: number } | { area: "source" } | { area: "key"; key: string } | { area: "scrollbar" };

/** Screen areas the viewer needs for mouse input and scrolling. */
export interface Layout {
  rows: Row[];
  list: { top: number; height: number; first: number };
  body: { top: number; height: number; total: number };
  source: { row: number; from: number };
  /** Clickable keys in the bottom bar, by column range [from, to). */
  keys?: { row: number; items: Array<{ from: number; to: number; key: string }> };
  scrollbar?: { column: number; top: number; height: number };
}

export const sameTarget = (a?: Target, b?: Target) => JSON.stringify(a) === JSON.stringify(b);

/** The farthest the body scrolls: its last rows can rise to near the top. */
export const maxScroll = (total: number, height: number) => Math.max(0, total - Math.max(1, height - 2));

/** Diff rows for a file as the pane shows them, one column narrower for the scrollbar. */
export function fileBody(file: FileDiff, view: View): Body {
  return body(file, Math.max(1, view.columns - 1), view.wrap, view.palette, view.highlighter);
}

/**
 * Which hunk is current, 1-based: the one at the top of the body, or once
 * scrolled to the end, the last one in view.
 */
export function hunkAt(starts: number[], scroll: number, total: number, height: number): number {
  const line = scroll >= maxScroll(total, height) ? scroll + height - 1 : scroll + 1;
  return Math.max(1, starts.filter((start) => start <= line).length);
}

export interface Body { rows: Row[]; hunks: number[] }

interface Tones {
  addBg: string; addEmph: string; delBg: string; delEmph: string;
}

function tones(p: Palette): Tones {
  const dark = luminance(p.bg) < 0.4;
  return {
    addBg: mix(p.added, p.bg, dark ? 0.16 : 0.18), addEmph: mix(p.added, p.bg, dark ? 0.36 : 0.4),
    delBg: mix(p.removed, p.bg, dark ? 0.16 : 0.15), delEmph: mix(p.removed, p.bg, dark ? 0.36 : 0.35),
  };
}

const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/** Marks the tokens that differ between a removed and an added line; undefined when the lines barely match. */
export function emphasis(before: string, after: string): [boolean[], boolean[], string[], string[]] | undefined {
  const a = before.match(TOKEN) ?? [], b = after.match(TOKEN) ?? [];
  if (!a.length || !b.length || a.length * b.length > 40_000) return undefined;
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const changedA = a.map(() => true), changedB = b.map(() => true);
  let i = 0, j = 0, same = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { changedA[i] = changedB[j] = false; if (a[i].trim()) same += a[i].length; i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  const solid = (tokens: string[]) => tokens.reduce((sum, token) => sum + token.trim().length, 0);
  if (same / Math.max(1, solid(a), solid(b)) < 0.4) return undefined;
  if (!changedA.includes(true) && !changedB.includes(true)) return undefined;
  return [changedA, changedB, a, b];
}

/** Changed characters per line index, for paired runs of removals followed by additions. */
function pairs(hunk: Hunk, texts: string[]): Map<number, boolean[]> {
  const out = new Map<number, boolean[]>();
  const lines = hunk.lines;
  const mask = (tokens: string[], changed: boolean[]) => tokens.flatMap((token, n) => Array<boolean>(token.length).fill(changed[n]));
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind !== "-") { i++; continue; }
    const delStart = i;
    while (i < lines.length && lines[i].kind === "-") i++;
    const addStart = i;
    while (i < lines.length && lines[i].kind === "+") i++;
    const count = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < count; k++) {
      const result = emphasis(texts[delStart + k], texts[addStart + k]);
      if (!result) continue;
      const [changedA, changedB, a, b] = result;
      out.set(delStart + k, mask(a, changedA));
      out.set(addStart + k, mask(b, changedB));
    }
  }
  return out;
}

/** Syntax pieces per line: removed lines from the old side, the rest from the new side. */
function syntax(file: FileDiff, highlighter: Highlighter | undefined, skipRemoved: boolean): Map<DiffLine, Piece[]> | undefined {
  const language = highlighter?.language(file.path);
  if (!highlighter || !language) return undefined;
  const out = new Map<DiffLine, Piece[]>();
  for (const side of ["-", "+"] as const) {
    const lines = file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind !== (side === "-" ? "+" : "-")));
    if (side === "-" && (skipRemoved || !lines.some((line) => line.kind === "-"))) continue;
    const pieces = highlighter.highlight(lines.map((line) => sanitize(line.text)), language);
    lines.forEach((line, i) => { if (side === "+" || line.kind === "-") out.set(line, pieces[i]); });
  }
  return out;
}

const bodies = new WeakMap<FileDiff, Map<string, Body>>();

/** Diff rows for one file, cached per width, wrap mode, colors and highlighter. */
export function body(file: FileDiff, columns: number, wrap: boolean, palette: Palette, highlighter?: Highlighter): Body {
  const key = `${columns}:${wrap}:${highlighter ? 1 : 0}:${JSON.stringify(palette)}`;
  let cache = bodies.get(file);
  const hit = cache?.get(key);
  if (hit) return hit;
  const t = tones(palette);
  // A loop, not a spread: an added file is one hunk, and a call cannot take a hundred thousand arguments.
  let max = 0;
  for (const hunk of file.hunks) for (const line of hunk.lines) max = Math.max(max, line.old ?? 0, line.new ?? 0);
  const digits = Math.max(3, String(max).length);
  const gutter = digits + 3;
  const textWidth = Math.max(8, columns - gutter);
  // A file that is entirely new or deleted reads better without a tinted wash.
  const kinds = new Set(file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.kind)));
  const plain = kinds.size === 1;
  const kind = {
    " ": { num: { fg: palette.dim }, sign: { fg: palette.dim }, text: palette.context, bg: undefined, emph: undefined },
    "+": plain
      ? { num: { fg: palette.added }, sign: { fg: palette.added, bold: true }, text: palette.text, bg: undefined, emph: undefined }
      : { num: { fg: palette.added, bg: t.addBg }, sign: { fg: palette.added, bg: t.addBg, bold: true }, text: palette.text, bg: t.addBg, emph: t.addEmph },
    "-": plain
      ? { num: { fg: palette.removed }, sign: { fg: palette.removed, bold: true }, text: palette.muted, bg: undefined, emph: undefined }
      : { num: { fg: palette.removed, bg: t.delBg }, sign: { fg: palette.removed, bg: t.delBg, bold: true }, text: palette.text, bg: t.delBg, emph: t.delEmph },
  };
  // Styles are shared objects so wrapping can merge adjacent runs.
  const interned = new Map<string, Style>();
  const style = (fg: string, bg: string | undefined): Style => {
    const id = `${fg}/${bg}`;
    let value = interned.get(id);
    if (!value) interned.set(id, value = bg ? { fg, bg } : { fg });
    return value;
  };
  const colors = syntax(file, highlighter, plain && kinds.has("-"));
  /** Syntax color for a token; unchanged context lines are toned down toward the background. */
  const tokenColor = (token: Token | undefined, line: DiffLine) => {
    const color = token ? palette.syntax?.[token] : undefined;
    if (!color) return kind[line.kind].text;
    return line.kind === " " ? mix(color, palette.bg, 0.72) : color;
  };

  const rows: Row[] = [];
  const hunks: number[] = [];
  file.hunks.forEach((hunk, index) => {
    hunks.push(rows.length);
    const first = hunk.lines[0];
    if (index > 0 || (first && (first.old ?? first.new ?? 1) > 1) || hunk.context) {
      const label = hunk.context ? sanitize(hunk.context) : "";
      rows.push({ spans: [
        { text: `${"⋯".padStart(digits)}   `, style: { fg: palette.dim } },
        { text: label ? truncate(label, textWidth) : "", style: { fg: palette.dim, italic: true } },
      ] });
    }
    const texts = hunk.lines.map((line) => sanitize(line.text));
    const emphasized = pairs(hunk, texts);
    hunk.lines.forEach((line: DiffLine, n) => {
      const look = kind[line.kind];
      const number = String((line.kind === "-" ? line.old : line.new) ?? "").padStart(digits);
      const pieces = colors?.get(line) ?? [{ text: texts[n] }];
      const changed = emphasized.get(n);
      // Split syntax pieces wherever word emphasis starts or stops.
      const content: Span[] = [];
      let offset = 0;
      for (const piece of pieces) {
        const fg = tokenColor(piece.token, line);
        for (let start = 0; start < piece.text.length;) {
          const emph = changed?.[offset + start] ?? false;
          let end = start + 1;
          while (end < piece.text.length && (changed?.[offset + end] ?? false) === emph) end++;
          content.push({ text: piece.text.slice(start, end), style: style(fg, emph && look.emph ? look.emph : look.bg) });
          start = end;
        }
        offset += piece.text.length;
      }
      const lines = wrap ? wrapSpans(content, textWidth) : [content];
      lines.forEach((spans, k) => rows.push({
        spans: [
          { text: k ? " ".repeat(digits) : number, style: look.num },
          { text: k ? "   " : ` ${line.kind === " " ? " " : line.kind} `, style: look.sign },
          ...spans,
        ],
        fill: look.bg,
      }));
    });
  });
  const result = { rows, hunks };
  if (!cache) bodies.set(file, cache = new Map());
  cache.set(key, result);
  return result;
}

const STATUS: Record<FileDiff["status"], [string, keyof Palette]> = {
  modified: ["M", "warning"], added: ["A", "success"], untracked: ["U", "success"],
  deleted: ["D", "error"], renamed: ["R", "accent"], copied: ["C", "accent"],
};

function counts(file: { added: number; removed: number }, p: Palette, bg?: string): Span[] {
  const spans: Span[] = [];
  if (file.added) spans.push({ text: `+${file.added}`, style: { fg: p.added, bg } });
  if (file.added && file.removed) spans.push({ text: " ", style: { bg } });
  if (file.removed) spans.push({ text: `−${file.removed}`, style: { fg: p.removed, bg } });
  return spans;
}

const spanWidth = (spans: Span[]) => spans.reduce((sum, span) => sum + width(span.text), 0);

/** Left spans, then right spans flush with the edge, cutting the left side first. */
function split(left: Span[], right: Span[], columns: number, fill?: string): Row {
  const room = columns - spanWidth(right) - 1;
  const kept: Span[] = [];
  let used = 0;
  for (const span of left) {
    if (used >= room) break;
    const text = truncate(span.text, room - used);
    kept.push({ text, style: span.style });
    used += width(text);
  }
  const gap = Math.max(1, columns - used - spanWidth(right));
  return { spans: [...kept, { text: " ".repeat(gap), style: fill ? { bg: fill } : undefined }, ...right], fill };
}

function fileRow(file: FileDiff, selected: boolean, hovered: boolean, columns: number, p: Palette): Row {
  const bg = selected ? p.selectedBg : hovered ? mix(p.selectedBg, p.bg, 0.55) : undefined;
  const [mark, color] = STATUS[file.status];
  const right = [...counts(file, p, bg), { text: " ", style: { bg } }];
  const room = Math.max(4, columns - 4 - spanWidth(right));
  const path = truncateStart(file.path, room);
  const slash = path.lastIndexOf("/") + 1;
  return split([
    { text: ` ${mark} `, style: { fg: p[color], bg, bold: selected } },
    { text: path.slice(0, slash), style: { fg: selected ? p.muted : p.dim, bg } },
    { text: path.slice(slash), style: { fg: p.text, bg, bold: selected } },
  ], right, columns, bg);
}

const HELP: Array<[string, string]> = [
  ["↑ ↓  j k", "scroll"], ["d u  space", "half page / page"], ["g G", "top / bottom"],
  ["← →  ] [  tab", "previous / next file"], ["p n  shift ↑ ↓", "previous / next change, across files"],
  ["click", "select a file, press a key below"], ["wheel, drag bar", "scroll"],
  ["s", "switch source"], ["w", "toggle wrap"], ["f", "follow Pi's edits"], ["r", "refresh"], ["q", "close the pane"],
];

/** A group in the bottom bar: clickable keys, then a label. */
export interface KeyGroup { keys: Array<[glyph: string, key: string]>; label: string; warn?: boolean }

const BAR: KeyGroup[] = [
  { keys: [["←", "left"], ["→", "right"]], label: "file" },
  { keys: [["p", "p"], ["n", "n"]], label: "change" },
  { keys: [["s", "s"]], label: "source" },
  { keys: [["f", "f"]], label: "follow" },
  { keys: [["?", "?"]], label: "help" },
];

/** The bottom bar. Groups that do not fit are dropped from the end. */
export function keyBar(groups: KeyGroup[], columns: number, p: Palette, hover: string | undefined): { row: Row; items: Array<{ from: number; to: number; key: string }> } {
  const spans: Span[] = [{ text: " " }];
  const items: Array<{ from: number; to: number; key: string }> = [];
  let used = 1;
  for (const group of groups) {
    const label = group.label;
    const cells = group.keys.reduce((sum, [glyph]) => sum + width(glyph) + 2, 0) + width(label) + 2;
    if (used + cells > columns) break;
    for (const [glyph, key] of group.keys) {
      const hovered = hover === key;
      const text = ` ${glyph} `;
      spans.push({ text, style: { fg: hovered ? p.text : p.accent, bg: hovered ? p.selectedBg : undefined, bold: hovered } });
      items.push({ from: used, to: used + width(text), key });
      used += width(text);
    }
    spans.push({ text: `${label}  `, style: { fg: group.warn ? p.warning : p.dim } });
    used += width(label) + 2;
  }
  return { row: { spans }, items };
}

/** A scrollbar for `height` rows showing `total` rows from `scroll`, or undefined when everything fits. */
export function scrollbar(total: number, height: number, scroll: number, active: boolean, p: Palette): Span[] | undefined {
  if (total <= height || height < 3) return undefined;
  const size = Math.max(1, Math.round(height * height / (total + height - 2)));
  const limit = maxScroll(total, height);
  const start = limit ? Math.round((height - size) * Math.min(1, scroll / limit)) : 0;
  return Array.from({ length: height }, (_, i) => i >= start && i < start + size
    ? { text: "┃", style: { fg: active ? p.text : p.dim } }
    : { text: "│", style: { fg: mix(p.border, p.bg, 0.5) } });
}

/** Body rows cut to leave the last column for a scrollbar. */
export function withBar(rows: Row[], columns: number, bar: Span[] | undefined): Row[] {
  const room = Math.max(0, columns - 1);
  return rows.map((row, i) => {
    const spans = clipSpans(row.spans, room);
    const used = spans.reduce((sum, span) => sum + width(span.text), 0);
    return { spans: [...spans, { text: " ".repeat(Math.max(0, room - used)), style: row.fill ? { bg: row.fill } : undefined }, bar?.[i] ?? { text: " ", style: row.fill ? { bg: row.fill } : undefined }] };
  });
}

export function layout(view: View): Layout {
  const { columns, palette: p } = view;
  const height = Math.max(1, view.rows);
  const files = view.snapshot?.files ?? [];
  const rows: Row[] = [];
  const totals = files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });

  // Header: totals on the left, source and follow state on the right.
  const summary: Span[] = files.length
    ? [{ text: ` ${files.length} ${files.length === 1 ? "file" : "files"} changed `, style: { fg: p.text, bold: true } }, ...counts(totals, p)]
    : [{ text: view.loading && !view.snapshot ? " Loading…" : " No changes", style: { fg: p.muted, bold: true } }];
  const sourceText = view.snapshot?.label ?? "";
  const right: Span[] = [
    { text: view.follow ? "● " : "○ ", style: { fg: view.follow ? p.success : p.dim } },
    { text: `${sourceText} ▾ `, style: view.hover?.area === "source" ? { fg: p.text, bg: p.selectedBg, bold: true } : { fg: p.accent } },
  ];
  rows.push(split(summary, right, columns));
  const source = { row: 0, from: columns - spanWidth(right) };
  if (height >= 30) rows.push({ spans: [] });

  const hovered = (index: number) => view.hover?.area === "file" && view.hover.index === index;
  // File list, at most a third of the pane, keeping the selection visible.
  const room = height - rows.length - 3;
  const listHeight = files.length && room >= 6 ? Math.min(files.length, Math.max(3, Math.floor(height / 3))) : 0;
  let first = 0;
  if (listHeight && files.length > listHeight) {
    const visible = listHeight - 1; // Last row reports what is hidden.
    first = Math.min(Math.max(0, view.selected - Math.floor(visible / 2)), files.length - visible);
    for (let i = first; i < first + visible; i++) rows.push(fileRow(files[i], i === view.selected, hovered(i), columns, p));
    const above = first, below = files.length - first - visible;
    const hint = [below ? `↓ ${below} more` : "", above ? `↑ ${above} above` : ""].filter(Boolean).join("  ");
    rows.push({ spans: [{ text: `   ${hint}`, style: { fg: p.dim } }] });
  } else {
    for (let i = 0; i < listHeight; i++) rows.push(fileRow(files[i], i === view.selected, hovered(i), columns, p));
  }
  const list = { top: height >= 30 ? 2 : 1, height: listHeight, first };

  const file = files[view.selected];
  // Rows below the list: a rule and the title, then the body, then the key bar.
  const showKeys = height - rows.length - 2 >= 8 && columns >= 20;
  const full = file && !view.help && !view.error && !file.binary && file.hunks.length ? fileBody(file, view) : undefined;
  if (rows.length < height) rows.push({ spans: [{ text: "─".repeat(columns), style: { fg: p.border } }] });
  /** The change counter, or the number of changes when they all fit. */
  const changes = () => {
    if (!full || full.hunks.length < 2) return "";
    const space = Math.max(0, height - rows.length - 1 - (showKeys ? 1 : 0));
    if (!maxScroll(full.rows.length, space)) return `${full.hunks.length} changes · `;
    return `change ${hunkAt(full.hunks, view.scroll, full.rows.length, space)}/${full.hunks.length} · `;
  };
  if (file && rows.length < height) {
    const notes = [
      file.oldPath ? `from ${file.oldPath}` : "",
      file.status === "untracked" ? "untracked" : file.status === "added" ? "new file" : file.status === "deleted" ? "deleted" : "",
      ...file.notes,
    ].filter(Boolean).join(" · ");
    rows.push(split([
      { text: " ", style: undefined },
      { text: file.path, style: { fg: p.text, bold: true } },
      { text: notes ? `  ${notes}` : "", style: { fg: p.dim } },
    ], [
      { text: changes(), style: { fg: p.dim } },
      { text: `file ${view.selected + 1}/${files.length} `, style: { fg: p.dim } },
    ], columns));
  }

  const top = rows.length;

  const bodyHeight = Math.max(0, height - top - (showKeys ? 1 : 0));
  let content: Row[];
  let total = 0;
  const message = (text: string, color: string): Row[] => [{ spans: [] }, { spans: [{ text: `   ${text}`, style: { fg: color } }] }];
  if (view.help) {
    content = [{ spans: [] }, ...HELP.map(([keys, action]) => ({ spans: [
      { text: `   ${keys.padEnd(14)}`, style: { fg: p.accent } }, { text: action, style: { fg: p.text } },
    ] })), { spans: [] }, { spans: [{ text: "   ? closes this help", style: { fg: p.dim } }] }];
  } else if (view.error) {
    content = message(view.error, p.error);
  } else if (!file) {
    content = view.snapshot ? message(view.snapshot.source === "staged" ? "Nothing is staged." : "The working tree is clean.", p.dim) : [];
  } else if (file.binary) {
    content = message("Binary file changed.", p.dim);
  } else if (!file.hunks.length) {
    content = message(file.notes.length || file.oldPath ? "No content changes." : "Empty file.", p.dim);
  } else {
    const all = full!.rows;
    total = all.length;
    content = all.slice(view.scroll, view.scroll + bodyHeight);
  }
  let bars: Layout["scrollbar"];
  if (full) {
    const bar = scrollbar(total, bodyHeight, view.scroll, view.hover?.area === "scrollbar", p);
    if (bar) bars = { column: columns - 1, top, height: bodyHeight };
    while (content.length < bodyHeight) content.push({ spans: [] });
    content = withBar(content, columns, bar);
  }
  rows.push(...content.slice(0, bodyHeight));
  while (rows.length < top + bodyHeight) rows.push({ spans: [] });
  let keys: Layout["keys"];
  if (showKeys) {
    const groups = BAR.map((group) => group.label === "follow" ? { ...group, warn: !view.follow } : group);
    const bar = keyBar(groups, columns, p, view.hover?.area === "key" ? view.hover.key : undefined);
    keys = { row: rows.length, items: bar.items };
    rows.push(bar.row);
  }
  while (rows.length < height) rows.push({ spans: [] });
  return { rows: rows.slice(0, height), list, body: { top, height: bodyHeight, total }, source, keys, scrollbar: bars };
}
