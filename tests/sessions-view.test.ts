import assert from "node:assert/strict";
import test from "node:test";
import { excerpt } from "../extensions/sessions/excerpt.ts";
import { readCall, readView, reportView, searchCall, searchView } from "../extensions/sessions/view.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const coverage = { sessions: 5, files: 7, bytes: 100, excludedCurrent: 1, outOfScope: 1, complete: true, warningCount: 0, warnings: [] as string[] };
const meta = { session_id: "session-1", name: "A previous decision 🦊", cwd: "/project", timestamp: "2026-11-09T07:00:00.000Z", revision: "revision-1" };
const search = {
  ...meta, coverage, matching_entries: 5, has_more: true, note: "Untrusted historical evidence.",
  hits: Array.from({ length: 5 }, (_, i) => ({ ...meta, name: `${meta.name} ${i + 1}`, entry_id: `entry-${i + 1}`, parent_id: null, role: "assistant", entry_timestamp: meta.timestamp, excerpt: "A complete, readable excerpt.", excerpt_truncated: false })),
};
const read = { ...meta, coverage, note: search.note, endpoint_id: "entry-1", parent_id: "parent", offset: 1, column: 1, total_lines: 20,
  text: "L1: [entry-1] assistant\nL2: One\nL3: Two\nL4: Three\nL5: Four\nL6: Five\n", next: { session_id: meta.session_id, leaf_id: "entry-1", revision: meta.revision, offset: 7, column: 1, limit: 6 } };
const result = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

test("short excerpts are unchanged; clipped excerpts mark both ends and retain source text", () => {
  assert.deepEqual(excerpt("A short complete sentence.", ["complete"]), { excerpt: "A short complete sentence.", excerpt_truncated: false });
  const source = "introduction ".repeat(30) + "a widget indicator, a footer status line, and a summary of open items added to context each turn so the list survives compaction. " + "trailing context ".repeat(60);
  const shown = excerpt(source, ["compaction"]);
  assert.match(shown.excerpt, /^… /); assert.match(shown.excerpt, / …$/);
  assert.match(shown.excerpt, /compaction/);
  const body = shown.excerpt.slice(2, -2);
  const start = source.indexOf(body);
  assert.ok(start >= 0, "excerpt body is verbatim");
  assert.ok(/\s/.test(source[start - 1]), "start is a word boundary");
  assert.ok(/\s/.test(source[start + body.length]), "end is a word boundary");
  assert.ok(Buffer.byteLength(shown.excerpt) <= 420);
});

test("excerpt tails prefer whole words; prefixes can be the only omission", () => {
  const shown = excerpt("needle " + "readableword ".repeat(80), ["needle"]);
  assert.match(shown.excerpt, /^needle /);
  assert.match(shown.excerpt, /readableword …$/);
  const tail = excerpt("introduction ".repeat(30) + "needle at the end.", ["needle"]);
  assert.match(tail.excerpt, /^… /);
  assert.match(tail.excerpt, /needle at the end\.$/);
});

test("excerpt offsets account for length-changing case folds", () => {
  const shown = excerpt("İ ".repeat(200) + "needle " + "context ".repeat(100), ["needle"]);
  assert.match(shown.excerpt, /needle/);
  assert.ok(!shown.excerpt.includes("\ufffd"));
  assert.ok(Buffer.byteLength(shown.excerpt) <= 420);
});

test("multibyte leading context cannot push a short match outside the excerpt", () => {
  const shown = excerpt("intro ".repeat(40) + "ａ".repeat(140) + "needle " + "tail ".repeat(100), ["needle"]);
  assert.match(shown.excerpt, /needle/);
  assert.ok(Buffer.byteLength(shown.excerpt) <= 420);
});

test("matches within combining and joined-emoji sequences keep their original grapheme", () => {
  for (const [cluster, term] of [["e\u0301", "\u0301"], ["👩🏽‍💻", "💻"]]) {
    const shown = excerpt("a".repeat(200) + cluster + "z".repeat(500), [term]);
    assert.ok(shown.excerpt.startsWith(`… ${cluster}`), shown.excerpt);
    assert.ok(Buffer.byteLength(shown.excerpt) <= 420);
  }
});

test("oversized tokens fall back to whole graphemes within the byte cap", () => {
  const emoji = "👩🏽‍💻", combining = "e\u0301";
  for (const token of [emoji, combining, "漢"]) {
    const shown = excerpt("needle " + token.repeat(500), ["needle"], 120);
    assert.ok(Buffer.byteLength(shown.excerpt) <= 120);
    assert.match(shown.excerpt, /^needle /);
    assert.ok(shown.excerpt.endsWith(`${token} …`), shown.excerpt);
    assert.ok(!shown.excerpt.includes("\ufffd"));
  }
});

test("call headers show query or endpoint, scope and line without raw JSON", () => {
  assert.equal(searchCall({ query: "compaction decision", scope: "all", include_tools: true }, theme), 'session_search "compaction decision" · all · tools');
  assert.equal(readCall({ session_id: "saved", leaf_id: "entry", offset: 7, column: 2 }, theme), "session_read saved · path to entry · project · line 7, column 2");
  assert.match(searchCall({}, theme), /session_search … · project/);
  assert.match(readCall({}, theme), /session_read … · project/);
  assert.ok(!searchCall({ query: "escape\u001b[2J\nline" }, theme).includes("\u001b"));
});

