import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { LIMITS, newCoverage, parseDocument, readSession, searchSessions, storageRoots, type Context } from "../extensions/sessions/store.ts";
import { root, temporary } from "./helpers.ts";

const date = "2026-01-01T00:00:00.000Z";
function entry(id: string, parentId: string | null, content: any, role = "user", extra: any = {}) {
  return { type: "message", id, parentId, timestamp: date, message: { role, content, ...extra } };
}
function source(id: string, cwd: string, entries: any[] = [entry("a", null, "The alpha decision used SQLite.")], version = 3) {
  return [JSON.stringify({ type: "session", version, id, cwd, timestamp: date }), ...entries.map(e => JSON.stringify(e))].join("\n") + "\n";
}
async function setup(t: any) {
  const dir = await temporary(t), agentDir = join(dir, "agent"), cwd = join(dir, "project"), sessionDir = join(agentDir, "sessions", "--project--");
  await mkdir(sessionDir, { recursive: true }); await mkdir(cwd);
  const ctx: Context = { agentDir, cwd, sessionDir, currentId: "current" };
  async function save(id = "past", entries?: any[], options: { cwd?: string; directory?: string; filename?: string; version?: number } = {}) {
    const directory = options.directory ?? sessionDir;
    await mkdir(directory, { recursive: true });
    const path = join(directory, options.filename ?? `${id}.jsonl`);
    await writeFile(path, source(id, options.cwd ?? cwd, entries, options.version));
    return path;
  }
  return { ctx, save, dir };
}

test("project search uses header cwd, AND terms and phrases, and stable entry references", async t => {
  const { ctx, save } = await setup(t);
  await save("past", [entry("a", null, "Alpha sqlite decision"), entry("b", "a", "alpha not enough"), entry("c", "b", "Used an ALPHA SQLite decision again", "assistant")]);
  await save("other", undefined, { cwd: join(ctx.cwd, "subdir") });
  const result = await searchSessions(ctx, { query: 'alpha "SQLite decision"' });
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[0].session_id, "past");
  assert.equal(result.hits[0].entry_id, "a");
  assert.equal(result.hits[1].parent_id, "b");
  assert.equal(result.coverage.outOfScope, 1);
  assert.equal(result.coverage.complete, true);
  assert.equal((await searchSessions(ctx, { query: "alpha", scope: "all" })).hits.length, 4);
});

test("all scope discovers other default projects; active custom directory stays flat", async t => {
  const { ctx, save, dir } = await setup(t);
  await save();
  await save("other", undefined, { cwd: dir, directory: join(ctx.agentDir, "sessions", "--other--") });
  const custom = join(dir, "custom");
  await save("custom", undefined, { directory: custom });
  await save("nested", undefined, { directory: join(custom, "nested") });
  const result = await searchSessions({ ...ctx, sessionDir: custom }, { query: "alpha", scope: "all" });
  assert.deepEqual(result.hits.map(h => h.session_id).sort(), ["custom", "other", "past"]);
  assert.equal(result.coverage.files, 3);
});

test("ephemeral managers with no session directory do not authorize the process working directory", async t => {
  const { ctx, save } = await setup(t); await save();
  const ephemeral = { ...ctx, sessionDir: "", currentId: undefined };
  assert.deepEqual(storageRoots(ephemeral), [{ path: join(ctx.agentDir, "sessions"), depth: 1 }]);
  assert.equal((await searchSessions(ephemeral, { query: "alpha" })).hits.length, 1);
});

test("canonical cwd aliases match but directory prefixes do not", async t => {
  const { ctx, save, dir } = await setup(t);
  const alias = join(dir, "alias"); await symlink(ctx.cwd, alias);
  await save("alias", undefined, { cwd: alias });
  await save("prefix", undefined, { cwd: `${ctx.cwd}-other` });
  assert.deepEqual((await searchSessions(ctx, { query: "alpha" })).hits.map(h => h.session_id), ["alias"]);
});

test("active session excluded by ID and file; ephemeral callers can search saved history", async t => {
  const { ctx, save } = await setup(t);
  await save("current"); const path = await save("renamed"); await save();
  const result = await searchSessions({ ...ctx, currentFile: path }, { query: "alpha" });
  assert.equal(result.coverage.excludedCurrent, 2);
  assert.deepEqual(result.hits.map(h => h.session_id), ["past"]);
  await assert.rejects(readSession(ctx, { session_id: "current" }), /active session is excluded/);
  assert.equal((await searchSessions({ ...ctx, currentId: undefined }, { query: "alpha" })).hits.length, 3);
});

