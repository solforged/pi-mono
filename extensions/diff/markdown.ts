// Lays out a Markdown document as styled rows for the document pane, parsed
// with the marked build that ships with Pi for HTML export. Pure: doc.ts owns
// terminal I/O.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { keyBar, scrollbar, type KeyGroup, type Palette } from "./render.ts";
import type { Highlighter } from "./syntax.ts";
import { mix, sanitize, take, width, wrapSpans, type Row, type Span, type Style } from "./text.ts";

/** The parts of marked's tokens the layout reads. */
export interface MdToken {
  type: string;
  raw?: string;
  text?: string;
  tokens?: MdToken[];
  depth?: number;
  lang?: string;
  href?: string;
  checked?: boolean;
  ordered?: boolean;
  start?: number | "";
  loose?: boolean;
  items?: MdToken[];
  header?: Array<{ text: string; tokens: MdToken[] }>;
  rows?: Array<Array<{ text: string; tokens: MdToken[] }>>;
  align?: Array<"left" | "center" | "right" | null>;
}
export type Lexer = (markdown: string) => MdToken[];

/** marked as shipped with Pi for HTML export, beside the running binary. */
export function bundledMarked(execPath = process.execPath): string | undefined {
  const file = join(dirname(execPath), "export-html", "vendor", "marked.min.js");
  return existsSync(file) ? file : undefined;
}

/** Loads Pi's bundled marked browser build in an isolated context. */
export function loadMarked(file: string | undefined): Lexer | undefined {
  if (!file) return undefined;
  try {
    const context = vm.createContext({});
    vm.runInContext(readFileSync(file, "utf8"), context, { filename: file, timeout: 2_000 });
    const marked = (context as { marked?: { lexer?: (source: string, options?: object) => MdToken[] } }).marked;
    if (typeof marked?.lexer !== "function") return undefined;
    return (markdown) => marked.lexer!(markdown, { gfm: true });
  } catch {
    return undefined;
  }
}

