import assert from "node:assert/strict";
import test from "node:test";
import { cleanup, pngSize, rasterize, supported } from "../extensions/figure/raster.ts";
import { fit, onCanvas, prepare, tokens, type Palette } from "../extensions/figure/svg.ts";

const palette = Object.fromEntries(tokens.map((token, i) => [token, `#0000${String(i).padStart(2, "0")}`])) as Palette;
const svg = (body: string, root = 'viewBox="0 0 640 360"') => `<svg xmlns="http://www.w3.org/2000/svg" ${root}>${body}</svg>`;

test("prepare themes colors and sizes the root from its viewBox", () => {
  const { svg: out, width, height } = prepare(svg('<rect fill="var(--accent)" stroke="var(--nope, #123456)" style="fill: var(--surface)"/>', 'viewBox="0 0 640.4 360" width="100%" color="red"'), palette);
  assert.deepEqual([width, height], [640, 360]);
  assert.match(out, /^<svg width="640" height="360" color="#000000" preserveAspectRatio="xMinYMin meet" xmlns=/);
  assert.doesNotMatch(out, /100%|color="red"/);
  assert.match(out, new RegExp(`fill="${palette.accent}" stroke="#123456" style="fill: ${palette.surface}"`));
  // Without a viewBox, width and height define one.
  assert.match(prepare('<svg width="200" height="100"><g/></svg>', palette).svg, /^<svg width="200" height="100" color="#000000" preserveAspectRatio="xMinYMin meet" xmlns="[^"]+" viewBox="0 0 200 100"/);
});

test("prepare rewrites font features CoreSVG ignores", () => {
  const { svg: out } = prepare(svg(`<text font-family="'SF Mono', Menlo, monospace" font-weight="bold">a</text><text style="font-family: system-ui, sans-serif; font-weight: bold">b</text><text font-family="Inter, sans-serif">c</text>`), palette);
  assert.match(out, /font-family="Menlo" font-weight="700"/);
  assert.match(out, /style="font-family: Helvetica Neue; font-weight: 700"/);
  assert.match(out, /font-family="Inter"/);
});

test("prepare rejects figures CoreSVG cannot draw or that reach outside", () => {
  const rejects = (source: string, pattern: RegExp) => assert.throws(() => prepare(source, palette), pattern);
  rejects("<div/>", /Expected an <svg>/);
  rejects('<svg viewBox="0 0 10 10"><rect/>', /must end with <\/svg>/);
  rejects("<svg><rect/></svg>", /viewBox/);
  rejects(svg("", 'viewBox="0 0 5000 10"'), /at most 4000/);
  rejects(svg('<rect fill="var(--bg)"/>'), /Unknown color var\(--bg\)\. Use --fg/);
  rejects(svg("<style>.a{}</style>"), /ignores <style>/);
  rejects(svg("<script>x()</script>"), /remove <script>/);
  rejects(svg('<rect onclick="x()"/>'), /event handler/);
  rejects(svg('<animate attributeName="x"/>'), /animation/);
  rejects(svg("<foreignObject/>"), /foreignObject/);
  rejects(svg('<image href="file:///etc/passwd"/>'), /external link file:/);
  rejects(svg('<rect fill="url(http://x/y)"/>'), /url\(\) may only/);
  rejects(`<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${svg("")}`, /DOCTYPE/);
  // Local references and embedded images are fine.
  prepare(svg(`<defs><linearGradient id="g"/></defs><rect fill="url('#g')"/><use href="#g"/><image href="data:image/png;base64,AA"/>`), palette);
});

