// Terminal cell measurement and styled spans for the diff viewer.

export interface Style {
  fg?: string; bg?: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean;
  /** An OSC 8 hyperlink target. */
  link?: string;
}
export interface Span { text: string; style?: Style }
/** One terminal row: spans, then padding to the full width in `fill`. */
export interface Row { spans: Span[]; fill?: string }

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ZERO = /^(?:\p{Mn}|\p{Me}|\p{Cf})+$/u;
const EMOJI = /\p{Extended_Pictographic}/u;

function wide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3041 && code <= 0x33ff)
    || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xa000 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff) || (code >= 0x20000 && code <= 0x3fffd);
}

export function graphemeWidth(grapheme: string): number {
  if (ZERO.test(grapheme)) return 0;
  const code = grapheme.codePointAt(0)!;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (grapheme.includes("\u{FE0F}") || (EMOJI.test(grapheme) && wide(code))) return 2;
  return wide(code) ? 2 : 1;
}

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

export function width(text: string): number {
  let total = 0;
  for (const grapheme of graphemes(text)) total += graphemeWidth(grapheme);
  return total;
}

/** Expands tabs and makes control characters visible, so every grapheme has a known width. */
export function sanitize(text: string, tab = 4): string {
  let out = "";
  let column = 0;
  for (const grapheme of graphemes(text)) {
    if (grapheme === "\t") { const pad = tab - (column % tab); out += " ".repeat(pad); column += pad; continue; }
    const code = grapheme.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) { out += String.fromCodePoint(0x2400 + (code === 0x7f ? 0x21 : code)); column++; continue; }
    out += grapheme;
    column += graphemeWidth(grapheme);
  }
  return out;
}

/** The longest prefix that fits in `max` cells. */
export function take(text: string, max: number): string {
  let out = "";
  let used = 0;
  for (const grapheme of graphemes(text)) {
    const cell = graphemeWidth(grapheme);
    if (used + cell > max) break;
    out += grapheme;
    used += cell;
  }
  return out;
}

/** Truncates to `max` cells, ending with an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  return width(text) <= max ? text : `${take(text, max - 1)}…`;
}

/** Truncates from the left, keeping the end (file names) visible. */
export function truncateStart(text: string, max: number): string {
  if (max <= 0) return "";
  if (width(text) <= max) return text;
  const parts = graphemes(text);
  let out = "";
  let used = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const cell = graphemeWidth(parts[i]);
    if (used + cell > max - 1) break;
    out = parts[i] + out;
    used += cell;
  }
  return `…${out}`;
}

/**
 * Wraps styled spans to `max` cells. Breaks after whitespace when that keeps
 * at least half the row; otherwise breaks mid-word.
 */
export function wrapSpans(spans: Span[], max: number): Span[][] {
  const cells: Array<{ g: string; w: number; style?: Style }> = [];
  for (const span of spans) for (const g of graphemes(span.text)) cells.push({ g, w: graphemeWidth(g), style: span.style });
  const rows: Span[][] = [];
  let start = 0;
  while (start < cells.length || rows.length === 0) {
    let used = 0, end = start, lastBreak = -1;
    while (end < cells.length && used + cells[end].w <= max) {
      used += cells[end].w;
      if (cells[end].g === " ") lastBreak = end + 1;
      end++;
    }
    if (end < cells.length && lastBreak > start && lastBreak - start >= max / 2) end = lastBreak;
    if (end === start && start < cells.length) end++; // A grapheme wider than the row.
    rows.push(merge(cells.slice(start, end)));
    start = end;
    if (start >= cells.length) break;
  }
  return rows;
}

function merge(cells: Array<{ g: string; style?: Style }>): Span[] {
  const spans: Span[] = [];
  for (const cell of cells) {
    const last = spans.at(-1);
    if (last && last.style === cell.style) last.text += cell.g;
    else spans.push({ text: cell.g, style: cell.style });
  }
  return spans;
}

/** Cuts styled spans to `max` cells, marking the cut with an ellipsis. */
export function clipSpans(spans: Span[], max: number): Span[] {
  const total = spans.reduce((sum, span) => sum + width(span.text), 0);
  if (total <= max) return spans;
  const out: Span[] = [];
  let left = max - 1;
  for (const span of spans) {
    if (left <= 0) break;
    const text = take(span.text, left);
    out.push({ text, style: span.style });
    left -= width(text);
  }
  out.push({ text: "…", style: spans.at(-1)?.style });
  return out;
}

export function rowWidth(row: Row): number {
  return row.spans.reduce((sum, span) => sum + width(span.text), 0);
}

const hex = (value: string) => {
  const match = /^#?([0-9a-f]{6})$/i.exec(value);
  if (!match) return undefined;
  const n = parseInt(match[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255] as const;
};

export function sgr(style: Style | undefined): string {
  if (!style) return "";
  const codes: string[] = [];
  if (style.bold) codes.push("1");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.strike) codes.push("9");
  const fg = style.fg && hex(style.fg), bg = style.bg && hex(style.bg);
  if (fg) codes.push(`38;2;${fg.join(";")}`);
  if (bg) codes.push(`48;2;${bg.join(";")}`);
  return codes.length ? `\x1b[${codes.join(";")}m` : "";
}

/** Link targets may not carry control characters into the escape sequence. */
const safeLink = (url: string) => url.replace(/[\x00-\x1f\x7f]/g, "");

/** Serializes a row to exactly `columns` cells; every row ends reset, with no link left open. */
export function paint(row: Row, columns: number): string {
  const spans = clipSpans(row.spans, columns);
  let out = "";
  let link: string | undefined;
  for (const span of spans) {
    const next = span.style?.link ? safeLink(span.style.link) : undefined;
    if (next !== link) { out += `\x1b]8;;${next ?? ""}\x1b\\`; link = next; }
    out += `\x1b[0m${sgr(span.style)}${span.text}`;
  }
  if (link) out += "\x1b]8;;\x1b\\";
  const pad = columns - spans.reduce((sum, span) => sum + width(span.text), 0);
  if (pad > 0) out += `\x1b[0m${sgr(row.fill ? { bg: row.fill } : undefined)}${" ".repeat(pad)}`;
  return `${out}\x1b[0m`;
}

/** Mixes two #rrggbb colors; `amount` is the share of `a`. */
export function mix(a: string, b: string, amount: number): string {
  const x = hex(a), y = hex(b);
  if (!x || !y) return a;
  const channel = (i: number) => Math.round(x[i] * amount + y[i] * (1 - amount)).toString(16).padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

export function luminance(color: string): number {
  const value = hex(color);
  if (!value) return 0;
  const [r, g, b] = value.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
