import assert from "node:assert/strict";
import test from "node:test";
import { isInternal, loadPage, PAGE_CHARS, pageView, type FetchOptions, type Page } from "../extensions/web-search/fetch.ts";
import { decodeEntities, htmlToText } from "../extensions/web-search/html.ts";
import { fetchCall, fetchView } from "../extensions/web-search/view.ts";

const html = (body: string, type = "text/html; charset=utf-8") => new Response(body, { headers: { "content-type": type } });
const publicHost = async () => ["93.184.216.34"];
function serve(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = String(input);
    seen.push(url);
    assert.equal(init.redirect, "manual");
    return routes[url]?.() ?? new Response("missing", { status: 404 });
  }) as typeof fetch;
  const options = (): FetchOptions => ({ fetchImpl, resolve: publicHost, cache: new Map(), allowPrivate: false });
  return { seen, options };
}

test("HTML becomes compact text: main content, headings, lists, code and tables without the page chrome", () => {
  const { title, text } = htmlToText(`<!doctype html><html><head><title>Guide &amp; notes</title><style>p { color: red }</style></head>
    <body><nav><a href="/">Home</a> <a href="/docs">Docs</a></nav>
    <main><h1>Install</h1><p>Run   the <code>setup</code>
    script&nbsp;first. See <a href="/next#top">the next page</a>.</p>
    <ul><li><p>One</p></li><li>Two<ul><li>Nested &lt;item&gt;</li></ul></li><li></li></ul>
    <pre><code class="sh">npm install
  --save   x &amp;&amp; y</code></pre>
    <table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></table>
    <script>track("</p>")</script><!-- a comment --><button>Copy</button><p>Done &#x1F600; &unknown; a < b</p>
    ${"<p>Body text so that the main region is long enough to be used by itself.</p>".repeat(3)}</main>
    <footer>Copyright</footer></body></html>`);
  assert.equal(title, "Guide & notes");
  assert.equal(text.split("\n\nBody text")[0], [
    "# Install", "", "Run the `setup` script first. See the next page.", "", "- One", "- Two", "  - Nested <item>", "",
    "```", "npm install", "  --save   x && y", "```", "", "Name | Value", "a | 1", "", "Done 😀 &unknown; a < b",
  ].join("\n"));
  assert.ok(!/Home|Copyright|track|comment|Copy|color/.test(text));
});

test("links are kept only on request, and a page without a usable main region falls back to the whole document", () => {
  const page = `<body><main><p>Short.</p></main><div>See <a href="../b?x=1&amp;y=2">the <b>B</b> page</a>, <a href="#here">here</a>, <a href="javascript:void(0)">nowhere</a> and <a href="/img"><img src="x.png"></a>.</div></body>`;
  assert.equal(htmlToText(page, { base: "https://example.com/docs/a" }).text, "Short.\n\nSee the B page, here, nowhere and .");
  assert.equal(htmlToText(page, { base: "https://example.com/docs/a", links: true }).text, "Short.\n\nSee [the B page](https://example.com/b?x=1&y=2), here, nowhere and .");
  assert.equal(decodeEntities("&#0; &#xD800; &#65; &AMP; &nbsp;|"), "&#0; &#xD800; A &  |");
});

test("the content region is role=main or the articles when there is no <main>, unless it is an empty shell", () => {
  const body = "<p>Content paragraph that is long enough to stand for a real page body.</p>".repeat(4);
  const text = "Content paragraph that is long enough to stand for a real page body.";
  const menu = "<div class=sidebar><ul><li>Menu one</li><li>Menu two</li></ul></div>";
  assert.ok(htmlToText(`${menu}<div id=content role="main"><div><h2>Title<a class=mark href="#title">#</a></h2>${body}</div></div><div>After</div>`).text.startsWith(`## Title\n\n${text}`));
  assert.ok(!htmlToText(`${menu}<div role=main><div>${body}</div></div><div>After</div>`).text.includes("After"));
  const articles = htmlToText(`${menu}<article>${body}</article><div>Between</div><article>${body}</article><div>After</div>`).text;
  assert.ok(articles.startsWith(text) && articles.includes("Between") && articles.endsWith(text));
  assert.equal(htmlToText(`${menu}<main><div id=app></div></main><div>Rendered elsewhere</div>`).text, "- Menu one\n- Menu two\n\nRendered elsewhere");
});