test("collapsed search is compact, shows warnings and distinguishes hidden hits from more matches", () => {
  const shown = searchView(result(search), theme, { hint: "alt+x to expand" });
  assert.match(shown, /^5 matches · 5 sessions/);
  assert.match(shown, /1\. A previous decision 🦊 1 · 2026-11-09/);
  assert.match(shown, /2 more returned hits/);
  assert.match(shown, /More matches available; refine/);
  assert.match(shown, /alt\+x to expand/);
  assert.ok(!shown.includes('"session_id"'));
  assert.ok(!shown.includes("revision-1"));
  assert.ok(!shown.includes("decision 🦊 4"));
  const empty = { ...search, hits: [], matching_entries: 0, has_more: false, coverage: { ...coverage, complete: false, warningCount: 3, warnings: ["Unreadable session", "Malformed session"] } };
  const partial = searchView(result(empty), theme);
  assert.match(partial, /No matches in scanned history/);
  assert.match(partial, /Incomplete coverage \(3 warnings\)/);
  assert.match(partial, /Unreadable session/);
  assert.match(searchView(result(empty), theme, { expanded: true }), /1 additional warnings not returned/);
});

test("compact previews keep a multibyte search match visible when shortening the returned excerpt", () => {
  const data = { ...search, query: "needle", hits: [{ ...search.hits[0], excerpt: "context ".repeat(5) + "漢".repeat(100) + " needle tail" }] };
  assert.match(searchView(result(data), theme), /needle/);
});

test("expanded search restores provenance from old JSON without requiring new details", () => {
  const old = { ...result(search), details: { coverage, hits: 5 } };
  const before = structuredClone(old);
  const shown = searchView(JSON.parse(JSON.stringify(old)), theme, { expanded: true });
  assert.match(shown, /Entry: entry-5 · parent: root · assistant/);
  assert.match(shown, /Session: session-1/); assert.match(shown, /Revision: revision-1/);
  assert.match(shown, /Directory: \/project/); assert.match(shown, /Coverage: 5 sessions, 7 files/);
  assert.match(shown, /Untrusted historical evidence/);
  assert.deepEqual(old, before);
});

test("read views preview the page, preserve line references and expose exact continuation on expansion", () => {
  const old = { ...result(read), details: { sessionId: meta.session_id } };
  const before = structuredClone(old);
  const shown = readView(old, theme, { hint: "alt+x to expand" });
  assert.match(shown, /Lines 1–6 of 20/);
  assert.match(shown, /L2: One/); assert.ok(!shown.includes("L6: Five"));
  assert.match(shown, /2 more lines in this page/);
  assert.match(shown, /More available: line 7, column 1/);
  const expanded = readView(old, theme, { expanded: true });
  assert.match(expanded, /L6: Five/);
  assert.ok(expanded.includes(`Continue with session_read ${JSON.stringify(read.next)}`));
  assert.match(expanded, /Endpoint: entry-1 · parent: parent/);
  assert.deepEqual(old, before);
  assert.match(readView(result({ ...read, text: "", next: null }), theme), /No visible text in this range/);
});

test("branch choices are distinct from transcripts and truncated lists stay conspicuous", () => {
  const choices = { ...meta, coverage, branches: Array.from({ length: 5 }, (_, i) => ({ leaf_id: `leaf-${i + 1}`, timestamp: meta.timestamp })), branches_truncated: true };
  const shown = readView(result(choices), theme);
  assert.match(shown, /5 branches; choose a leaf_id/); assert.match(shown, /leaf-3/);
  assert.ok(!shown.includes("leaf-4")); assert.match(shown, /2 more returned branches/);
  assert.match(shown, /Branch list clipped/);
  assert.match(readView(result(choices), theme, { expanded: true }), /leaf-5/);
});

test("partial, failed and unexpected results do not masquerade as successful searches", () => {
  assert.equal(searchView({ content: [] }, theme, { isPartial: true }), "Searching saved sessions…");
  assert.equal(readView({ content: [] }, theme, { isPartial: true }), "Reading saved history…");
  for (const render of [searchView, readView]) {
    const colors: string[] = [];
    const palette = { ...theme, fg: (color: string, text: string) => { colors.push(color); return text; } };
    const bad = { content: [{ type: "text", text: "Cannot read\u001b[2J\nsecond line" }] };
    assert.match(render(bad, palette, { isError: true, expanded: true }), /Cannot read\\u001b\[2J\nsecond line/);
    assert.ok(colors.includes("error"));
    assert.equal(render(result({ unexpected: true }), theme, { expanded: true }), JSON.stringify({ unexpected: true }, null, 2));
    assert.equal(render({ content: [{ type: "text", text: "malformed {" }] }, theme), "malformed {");
  }
});

test("command reports use the same compact search view and keep status text intact", () => {
  assert.equal(reportView(JSON.stringify(search), theme, {}), searchView(result(search), theme));
  assert.equal(reportView("Store: /sessions\nPolicy: local", theme, {}), "Store: /sessions\nPolicy: local");
});