/** Without marked, a document still reads as plain paragraphs and fenced code. */
export function plainLexer(markdown: string): MdToken[] {
  const tokens: MdToken[] = [];
  const lines = markdown.split(/\r\n?|\n/);
  for (let i = 0; i < lines.length;) {
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(lines[i]);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i]);
      i++;
      tokens.push({ type: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    if (!lines[i].trim()) { i++; continue; }
    const body: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^\s{0,3}(`{3,}|~{3,})/.test(lines[i]); i++) body.push(lines[i]);
    const heading = body.length === 1 ? /^(#{1,6})\s+(.*)$/.exec(body[0]) : null;
    tokens.push(heading
      ? { type: "heading", depth: heading[1].length, text: heading[2], tokens: [{ type: "text", text: heading[2] }] }
      : { type: "paragraph", text: body.join("\n"), tokens: [{ type: "text", text: body.join("\n") }] });
  }
  return tokens;
}

export interface DocOptions {
  width: number;
  palette: Palette;
  highlighter?: Highlighter;
  /** The hyperlink for a link's target, or undefined to leave it unlinked. */
  link: (href: string) => string | undefined;
}

/** A row of the document; headings carry their anchor. */
export interface DocRow extends Row { anchor?: string; heading?: boolean }
export interface Doc {
  rows: DocRow[];
  /** Heading anchors, GitHub style, to their row. */
  anchors: Map<string, number>;
  /** Rows where headings start, for stepping between sections. */
  headings: number[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0", "#39": "'" };
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens. */
export function slug(text: string): string {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

const BULLETS = ["•", "◦", "▪"];
const BREAK = "\n";

interface Look {
  text: string; heading: string; link: string; code: string; codeBg: string;
  quote: string; quoteBorder: string; rule: string; bullet: string; dim: string;
}

function look(p: Palette): Look {
  const md = p.md ?? {};
  return {
    text: p.text, heading: md.heading ?? p.accent, link: md.link ?? p.accent, code: md.code ?? p.syntax?.string ?? p.accent,
    codeBg: mix(p.text, p.bg, 0.06), quote: md.quote ?? p.muted, quoteBorder: md.quoteBorder ?? p.border,
    rule: md.hr ?? p.border, bullet: md.bullet ?? p.accent, dim: p.dim,
  };
}

export function renderDoc(tokens: MdToken[], options: DocOptions): Doc {
  const p = options.palette;
  const l = look(p);

  /** Inline tokens as spans; line breaks become separate `BREAK` spans. */
  function inline(list: MdToken[] | undefined, base: Style): Span[] {
    const out: Span[] = [];
    for (const token of list ?? []) {
      switch (token.type) {
        case "text":
          if (token.tokens?.length) out.push(...inline(token.tokens, base));
          else pushText(out, decodeEntities(token.text ?? ""), base);
          break;
        case "escape": pushText(out, token.text ?? "", base); break;
        case "strong": out.push(...inline(token.tokens, { ...base, bold: true })); break;
        case "em": out.push(...inline(token.tokens, { ...base, italic: true })); break;
        case "del": out.push(...inline(token.tokens, { ...base, strike: true, fg: l.dim })); break;
        case "codespan": pushText(out, token.text ?? "", { ...base, fg: l.code, bold: false, italic: false }); break;
        case "br": out.push({ text: BREAK }); break;
        case "link": {
          const target = options.link(token.href ?? "");
          out.push(...inline(token.tokens, { ...base, fg: l.link, underline: true, ...(target ? { link: target } : {}) }));
          break;
        }
        case "image": {
          const target = options.link(token.href ?? "");
          pushText(out, `▣ ${decodeEntities(token.text ?? "") || "image"}`, { ...base, fg: l.link, ...(target ? { link: target } : {}) });
          break;
        }
        case "checkbox": pushText(out, token.checked ? "☑ " : "☐ ", { ...base, fg: l.bullet }); break;
        case "html": pushText(out, token.text ?? "", { ...base, fg: l.dim }); break;
        default: pushText(out, decodeEntities(token.text ?? token.raw ?? ""), base);
      }
    }
    return out;
  }

  function pushText(out: Span[], text: string, style: Style) {
    text.split("\n").forEach((part, i) => {
      if (i) out.push({ text: " ", style }); // Soft line breaks join lines, as in a browser.
      if (part) out.push({ text: sanitize(part), style });
    });
  }

  /** Wraps inline spans to `max` cells, honoring hard breaks. */
  function lines(spans: Span[], max: number): Span[][] {
    const out: Span[][] = [];
    let current: Span[] = [];
    for (const span of [...spans, { text: BREAK }]) {
      if (span.text !== BREAK) { current.push(span); continue; }
      out.push(...wrapSpans(trimStart(current), Math.max(1, max)));
      current = [];
    }
    return out;
  }

  const prefixed = (rows: DocRow[], first: Span[], rest: Span[]): DocRow[] =>
    rows.map((row, i) => ({ ...row, spans: [...(i ? rest : first), ...row.spans] }));

  /** Block tokens as rows `max` cells wide, with a blank row between blocks unless `tight`. */
  function blocks(list: MdToken[] | undefined, max: number, base: Style, tight = false, depth = 0): DocRow[] {
    const out: DocRow[] = [];
    for (const token of list ?? []) {
      const rows = block(token, max, base, depth);
      if (!rows.length) continue;
      if (out.length && !tight) out.push({ spans: [] });
      out.push(...rows);
    }
    return out;
  }

  function block(token: MdToken, max: number, base: Style, depth: number): DocRow[] {
    switch (token.type) {
      case "space": case "def": case "checkbox": return [];
      case "heading": {
        const level = token.depth ?? 1;
        const style: Style = { fg: level <= 2 ? l.heading : l.text, bold: true };
        const text = inline(token.tokens, style);
        const rows: DocRow[] = lines(text, max).map((spans) => ({ spans }));
        rows[0] = { ...rows[0], heading: true, anchor: slug(text.map((span) => span.text).join("")) };
        if (level === 1) rows.push({ spans: [{ text: "─".repeat(Math.max(1, max)), style: { fg: l.rule } }] });
        return rows;
      }
      case "paragraph": case "text":
        return lines(token.tokens ? inline(token.tokens, base) : inline([{ type: "text", text: token.text }], base), max).map((spans) => ({ spans }));
      case "code": return code(token, max);
      case "blockquote": {
        const inner = blocks(token.tokens, max - 2, { ...base, fg: l.quote, italic: true }, false, depth);
        const bar: Span[] = [{ text: "│ ", style: { fg: l.quoteBorder } }];
        return prefixed(inner, bar, bar);
      }
      case "list": {
        const rows: DocRow[] = [];
        const start = typeof token.start === "number" ? token.start : 1;
        const items = token.items ?? [];
        // A task item shows its box in place of the bullet.
        const markers = items.map((item, i) => token.ordered ? `${start + i}.` : task(item) ?? BULLETS[depth % BULLETS.length]);
        const indent = markers.reduce((widest, marker) => Math.max(widest, width(marker)), 1) + 1;
        items.forEach((item, i) => {
          if (i && token.loose) rows.push({ spans: [] });
          const inner = blocks(token.ordered ? item.tokens : withoutBox(item.tokens), max - indent, base, !token.loose, depth + 1);
          if (!inner.length) inner.push({ spans: [] });
          const marker = markers[i].padStart(token.ordered ? indent - 1 : 0).padEnd(indent);
          rows.push(...prefixed(inner, [{ text: marker, style: { fg: l.bullet } }], [{ text: " ".repeat(indent) }]));
        });
        return rows;
      }
      case "table": return table(token, max);
      case "hr": return [{ spans: [{ text: "─".repeat(Math.max(1, max)), style: { fg: l.rule } }] }];
      case "html": {
        const text = (token.text ?? "").replace(/\n+$/, "");
        return text ? text.split("\n").flatMap((line) => wrapSpans([{ text: sanitize(line), style: { fg: l.dim } }], Math.max(1, max))).map((spans) => ({ spans })) : [];
      }
      default:
        return token.text ? lines(inline([{ type: "text", text: token.text }], base), max).map((spans) => ({ spans })) : [];
    }
  }

  function code(token: MdToken, max: number): DocRow[] {
    const source = (token.text ?? "").split("\n").map((line) => sanitize(line));
    const lang = token.lang?.split(/\s/)[0];
    const language = lang ? options.highlighter?.named(lang) : undefined;
    const pieces = language ? options.highlighter!.highlight(source, language) : source.map((text) => [{ text }]);
    const fill = l.codeBg;
    const styles = new Map<string, Style>();
    const style = (fg: string) => { let value = styles.get(fg); if (!value) styles.set(fg, value = { fg, bg: fill }); return value; };
    const pad = { text: " ", style: { bg: fill } };
    const rows: DocRow[] = [];
    pieces.forEach((line) => {
      const spans = line.map((piece) => ({ text: piece.text, style: style((piece.token && p.syntax?.[piece.token]) || l.text) }));
      wrapSpans(spans, Math.max(1, max - 2)).forEach((wrapped) => rows.push({ spans: [pad, ...wrapped], fill }));
    });
    return [{ spans: [], fill }, ...rows, { spans: [], fill }];
  }

  function table(token: MdToken, max: number): DocRow[] {
    const header = (token.header ?? []).map((cell) => inline(cell.tokens, { fg: l.text, bold: true }));
    const body = (token.rows ?? []).map((row) => row.map((cell) => inline(cell.tokens, { fg: l.text })));
    const count = header.length;
    if (!count) return [];
    const natural = Array.from({ length: count }, (_, i) =>
      [header, ...body].reduce((widest, row) => Math.max(widest, row[i] ? spanWidth(row[i]) : 0), 1));
    // Shrink the widest columns until the table fits, keeping each at least 3 wide.
    const room = Math.max(count * 3, max - (count * 3 + 1));
    const widths = [...natural];
    while (widths.reduce((sum, w) => sum + w, 0) > room) {
      const widest = widths.indexOf(Math.max(...widths));
      if (widths[widest] <= 3) break;
      widths[widest]--;
    }
    const border = { fg: l.rule };
    const rule = (left: string, middle: string, right: string): DocRow =>
      ({ spans: [{ text: left + widths.map((w) => "─".repeat(w + 2)).join(middle) + right, style: border }] });
    const align = token.align ?? [];
    const row = (cells: Span[][]): DocRow[] => {
      const wrapped = widths.map((w, i) => cells[i]?.length ? wrapSpans(trimStart(cells[i]), w) : [[]]);
      const height = Math.max(...wrapped.map((cell) => cell.length));
      return Array.from({ length: height }, (_, line) => {
        const spans: Span[] = [{ text: "│", style: border }];
        widths.forEach((w, i) => {
          const content = wrapped[i][line] ?? [];
          const gap = w - spanWidth(content);
          const left = align[i] === "right" ? gap : align[i] === "center" ? Math.floor(gap / 2) : 0;
          spans.push({ text: ` ${" ".repeat(left)}` }, ...content, { text: `${" ".repeat(gap - left)} ` }, { text: "│", style: border });
        });
        return { spans };
      });
    };
    return [rule("┌", "┬", "┐"), ...row(header), rule("├", "┼", "┤"), ...body.flatMap(row), rule("└", "┴", "┘")];
  }

  const rows = blocks(tokens, Math.max(10, options.width), { fg: l.text });
  const anchors = new Map<string, number>();
  const headings: number[] = [];
  const seen = new Map<string, number>();
  rows.forEach((row, i) => {
    if (!row.heading) return;
    headings.push(i);
    if (row.anchor === undefined) return;
    const n = seen.get(row.anchor) ?? 0;
    seen.set(row.anchor, n + 1);
    anchors.set(n ? `${row.anchor}-${n}` : row.anchor, i);
  });
  return { rows, anchors, headings };
}

/** A task item's box: marked puts it before the item's text, or inside its first paragraph. */
function task(item: MdToken): string | undefined {
  const first = item.tokens?.[0];
  const box = first?.type === "checkbox" ? first : first?.tokens?.[0]?.type === "checkbox" ? first.tokens[0] : undefined;
  return box ? (box.checked ? "☑" : "☐") : undefined;
}

function withoutBox(tokens: MdToken[] | undefined): MdToken[] | undefined {
  if (!tokens?.length) return tokens;
  const [first, ...rest] = tokens;
  if (first.type === "checkbox") return rest;
  if (first.tokens?.[0]?.type === "checkbox") return [{ ...first, tokens: first.tokens.slice(1) }, ...rest];
  return tokens;
}

const spanWidth = (spans: Span[]) => spans.reduce((sum, span) => sum + width(span.text), 0);

/** Drops leading spaces, which a soft break or wrap can leave at the start of a line. */
function trimStart(spans: Span[]): Span[] {
  const out = [...spans];
  while (out.length && !out[0].text.trimStart()) out.shift();
  if (out.length) out[0] = { ...out[0], text: out[0].text.trimStart() };
  return out;
}

// ── Pane layout ─────────────────────────────────────────────────────────────

export interface DocView {
  /** The document's path as shown in the header. */
  title: string;
  doc?: Doc;
  error?: string;
  scroll: number;
  columns: number;
  rows: number;
  palette: Palette;
  help: boolean;
  /** Whether ⌫ has a document to go back to. */
  back: boolean;
  hover?: { area: "key"; key: string } | { area: "scrollbar" };
}

export interface DocLayout {
  rows: Row[];
  body: { top: number; height: number; total: number };
  keys?: { row: number; items: Array<{ from: number; to: number; key: string }> };
  scrollbar?: { column: number; top: number; height: number };
}

/** The text width for a pane: a margin on the left, and a gap and the scrollbar on the right. */
export const docWidth = (columns: number) => Math.max(10, columns - 3);

const DOC_HELP: Array<[string, string]> = [
  ["↑ ↓  j k", "scroll"], ["d u  space b", "half page / page"], ["g G", "top / bottom"],
  ["n p", "next / previous heading"], ["⌫", "back to the previous document"],
  ["wheel, drag bar", "scroll"], ["⌘-click a link", "follow it"],
  ["o", "open in the default app"], ["r", "reload"], ["q", "close; the diff comes back"],
];

export function layoutDoc(view: DocView): DocLayout {
  const { columns, palette: p } = view;
  const height = Math.max(1, view.rows);
  const rows: Row[] = [];
  const total = view.doc?.rows.length ?? 0;
  const showKeys = height >= 10 && columns >= 20;
  const bodyHeight = Math.max(0, height - 2 - (showKeys ? 1 : 0));

  // A file's name can hold anything, escape sequences included.
  const title = sanitize(view.title);
  const slash = title.lastIndexOf("/") + 1;
  const limit = Math.max(0, total - Math.max(1, bodyHeight - 2));
  const where = !total || total <= bodyHeight ? "" : view.scroll <= 0 ? "top" : view.scroll >= limit ? "end" : `${Math.round(view.scroll / limit * 100)}%`;
  const right = where ? ` ${where} ` : " ";
  const room = Math.max(1, columns - width(right) - 1);
  let dir = title.slice(0, slash), base = title.slice(slash);
  if (width(dir) + width(base) > room) {
    const keep = Math.max(0, room - width(base) - 1);
    dir = keep > 0 ? `…${[...dir].slice(-keep).join("")}` : "";
    if (!keep) base = [...base].slice(0, Math.max(1, room - 1)).join("") + (width(base) > room ? "…" : "");
  }
  const used = 1 + width(dir) + width(base);
  rows.push({ spans: [
    { text: " " }, { text: dir, style: { fg: p.dim } }, { text: base, style: { fg: p.text, bold: true } },
    { text: " ".repeat(Math.max(1, columns - used - width(right))) }, { text: right, style: { fg: p.dim } },
  ] });
  rows.push({ spans: [{ text: "─".repeat(columns), style: { fg: p.border } }] });
  const top = rows.length;

  let content: Row[];
  let bar: Span[] | undefined;
  const margin = { text: " " };
  if (view.help) {
    content = [{ spans: [] }, ...DOC_HELP.map(([keys, action]) => ({ spans: [
      { text: `  ${keys.padEnd(16)}`, style: { fg: p.accent } }, { text: action, style: { fg: p.text } },
    ] })), { spans: [] }, { spans: [{ text: "  ? closes this help", style: { fg: p.dim } }] }];
  } else if (view.error) {
    content = [{ spans: [] }, { spans: [{ text: `  ${sanitize(view.error)}`, style: { fg: p.error } }] }];
  } else if (!view.doc) {
    content = [{ spans: [] }, { spans: [{ text: "  Loading…", style: { fg: p.dim } }] }];
  } else {
    content = view.doc.rows.slice(view.scroll, view.scroll + bodyHeight).map((row) => ({ ...row, spans: [margin, ...row.spans] }));
    bar = scrollbar(total, bodyHeight, view.scroll, view.hover?.area === "scrollbar", p);
  }
  // Cut each row short of the gap and the scrollbar column.
  const inner = Math.max(0, columns - 2);
  for (let i = 0; i < bodyHeight; i++) {
    const row = content[i] ?? { spans: [] };
    const fill = row.fill ? { bg: row.fill } : undefined;
    const spans: Span[] = [];
    let left = inner;
    for (const span of row.spans) {
      if (left <= 0) break;
      const text = take(span.text, left);
      spans.push({ text, style: span.style });
      left -= width(text);
    }
    spans.push({ text: " ".repeat(left), style: fill }, { text: " " }, bar?.[i] ?? { text: " " });
    rows.push({ spans });
  }
  let keys: DocLayout["keys"];
  if (showKeys) {
    const groups: KeyGroup[] = [
      ...(view.back ? [{ keys: [["⌫", "backspace"]], label: "back" } satisfies KeyGroup] : []),
      { keys: [["p", "p"], ["n", "n"]], label: "heading" },
      { keys: [["o", "o"]], label: "open" },
      { keys: [["q", "q"]], label: "close" },
      { keys: [["?", "?"]], label: "help" },
    ];
    const made = keyBar(groups, columns, p, view.hover?.area === "key" ? view.hover.key : undefined);
    keys = { row: rows.length, items: made.items };
    rows.push(made.row);
  }
  while (rows.length < height) rows.push({ spans: [] });
  return {
    rows: rows.slice(0, height), body: { top, height: bodyHeight, total }, keys,
    scrollbar: bar ? { column: columns - 1, top, height: bodyHeight } : undefined,
  };
}
