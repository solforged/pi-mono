// Checks a model-drawn SVG and rewrites it for macOS CoreSVG: theme tokens
// become concrete colors, the root gets the viewBox as its intrinsic size, and
// font features CoreSVG ignores are spelled in forms it honours. Also sizes
// figures in whole terminal cells.

export const tokens = ["fg", "muted", "dim", "border", "surface", "accent", "success", "warning", "error", "c1", "c2", "c3", "c4", "c5", "c6"] as const;
export type Palette = Record<(typeof tokens)[number], string>;
export type Prepared = { svg: string; width: number; height: number };

export const limits = { chars: 200_000, edge: 4000 };

// A terminal column spans 8 SVG units, so font-size 14 reads near the terminal's own text.
const unitsPerCol = 8;
const viewport = { collapsed: 0.6, expanded: 0.9 };
const maxCanvas = 4096;

export type Cell = { widthPx: number; heightPx: number };

/**
 * Cells a figure occupies, and the pixel canvas that fills them exactly: its
 * natural width, shrunk to the room available and grown only when expanded,
 * with rows following from the terminal's real cell shape. The terminal
 * stretches an image over whole cells, so the canvas matches them and the
 * drawing is fitted inside it rather than stretched.
 */
export function fit(figure: { width: number; height: number }, cell: Cell, room: { cols: number; rows: number }, expanded: boolean) {
  const natural = Math.ceil(figure.width / unitsPerCol);
  const maxCols = Math.max(1, room.cols);
  const maxRows = Math.max(4, Math.floor(room.rows * (expanded ? viewport.expanded : viewport.collapsed)));
  const rowsFor = (cols: number) => Math.max(1, Math.ceil((cols * cell.widthPx * figure.height) / (figure.width * cell.heightPx)));
  let cols = expanded ? maxCols : Math.min(natural, maxCols);
  if (rowsFor(cols) > maxRows) cols = Math.max(1, Math.floor((maxRows * cell.heightPx * figure.width) / (figure.height * cell.widthPx)));
  const rows = Math.min(maxRows, rowsFor(cols));
  // Draw at least ~28 px per row so text stays sharp; stay inside the rasterizer's limit.
  const density = Math.min(Math.max(1, Math.ceil(28 / cell.heightPx)), maxCanvas / (cols * cell.widthPx), maxCanvas / (rows * cell.heightPx));
  return {
    cols, rows, shrunk: cols < natural,
    canvas: { width: Math.round(cols * cell.widthPx * density), height: Math.round(rows * cell.heightPx * density) },
  };
}

/** The prepared SVG drawn onto a `width`×`height` canvas, scaled to fit at its top left. */
export function onCanvas(figure: Prepared, width: number, height: number) {
  const head = `<svg width="${figure.width}" height="${figure.height}" `;
  if (!figure.svg.startsWith(head)) throw new Error("Not a prepared figure");
  return `<svg width="${width}" height="${height}" ${figure.svg.slice(head.length)}`;
}

// CoreSVG takes only the first family of a list and knows no generic names.
const generic: Record<string, string> = {
  monospace: "Menlo", "ui-monospace": "Menlo", "sf mono": "Menlo", sfmono: "Menlo", "sfmono-regular": "Menlo",
  "sans-serif": "Helvetica Neue", "system-ui": "Helvetica Neue", "ui-sans-serif": "Helvetica Neue",
  "-apple-system": "Helvetica Neue", blinkmacsystemfont: "Helvetica Neue",
  serif: "Times New Roman", "ui-serif": "Times New Roman",
};
// CoreSVG ignores keyword weights but honours numeric ones.
const weights: Record<string, string> = { normal: "400", bold: "700", bolder: "700", lighter: "300" };

const fail = (message: string): never => { throw new Error(message); };

function family(value: string) {
  const first = value.split(",")[0].trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  return generic[first.toLowerCase()] ?? first;
}

function themed(value: string, palette: Palette) {
  return value.replace(/var\(\s*--([\w-]+)\s*(?:,\s*([^()]*?))?\s*\)/g, (_match, name: string, fallback?: string) => {
    if (name in palette) return palette[name as keyof Palette];
    return fallback || fail(`Unknown color var(--${name}). Use ${tokens.map((token) => `--${token}`).join(", ")}.`);
  });
}