test("malformed and hostile markup is handled in linear time and never hides ordinary text", () => {
  assert.equal(htmlToText("<p>Before</p><nav>never closed<p>After</p>").text, "Before\n\nnever closed\n\nAfter");
  assert.equal(htmlToText("<p>Before</p><script>never closed <p>hidden</p>").text, "Before");
  assert.equal(htmlToText("<p>Before <a href='x").text, "Before");
  assert.equal(htmlToText("<pre>a\u001b[2J\n\n\n\nb   </pre>x\u0007y").text, "```\na[2J\n\nb\n```\n\nxy");
  const started = performance.now();
  for (const hostile of ["<nav ".repeat(200_000), "<a <".repeat(200_000), "<!--".repeat(200_000), `<pre>${" ".repeat(500_000)}x</pre>`, "<title".repeat(200_000), "&".repeat(500_000), "<b>word</b> next ".repeat(300_000)]) htmlToText(hostile);
  assert.ok(performance.now() - started < 3000, "hostile inputs convert quickly");
  // Output stays proportional to the markup: deep lists stop indenting, and conversion stops once links multiply a long URL.
  const nested = `${"<ul>".repeat(20_000)}${"<li>x".repeat(20_000)}`;
  assert.ok(htmlToText(nested).text.length < nested.length * 4 + 70_000);
  assert.match(htmlToText("<ul><ul><ul><li>deep").text, /^ {4}- deep$/);
  const links = "<a href=?>x</a> ".repeat(30_000);
  const linked = htmlToText(links, { base: `https://example.com/${"p".repeat(8000)}`, links: true }).text;
  assert.ok(linked.length < links.length * 5, "the budget is passed by at most one link");
  assert.match(linked, /\[The rest of this page was not converted/);
});

test("a page is fetched once, converted, and then paged from the cache", async () => {
  const body = `<html><head><title>Long page</title></head><body>${Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i} ${"word ".repeat(12)}</p>`).join("")}</body></html>`;
  const { seen, options } = serve({ "https://example.com/long": () => html(body) });
  const shared = options();
  const page = await loadPage("https://example.com/long#section", shared);
  assert.equal(page.title, "Long page");
  const first = pageView(page);
  assert.match(first, /^Long page\n\nParagraph 0 word/);
  const footer = /\n\n\[chars 0-(\d+) of (\d+); offset=(\d+) continues, find=<term> returns matching passages\]$/.exec(first)!;
  assert.ok(footer && Number(footer[1]) <= PAGE_CHARS && footer[1] === footer[3]);
  assert.ok(first.length < PAGE_CHARS + 120);
  let offset = Number(footer[3]), joined = page.text.slice(0, offset), calls = 1;
  while (offset < page.text.length) {
    const part = pageView(await loadPage("https://example.com/long", shared), { offset });
    const next = /\[chars (\d+)-(\d+) of \d+; offset=\d+ continues/.exec(part);
    const end = next ? Number(next[2]) : page.text.length;
    assert.ok(part.startsWith(page.text.slice(offset, end)));
    joined += page.text.slice(offset, end); offset = end; calls++;
  }
  assert.equal(joined, page.text);
  assert.ok(calls > 2);
  assert.deepEqual(seen, ["https://example.com/long"], "paging does not fetch again");
  assert.throws(() => pageView(page, { offset: page.text.length }), /offset must be between/);
});

test("find returns only the passages around matches, with offsets to read on from", () => {
  const lines = Array.from({ length: 300 }, (_, i) => i % 100 === 50 ? `Line ${i} mentions the Needle here.` : `Line ${i} is filler text for the page.`);
  const page: Page = { url: "https://example.com/", text: lines.join("\n"), clipped: false };
  const found = pageView(page, { find: "needle" });
  assert.match(found, /^3 matches for "needle"; offset=<@n> reads on from a passage\.\n\n\[@\d+\] Line \d+ is filler/);
  assert.equal(found.match(/Needle/g)!.length, 3);
  assert.ok(found.length < 3000, "three short passages, not the page");
  const at = Number(/\[@(\d+)\]/.exec(found)![1]);
  assert.ok(page.text.slice(at).startsWith("Line "), "a passage offset is a line start");
  assert.equal((pageView(page, { find: "needle", offset: page.text.indexOf("Line 60") }).match(/Needle/g) ?? []).length, 2);
  assert.equal(pageView(page, { find: "absent" }), `No "absent" on this page (${page.text.length} chars).`);
  assert.equal(pageView(page, { find: "a.c" }), `No "a.c" on this page (${page.text.length} chars).`);

  // Matches everywhere merge into one passage, which is still held to a page.
  const big: Page = { ...page, text: Array.from({ length: 4 }, () => page.text).join("\n") };
  const dense = pageView(big, { find: "line" });
  assert.ok(dense.length < PAGE_CHARS + 200);
  const next = Number(/\[more matches; offset=(\d+) with the same find continues\]$/.exec(dense)![1]);
  assert.ok(next > 0 && pageView(big, { find: "line", offset: next }).includes(`[@${next}]`));
  // One unbroken line (minified JSON) is cut around the match and marked.
  const flat: Page = { url: "https://example.com/", text: `${"x".repeat(5000)} needle ${"y".repeat(5000)}`, clipped: false };
  assert.match(pageView(flat, { find: "needle" }), /\[@4701\] …x{299} needle y{299}…$/);
});

test("redirects are followed by hand, GitHub file pages go to the raw host, and other content is refused", async () => {
  const { seen, options } = serve({
    "https://example.com/old": () => new Response(null, { status: 302, headers: { location: "/new" } }),
    "https://example.com/new": () => html("# Notes\r\n\r\n\r\n\r\nPlain markdown.  \r\n", "text/markdown"),
    "https://raw.githubusercontent.com/o/r/main/src/a.ts": () => html("export const a = 1;\n", "text/plain"),
    "https://example.com/pdf": () => html("%PDF", "application/pdf"),
    "https://example.com/binary": () => new Response(new Uint8Array([0, 1, 2, 3])),
    "https://example.com/empty": () => html("<html><body><script>render()</script></body></html>"),
    "https://example.com/latin": () => new Response(Buffer.from("<p>caf\xe9</p>", "latin1"), { headers: { "content-type": "text/html; charset=iso-8859-1" } }),
    "https://example.com/loop": () => new Response(null, { status: 301, headers: { location: "/loop" } }),
  });
  assert.deepEqual(await loadPage("https://example.com/old", options()), { url: "https://example.com/new", title: undefined, text: "# Notes\n\nPlain markdown.", clipped: false });
  assert.equal((await loadPage("https://github.com/o/r/blob/main/src/a.ts", options())).text, "export const a = 1;");
  assert.equal((await loadPage("https://example.com/latin", options())).text, "café");
  await assert.rejects(loadPage("https://example.com/pdf", options()), /Cannot read application\/pdf content/);
  await assert.rejects(loadPage("https://example.com/binary", options()), /Cannot read binary content/);
  await assert.rejects(loadPage("https://example.com/empty", options()), /No readable text/);
  await assert.rejects(loadPage("https://example.com/missing", options()), /HTTP 404 from https:\/\/example.com\/missing/);
  await assert.rejects(loadPage("https://example.com/loop", options()), /Too many redirects/);
  await assert.rejects(loadPage("file:///etc/passwd", options()), /absolute http\(s\) URL/);
  await assert.rejects(loadPage("https://user:secret@example.com/", options()), /credentials/);
  assert.equal(seen.filter((url) => url.endsWith("/loop")).length, 6);
});

test("local and private addresses are refused, including by name and through a redirect", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.0.1", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) assert.ok(isInternal(address), address);
  for (const address of ["93.184.216.34", "172.32.0.1", "2606:4700::1111"]) assert.ok(!isInternal(address), address);
  const { seen, options } = serve({
    "https://example.com/hop": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } }),
    "http://127.0.0.1:8080/admin": () => html("<p>secret</p>"),
    "http://intranet.example/": () => html("<p>secret</p>"),
  });
  const names = async (host: string) => host === "intranet.example" ? ["93.184.216.34", "10.0.0.5"] : ["93.184.216.34"];
  for (const url of ["http://127.0.0.1:8080/admin", "http://[::1]/", "http://2130706433/", "http://intranet.example/", "https://example.com/hop"]) {
    await assert.rejects(loadPage(url, { ...options(), resolve: names }), /local or private address/, url);
  }
  assert.deepEqual(seen, ["https://example.com/hop"], "nothing private was requested");
  assert.equal((await loadPage("http://127.0.0.1:8080/admin", { ...options(), allowPrivate: true })).text, "secret");
});

test("cancellation and a stalled server end the fetch", async () => {
  const stalled = ((_input: any, init: any) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))) as typeof fetch;
  const controller = new AbortController();
  const pending = loadPage("https://example.com/", { fetchImpl: stalled, resolve: publicHost, cache: new Map(), signal: controller.signal });
  controller.abort(new Error("cancelled test"));
  await assert.rejects(pending, /cancelled test/);
  await assert.rejects(loadPage("https://example.com/", { fetchImpl: stalled, resolve: () => new Promise(() => {}), cache: new Map(), signal: AbortSignal.timeout(20) }), /Timeout|aborted/i);
});

test("fetch views summarize the page and escape its text", () => {
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
  const result = { content: [{ type: "text", text: "One\n\nTwo\nThree\nFour\u001b[2J" }], details: { url: "https://example.com/", title: "A page", chars: 48211 } };
  assert.equal(fetchView(result, theme, { hint: "alt+x to expand" }), "A page · 48,211 chars\nOne\nTwo\nThree\n1 more lines\nalt+x to expand");
  assert.ok(fetchView(result, theme, { expanded: true }).endsWith("Four\\u001b[2J"));
  assert.equal(fetchView({ content: [{ type: "text", text: "HTTP 404 from https://example.com/x" }] }, theme, { isError: true }), "HTTP 404 from https://example.com/x");
  assert.equal(fetchCall({ url: "https://example.com/docs", find: "install", offset: 12000 }, theme), 'web_fetch https://example.com/docs · find "install" · from 12000');
});