test("text extraction excludes private payloads, summaries and retrieval recursion; tools are opt-in", async t => {
  const { ctx, save } = await setup(t);
  await save("past", [
    entry("a", null, [{ type: "thinking", thinking: "private-needle" }, { type: "image", data: "image-needle" }, { type: "text", text: "public-needle" }, { type: "toolCall", name: "bash", arguments: { command: "command-needle" } }, { type: "toolCall", name: "session_search", arguments: { query: "recursive-needle" } }], "assistant"),
    entry("b", "a", [{ type: "text", text: "result-needle" }], "toolResult", { toolName: "bash" }),
    entry("c", "b", [{ type: "text", text: "recursive-needle" }], "toolResult", { toolName: "session_read" }),
    entry("d", "c", "system-needle", "system"),
    { type: "compaction", id: "e", parentId: "d", timestamp: date, summary: "summary-needle", firstKeptEntryId: "b" },
    { type: "context_edit", id: "f", parentId: "e", targetId: "a", replacement: null },
    entry("g", "f", "custom-needle", "custom"),
    entry("h", "g", undefined, "bashExecution", { command: "echo shell-needle", output: "shell-output" }),
  ]);
  for (const query of ["private-needle", "image-needle", "recursive-needle", "system-needle", "summary-needle", "custom-needle"]) assert.equal((await searchSessions(ctx, { query, include_tools: true })).hits.length, 0, query);
  assert.equal((await searchSessions(ctx, { query: "public-needle" })).hits.length, 1);
  for (const query of ["command-needle", "result-needle", "shell-needle"]) {
    assert.equal((await searchSessions(ctx, { query })).hits.length, 0);
    assert.equal((await searchSessions(ctx, { query, include_tools: true })).hits.length, 1);
  }
  const read = await readSession(ctx, { session_id: "past", leaf_id: "h", include_tools: true });
  assert.ok("text" in read);
  assert.match(read.text, /public-needle/);
  assert.ok(!read.text.includes("private-needle")); assert.ok(!read.text.includes("recursive-needle"));
});

test("branches are never concatenated; endpoint ancestry includes original pre-compaction text", async t => {
  const { ctx, save } = await setup(t);
  await save("past", [entry("a", null, "root"), entry("b", "a", "left branch"), entry("c", "a", "right branch"), { type: "compaction", id: "d", parentId: "c", timestamp: date, summary: "summary", firstKeptEntryId: "c" }, entry("e", "d", "right end")]);
  const choices = await readSession(ctx, { session_id: "past" });
  assert.ok("branches" in choices); assert.deepEqual(choices.branches.map(b => b.leaf_id), ["b", "e"]);
  const branch = await readSession(ctx, { session_id: "past", leaf_id: "e" });
  assert.ok("text" in branch); assert.match(branch.text, /root/); assert.match(branch.text, /right end/); assert.ok(!branch.text.includes("left branch"));
  const single = await readSession(ctx, { session_id: "past", entry_id: "c" });
  assert.ok("text" in single); assert.match(single.text, /right branch/); assert.ok(!single.text.includes("root"));
  assert.equal(single.parent_id, "a");
  await assert.rejects(readSession(ctx, { session_id: "past", entry_id: "c", leaf_id: "e" }), /not both/);
});

test("branch-choice responses also respect the complete encoded byte limit", async t => {
  const { ctx, save } = await setup(t);
  await save("past", Array.from({ length: 30 }, (_, i) => entry(`${i}${"🙂".repeat(60)}`, null, "branch")));
  const choices = await readSession(ctx, { session_id: "past" });
  assert.ok("branches" in choices);
  assert.equal(choices.branches_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(choices, null, 2)) <= LIMITS.outputBytes);
});

test("multiple roots and branch_summary fromId do not become ancestry edges", () => {
  const doc = parseDocument(source("id", "/project", [entry("a", null, "one"), entry("b", null, "two"), { type: "branch_summary", id: "c", parentId: "b", fromId: "a", summary: "one summary", timestamp: date }]));
  assert.deepEqual(doc.leaves.map(e => e.id), ["a", "c"]);
});

