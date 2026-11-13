// HTML to compact text with light Markdown structure: what a model needs to
// read a page, without the markup. Not a browser: no CSS, scripts or layout.
// Every scan is linear, because pages are untrusted and parsed on Pi's thread.

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", middot: "·", bull: "•", times: "×", rarr: "→", larr: "←", deg: "°",
};
// Content that is not page text. An unclosed one hides the rest of the page.
const OPAQUE = new Set(["script", "style", "textarea", "title", "iframe"]);
// Skipped only when closed, so a stray tag cannot swallow the page.
const SKIPPED = new Set(["head", "nav", "footer", "noscript", "template", "svg", "canvas", "select", "button", "object", "audio", "video"]);
// Set off by a blank line, except inside a list, where that would double its length.
const PARAGRAPH = new Set(["p", "blockquote", "table"]);
const LINE = new Set(["div", "section", "article", "main", "header", "aside", "dl", "dt", "dd", "figure", "figcaption", "details", "summary", "address", "fieldset", "form", "caption", "option"]);
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​﻿]/g;
const HREF = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;
const ROLE_MAIN = /(?:^|\s)role\s*=\s*["']?main(?:["'\s]|$)/i;
// Below this, a content region is taken for an empty shell and the whole page is used.
const REGION_CHARS = 200;

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,10});/gi, (whole, body: string) => {
    if (body[0] !== "#") return ENTITIES[body] ?? ENTITIES[body.toLowerCase()] ?? whole;
    const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

/** Drops control characters, trailing spaces, repeated blank lines and empty list or heading markers. */
export function tidy(text: string): string {
  const lines: string[] = [];
  let blank = false, fenced = false;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(CONTROLS, "").trimEnd();
    if (line.startsWith("```")) fenced = !fenced;
    if (!line || !fenced && /^(?:#{1,6}|\s*-)$/.test(line)) { blank = true; continue; }
    if (blank && lines.length) lines.push("");
    blank = false;
    lines.push(line);
  }
  return lines.join("\n");
}

// Index of the `>` that ends a tag, skipping quoted attribute values.
function tagEnd(html: string, from: number): number {
  for (let i = from, quote = 0; i < html.length; i++) {
    const code = html.charCodeAt(i);
    if (quote) { if (code === quote) quote = 0; }
    else if (code === 34 || code === 39) quote = code;
    else if (code === 62) return i;
  }
  return -1;
}

function linkTarget(attrs: string, base?: string): string | undefined {
  const match = HREF.exec(attrs), href = decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  if (!href || href.startsWith("#")) return;
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch { return; }
}

// Output must stay proportional to the page: unbounded list indentation, or a
// long base URL repeated in every link, would otherwise turn a few hundred
// kilobytes of markup into hundreds of megabytes of text.
const LIST_INDENT = 8;
const outputBudget = (html: string) => html.length * 4 + 65_536;

// One pass over the page. The text of its content region (<main> or
// role="main", else its <article>s) is preferred over the whole page, which
// also carries menus and sidebars.
function convert(html: string, base: string | undefined, links: boolean): string {
  // Output is collected in pieces: appending to one long string and then
  // reading its end makes the engine copy it again and again.
  const pieces: string[] = [];
  let size = 0, tail = "", breaks = 0, space = false, pre = false, fresh = false, depth = 0, cells = 0, linked = 0;
  let main: { name: string; open: number; from: number; to?: number } | undefined, article: { from: number; to: number } | undefined;
  const anchors: Array<{ at: number; url: string; tail: string } | undefined> = [];
  const closers = new Map<string, RegExp>(), unclosed = new Set<string>();
  const emit = (piece: string) => { if (piece) { pieces.push(piece); size += piece.length; tail = piece.at(-1)!; } };
  const flush = () => {
    if (size) emit(breaks ? "\n".repeat(breaks) : space && !" \n[".includes(tail) ? " " : "");
    breaks = 0; space = false;
  };
  // A marker (list bullet, heading) owns its line: blocks opened right after it stay on that line.
  const block = (lines: number) => { if (!fresh) { breaks = Math.max(breaks, lines); space = false; } };
  const put = (text: string) => { flush(); emit(text); };
  const marker = (text: string) => { fresh = false; block(text.startsWith("#") ? 2 : 1); put(text); fresh = true; };
  const text = (source: string) => {
    const decoded = decodeEntities(source);
    if (pre) { emit(decoded); return; }
    // Permalink marks beside headings.
    if (linked && /^\s*[#¶§]\s*$/.test(decoded)) return;
    const flat = decoded.replace(/\s+/g, " ");
    if (flat === "" || flat === " ") { space ||= flat === " "; return; }
    space ||= flat[0] === " ";
    put(flat.trim());
    space = flat.endsWith(" "); fresh = false;
  };
  const open = (name: string, attrs: string) => {
    if (pre) { if (name === "br") emit("\n"); return; }
    if (name === "a") linked++;
    if (main && main.to === undefined && name === main.name) main.open++;
    else if (!main && (name === "main" || ROLE_MAIN.test(attrs))) main = { name, open: 1, from: size };
    if (name === "article") article ??= { from: size, to: size };
    if (/^h[1-6]$/.test(name)) marker(`${"#".repeat(Number(name[1]))} `);
    else if (name === "li") marker(`${"  ".repeat(Math.min(LIST_INDENT, Math.max(0, depth - 1)))}- `);
    else if (name === "ul" || name === "ol") block(depth++ ? 1 : 2);
    else if (name === "br") block(1);
    else if (name === "tr") { block(1); cells = 0; }
    else if (name === "td" || name === "th") { if (cells++ && !breaks && size && tail !== "\n") { space = false; put(" | "); } }
    else if (name === "pre") { block(2); put("```\n"); pre = true; }
    else if (name === "code") put("`");
    else if (name === "a" && links) {
      const url = linkTarget(attrs, base);
      if (url) { flush(); anchors.push({ at: size, url, tail }); emit("["); } else anchors.push(undefined);
    } else if (PARAGRAPH.has(name)) block(depth ? 1 : 2);
    else if (LINE.has(name)) block(1);
  };
  const close = (name: string) => {
    if (name === "pre" && pre) { pre = false; emit(`${tail === "\n" ? "" : "\n"}\`\`\``); block(2); return; }
    if (pre) return;
    fresh = false;
    if (name === "a") linked = Math.max(0, linked - 1);
    if (main && main.to === undefined && name === main.name && --main.open === 0) main.to = size;
    if (article && name === "article") article.to = size;
    if (/^h[1-6]$/.test(name)) block(2);
    else if (PARAGRAPH.has(name)) block(depth ? 1 : 2);
    else if (name === "ul" || name === "ol") { depth = Math.max(0, depth - 1); block(depth ? 1 : 2); }
    else if (name === "code") emit("`");
    else if (name === "a" && links) {
      const anchor = anchors.pop();
      // A link around nothing readable (an image, say) leaves no trace.
      if (anchor && size === anchor.at + 1) { pieces.pop(); size--; tail = anchor.tail; }
      else if (anchor) emit(`](${anchor.url})`);
    } else if (name === "li" || name === "tr" || LINE.has(name)) block(1);
  };

  const budget = outputBudget(html);
  for (let pos = 0; pos < html.length;) {
    if (size > budget) { pre = false; block(2); put("[The rest of this page was not converted: it expands to far more text than its markup.]"); break; }
    const lt = html.indexOf("<", pos);
    if (lt < 0) { text(html.slice(pos)); break; }
    if (lt > pos) text(html.slice(pos, lt));
    if (html.startsWith("<!--", lt)) { const end = html.indexOf("-->", lt + 4); pos = end < 0 ? html.length : end + 3; continue; }
    TAG.lastIndex = lt;
    const tag = TAG.exec(html);
    if (!tag) {
      // A declaration such as <!doctype>, or a literal "<".
      if (html[lt + 1] === "!" || html[lt + 1] === "?") { const end = html.indexOf(">", lt); pos = end < 0 ? html.length : end + 1; }
      else { text("<"); pos = lt + 1; }
      continue;
    }
    const end = tagEnd(html, lt + tag[0].length);
    if (end < 0) break;
    const name = tag[2].toLowerCase();
    pos = end + 1;
    if (tag[1]) { close(name); continue; }
    if ((OPAQUE.has(name) || SKIPPED.has(name)) && !pre && !unclosed.has(name)) {
      const closer = closers.get(name) ?? closers.set(name, new RegExp(`</${name}\\s*>`, "gi")).get(name)!;
      closer.lastIndex = pos;
      if (closer.exec(html)) { pos = closer.lastIndex; continue; }
      if (OPAQUE.has(name)) break;
      unclosed.add(name);
      continue;
    }
    open(name, html.slice(lt + tag[0].length, end));
  }
  if (pre) emit("\n```");
  const out = pieces.join("");
  for (const part of [main, article]) {
    const text = part ? tidy(out.slice(part.from, part.to)) : "";
    if (text.length >= REGION_CHARS) return text;
  }
  return tidy(out);
}

export function htmlToText(html: string, options: { base?: string; links?: boolean } = {}): { title?: string; text: string } {
  const title = decodeEntities(/<title\b[^>]{0,200}>([^<]{1,500})/i.exec(html)?.[1] ?? "").replace(CONTROLS, "").replace(/\s+/g, " ").trim() || undefined;
  return { title, text: convert(html, options.base, Boolean(options.links)) };
}