test("prepare reads attributes from markup only, so labels may say anything", () => {
  const labels = ['Users online = 42', 'gap: var(--gap); image: url(logo.png)', 'link with href="/docs" > here', "font-family = 'serif'"];
  const { svg: out } = prepare(svg(labels.map((label) => `<text fill="var(--fg)">${label}</text>`).join("")), palette);
  for (const label of labels) assert.ok(out.includes(`<text fill="${palette.fg}">${label}</text>`), label);

  const rejects = (source: string, pattern: RegExp) => assert.throws(() => prepare(source, palette), pattern);
  // A ">" inside a quoted value does not end the tag, and one inside a comment does not hide what follows.
  rejects(svg('<text data-note="a > b" onclick="x()">t</text>'), /event handler/);
  rejects(svg(`<text data-note='>' fill="url(http://x/y)">t</text>`), /url\(\) may only/);
  rejects(svg('<!-- " --><rect data-note=">" onclick="x()"/><!-- " -->'), /event handler/);
  rejects(svg('<!--><image href="http://x/y.png"/><!-- -->'), /external link http:/);
  rejects(svg('<![CDATA[ x < y ]]><image href="http://x/y.png"/>'), /external link http:/);
  // Whatever cannot be told apart from a tag is refused, not passed over as text.
  rejects(svg("<text>a < b</text>"), /Could not read the SVG at "< b<\/text>.*&lt;/);
  rejects(svg('<rect data-note="a<b" onclick="x()"/>'), /Could not read the SVG at "<rect data-note/);
  rejects(svg(`<rect fill="red' onclick="x()"/>`), /event handler|Could not read/);
  rejects(svg("<!-- never closed <rect/>"), /Could not read the SVG at "<!-- never closed/);
  prepare(svg("<!-- a > b, and <rect/> commented out --><text>a &lt; b &gt; c</text><![CDATA[ x < y ]]>"), palette);
});

test("prepare rewrites a style that runs over several lines", () => {
  const { svg: out } = prepare(svg('<text style="font-family: system-ui, sans-serif;\n  font-weight: bold;\n  fill: var(--accent)">a</text>'), palette);
  assert.match(out, new RegExp(`style="font-family: Helvetica Neue;\n  font-weight: 700;\n  fill: ${palette.accent}"`));
});

test("fit sizes figures in whole cells of the terminal's real shape", () => {
  const rex = { widthPx: 14, heightPx: 31 }, small = { widthPx: 8, heightPx: 16 };
  const figure = { width: 640, height: 320 };
  // Natural width is 80 columns; rows follow the cell shape, not a fixed 1:2.
  assert.deepEqual(fit(figure, small, { cols: 120, rows: 60 }, false), { cols: 80, rows: 20, shrunk: false, canvas: { width: 1280, height: 640 } });
  assert.deepEqual(fit(figure, rex, { cols: 120, rows: 60 }, false), { cols: 80, rows: 19, shrunk: false, canvas: { width: 1120, height: 589 } });
  // Narrow panes and short viewports shrink it; expanding grows it into the room.
  assert.equal(fit(figure, rex, { cols: 40, rows: 60 }, false).cols, 40);
  assert.deepEqual(fit(figure, rex, { cols: 120, rows: 20 }, false), { cols: 53, rows: 12, shrunk: true, canvas: { width: 742, height: 372 } });
  assert.deepEqual(fit(figure, rex, { cols: 120, rows: 60 }, true).cols, 120);
  // The canvas never exceeds the rasterizer's limit.
  const huge = fit({ width: 4000, height: 4000 }, { widthPx: 30, heightPx: 60 }, { cols: 500, rows: 500 }, true).canvas;
  assert.ok(huge.width <= 4096 && huge.height <= 4096);
  // The prepared SVG moves onto the canvas with its drawing fitted, not stretched.
  const prepared = prepare(svg("<g/>"), palette);
  assert.match(onCanvas(prepared, 1120, 589), /^<svg width="1120" height="589" color="#000000" preserveAspectRatio="xMinYMin meet"/);
});

test("rasterize draws through sips, sized and cached, and reports parse errors", { skip: !supported }, async (t) => {
  t.after(cleanup);
  const { svg: out } = prepare(svg('<rect width="640" height="360" fill="var(--accent)"/>'), palette);
  const first = await rasterize(onCanvas(prepare(out, palette), 800, 600));
  assert.deepEqual([first.width, first.height], [800, 600]);
  assert.deepEqual(pngSize(Buffer.from(first.data, "base64")), { width: 800, height: 600 });
  assert.equal(await rasterize(onCanvas(prepare(out, palette), 800, 600)), first);
  await assert.rejects(rasterize('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect</svg>'), /CoreSVG could not draw the SVG: .*parser error/);
});