test("line and Unicode-column continuation recover every character within the encoded response budget", async t => {
  const { ctx, save } = await setup(t);
  const body = '🙂é"\\'.repeat(5000) + "\nlast\n";
  await save("past", [entry("a", null, body)]);
  let args: any = { session_id: "past", entry_id: "a", limit: 1 }, restored = "";
  for (let i = 0; i < 100; i++) {
    const page = await readSession(ctx, args);
    assert.ok("text" in page);
    assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2)) <= LIMITS.outputBytes);
    assert.ok(!page.text.includes("\ufffd"));
    const rendered = page.text.split("\n").filter(line => line.startsWith("L"));
    for (const line of rendered) {
      const match = /^L(\d+)(?: \(column \d+\))?: (.*)$/.exec(line)!;
      if (Number(match[1]) >= 2) {
        restored += match[2];
        if (!page.next || page.next.offset > Number(match[1])) restored += "\n";
      }
    }
    if (!page.next) break;
    args = page.next;
  }
  assert.equal(restored, body + "\n"); // The trailing empty source line is preserved.
});

test("paging pins the endpoint and detects rewrites; deleted and newly appended history is not cached", async t => {
  const { ctx, save } = await setup(t);
  const path = await save("past", [entry("a", null, "alpha\nbeta\ngamma")]);
  const page = await readSession(ctx, { session_id: "past", limit: 1 });
  assert.ok("next" in page && page.next); assert.equal(page.next.leaf_id, "a");
  await appendFile(path, JSON.stringify(entry("b", "a", "new-needle")) + "\n");
  assert.equal((await searchSessions(ctx, { query: "new-needle" })).hits.length, 1);
  await assert.rejects(readSession(ctx, page.next), /changed since/);
  await truncate(path, 0);
  const result = await searchSessions(ctx, { query: "alpha" });
  assert.equal(result.hits.length, 0); assert.equal(result.coverage.complete, false);
});

test("corruption and unsupported legacy files report incomplete coverage without changing archives", async t => {
  const { ctx, save } = await setup(t);
  const good = await save();
  const old = await save("old", undefined, { version: 1 });
  const bad = await save("bad"); await appendFile(bad, "not json\n");
  const before = await Promise.all([good, old, bad].map(async p => [await readFile(p, "utf8"), (await stat(p)).mtimeMs]));
  const result = await searchSessions(ctx, { query: "alpha" });
  assert.equal(result.hits.length, 1); assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.warningCount, 2);
  assert.deepEqual(await Promise.all([good, old, bad].map(async p => [await readFile(p, "utf8"), (await stat(p)).mtimeMs])), before);
  const read = await readSession(ctx, { session_id: "past" }); assert.ok("text" in read);
});

test("incomplete trailing JSON is reported, complete unterminated JSON is accepted", () => {
  const coverage = newCoverage();
  const valid = source("id", "/project");
  assert.equal(parseDocument(valid + '{"type":', coverage).entries.length, 1);
  assert.equal(coverage.complete, false);
  assert.equal(parseDocument(valid.trimEnd()).entries.length, 1);
});

for (const [label, entries, pattern] of [
  ["duplicate", [entry("a", null, "one"), entry("a", null, "two")], /Duplicate entry/],
  ["missing parent", [entry("a", "absent", "one")], /Missing parent/],
  ["cycle", [entry("a", "b", "one"), entry("b", "a", "two")], /Cycle/],
] as const) test(`invalid graph: ${label}`, () => assert.throws(() => parseDocument(source("id", "/project", [...entries])), pattern));

test("duplicate session IDs are rejected on reads and excluded from search results", async t => {
  const { ctx, save } = await setup(t);
  await save("duplicate"); await save("duplicate", undefined, { filename: "second.jsonl" }); await save("good");
  const result = await searchSessions(ctx, { query: "alpha", limit: 1 });
  assert.deepEqual(result.hits.map(h => h.session_id), ["good"]);
  assert.equal(result.matching_entries, 1);
  assert.deepEqual(result.ambiguous_session_ids, ["duplicate"]);
  await assert.rejects(readSession(ctx, { session_id: "duplicate" }), /Ambiguous session ID/);
});