function styleDeclarations(style: string) {
  return style
    .replace(/(font-family\s*:\s*)([^;]+)/gi, (_m, head: string, value: string) => `${head}${family(value)}`)
    .replace(/(font-weight\s*:\s*)(normal|bold|bolder|lighter)\b/gi, (_m, head: string, value: string) => `${head}${weights[value.toLowerCase()]}`);
}

export function prepare(source: string, palette: Palette): Prepared {
  const text = source.trim();
  if (text.length > limits.chars) fail(`The SVG is ${text.length} characters; the limit is ${limits.chars}.`);
  const root = /<svg\b[^>]*>/i.exec(text) ?? fail("Expected an <svg> element.");
  if (!/<\/svg\s*>\s*$/i.test(text) && !/\/>\s*$/.test(root[0])) fail("The SVG must end with </svg>.");
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail("Remove the DOCTYPE; figures must be self-contained.");
  if (/<script\b/i.test(text)) fail("Figures are static: remove <script>.");
  if (/<foreignObject\b/i.test(text)) fail("CoreSVG cannot draw <foreignObject>; use SVG text and shapes.");
  if (/<style\b/i.test(text)) fail("CoreSVG ignores <style>; use presentation attributes or style=\"…\" on elements.");
  if (/\son[a-z]+\s*=/i.test(text)) fail("Figures are static: remove event handler attributes.");
  if (/<(animate|animateMotion|animateTransform|set)\b/i.test(text)) fail("Figures are static: remove animation elements.");
  for (const [, link] of text.matchAll(/\bhref\s*=\s*["']\s*([^"']*)/gi)) {
    if (!link.startsWith("#") && !/^data:image\//i.test(link)) fail(`Figures must be self-contained: remove the external link ${link.slice(0, 80)}.`);
  }
  if (/url\(\s*(?!["']?#)/i.test(text)) fail("Figures must be self-contained: url() may only point at #ids.");

  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(root[0])?.[2];
  const box = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  let width = box?.length === 4 ? box[2] : Number.parseFloat(attr("width") ?? "");
  let height = box?.length === 4 ? box[3] : Number.parseFloat(attr("height") ?? "");
  if (!(width > 0 && height > 0)) fail("Give the root <svg> a viewBox, for example viewBox=\"0 0 640 360\".");
  if (width > limits.edge || height > limits.edge) fail(`The viewBox is ${width}×${height}; keep each side at most ${limits.edge}.`);
  width = Math.round(width); height = Math.round(height);

  // The root's own size, color and namespace are ours to set.
  let head = root[0].replace(/\s(width|height|color|preserveAspectRatio)\s*=\s*(["']).*?\2/gi, "");
  if (!box || box.length !== 4) head = head.replace(/^<svg\b/i, `<svg viewBox="0 0 ${width} ${height}"`);
  if (!/\sxmlns\s*=/.test(head)) head = head.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  head = head.replace(/^<svg\b/i, `<svg width="${width}" height="${height}" color="${palette.fg}" preserveAspectRatio="xMinYMin meet"`);

  // Anything before the root (an XML declaration, comments) is dropped.
  let svg = head + text.slice(root.index + root[0].length);
  svg = themed(svg, palette)
    .replace(/(\sfont-family\s*=\s*)(["'])(.*?)\2/gi, (_m, lead: string, quote: string, value: string) => `${lead}${quote}${family(value.replace(/&quot;/g, '"'))}${quote}`)
    .replace(/(\sfont-weight\s*=\s*)(["'])(normal|bold|bolder|lighter)\2/gi, (_m, lead: string, quote: string, value: string) => `${lead}${quote}${weights[value.toLowerCase()]}${quote}`)
    .replace(/(\sstyle\s*=\s*)(["'])(.*?)\2/gi, (_m, lead: string, quote: string, value: string) => `${lead}${quote}${styleDeclarations(value)}${quote}`);
  return { svg, width, height };
}