test("IDs never become paths, symlink descendants are not followed, and parentSession is ignored", async t => {
  const { ctx, save, dir } = await setup(t);
  const outside = join(dir, "outside"); await save("outside", undefined, { directory: outside });
  await symlink(join(outside, "outside.jsonl"), join(ctx.sessionDir, "link.jsonl"));
  await symlink(outside, join(ctx.agentDir, "sessions", "linked-project"));
  const path = await save();
  const text = await readFile(path, "utf8"); await writeFile(path, text.replace('"version":3', '"parentSession":"/private/secret.jsonl","version":3'));
  const result = await searchSessions(ctx, { query: "alpha", scope: "all" });
  assert.deepEqual(result.hits.map(h => h.session_id), ["past"]);
  assert.equal(result.coverage.complete, false);
  await assert.rejects(readSession(ctx, { session_id: join(outside, "outside.jsonl") }), /not found/);
  await assert.rejects(readSession(ctx, { session_id: "../auth.json" }), /not found/);
});

test("large files, records and scan budgets produce warnings instead of unbounded reads", async t => {
  const { ctx, save } = await setup(t);
  const path = await save(); await truncate(path, LIMITS.fileBytes + 1);
  const result = await searchSessions(ctx, { query: "alpha" });
  assert.equal(result.hits.length, 0); assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.bytes <= 16384);
  assert.throws(() => parseDocument(source("id", "/project", [entry("a", null, "x".repeat(LIMITS.recordBytes))])), /record exceeds/);
});

test("hits and warnings remain bounded, terminal controls are escaped, search flags are validated", async t => {
  const { ctx, save } = await setup(t);
  await save("past", Array.from({ length: 50 }, (_, i) => entry(`a${i}`, i ? `a${i - 1}` : null, 'alpha\u001b[2J\u009b'.repeat(100))));
  const result = await searchSessions(ctx, { query: "alpha", limit: 10 });
  assert.equal(result.hits.length, 10); assert.equal(result.has_more, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) <= LIMITS.outputBytes);
  assert.ok(!JSON.stringify(result).includes("\u001b"));
  for (const query of ["", " ", '""', "x".repeat(501)]) await assert.rejects(searchSessions(ctx, { query }));
  for (const extra of [{ limit: 11 }, { limit: 0 }, { scope: "elsewhere" }, { include_tools: "true" }]) await assert.rejects(searchSessions(ctx, { query: "alpha", ...extra } as any));
  for (const extra of [{ offset: 0 }, { column: 0 }, { limit: 101 }, { offset: 1.5 }]) await assert.rejects(readSession(ctx, { session_id: "past", ...extra }));
});

test("no-hit responses remain bounded with large ambiguity metadata and escaped queries", async t => {
  const { ctx, save } = await setup(t);
  for (let i = 0; i < 8; i++) {
    const id = `${"\u0800".repeat(127)}${i}`;
    for (let copy = 0; copy < 2; copy++) await save(id, undefined, { filename: `duplicate-${i}-${copy}.jsonl` });
  }
  const result = await searchSessions(ctx, { query: "\u0001".repeat(500) });
  assert.equal(result.hits.length, 0);
  assert.equal(result.coverage.complete, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) <= LIMITS.outputBytes);
  assert.throws(() => parseDocument(source("invalid\ud800", "/project")), /Invalid session header/);
});

test("cancellation stops scans without returning misleading partial results", async t => {
  const { ctx, save } = await setup(t); await save();
  const signal = AbortSignal.abort(new Error("cancelled test"));
  await assert.rejects(searchSessions({ ...ctx, signal }, { query: "alpha" }), /cancelled test/);
  await assert.rejects(readSession({ ...ctx, signal }, { session_id: "past" }), /cancelled test/);
});

test("installed Pi loads the real tools and executes offline smoke checks", async t => {
  const agentDir = join(await temporary(t), "agent");
  const check = spawnSync("pi", ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", "-e", join(root, "tests/fixtures/sessions-smoke.ts"), "-p", "/sessions-smoke"], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 30000 });
  if (check.error && (check.error as any).code === "ENOENT") { t.skip("Pi is not installed"); return; }
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /Session integration:.*passed/);
});
