import assert from "node:assert/strict";
import { readFile, stat, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore, archiveResult, headBytes, MAX_EXCERPT_BYTES, preview, readExcerpt, type Result } from "../extensions/artifacts/output.ts";
import { temporary } from "./helpers.ts";

function result(text: string, extra: Partial<Result> = {}): Result {
  return { toolName: "bash", toolCallId: "call-1", content: [{ type: "text", text }], isError: false, ...extra };
}
const output = () => Array.from({ length: 250 }, (_, i) => `line ${i + 1}: ${"data ".repeat(20)}`).join("\n");

for (const name of ["read", "edit", "write", "artifact_read", "mcp_arbitrary", "subagent"]) {
  test(`${name} keeps its complete output`, async (t) => {
    const store = new ArtifactStore(join(await temporary(t), "artifacts"));
    assert.equal(await archiveResult(result(output(), { toolName: name }), store), undefined);
  });
}

test("small results, errors and nested calls are unchanged and create no files", async (t) => {
  const dir = await temporary(t);
  const store = new ArtifactStore(join(dir, "artifacts"));
  assert.equal(await archiveResult(result("done"), store), undefined);
  assert.equal(await archiveResult(result(output(), { isError: true }), store), undefined);
  assert.equal(await archiveResult(result(output(), { parentToolCallId: "parent", structuredContent: { output: output() } }), store), undefined);
  assert.deepEqual(await readdir(dir), []);
});

test("successful large output is saved before replacement without duplicating raw text", async (t) => {
  const store = new ArtifactStore(join(await temporary(t), "artifacts"));
  const text = output();
  const details = { exitCode: 0, fullOutputPath: "/upstream/output.txt" };
  const archived = await archiveResult(result(text, { details, structuredContent: { output: text } }), store);
  assert.ok(archived);
  assert.equal(await readFile(archived.artifact.path, "utf8"), text);
  assert.equal(await store.read(archived.artifact.id), text);
  assert.equal(archived.details, details);
  assert.ok(!("structuredContent" in archived));
  const returned = archived.content[0];
  assert.equal(returned.type, "text");
  if (returned.type !== "text") return;
  assert.ok(Buffer.byteLength(returned.text) < 8192);
  assert.match(returned.text, /incomplete, not a summary/);
  assert.match(returned.text, /artifact_read/);
  assert.match(returned.text, /upstream tool truncation still applies/);
  assert.ok(!returned.text.includes("line 125:"));
  assert.equal((await stat(store.root)).mode & 0o777, 0o700);
  assert.equal((await stat(archived.artifact.path)).mode & 0o777, 0o600);
});

test("bytes alone trigger archival, however many lines", async (t) => {
  const store = new ArtifactStore(join(await temporary(t), "artifacts"));
  assert.equal(await archiveResult(result("x".repeat(8192)), store), undefined);
  assert.ok(await archiveResult(result("x".repeat(8193)), store));
  // Archived at 161 lines, a 6 KB listing cost a 2.5 KB receipt and three reads to recover.
  const listing = Array.from({ length: 161 }, (_, i) => `src/components/widgets/item-${String(i).padStart(4, "0")}.tsx`).join("\n");
  assert.equal(await archiveResult(result(listing, { toolName: "find" }), store), undefined);
  assert.equal(await archiveResult(result(Array(4096).fill("x").join("\n")), store), undefined);
});

test("preview includes head, tail and middle diagnostics within its budget", () => {
  const lines = output().split("\n");
  lines[124] = "warning: hidden diagnostic in the middle";
  const text = preview(lines.join("\n"));
  assert.match(text, /line 1:/);
  assert.match(text, /line 250:/);
  assert.match(text, /L125: warning: hidden diagnostic/);
  assert.ok(Buffer.byteLength(text) < MAX_EXCERPT_BYTES);
});

test("Unicode clipping never creates replacement characters", () => {
  assert.equal(headBytes("🙂🙂", 7), "🙂");
  assert.equal(headBytes("é", 1), "");
  const text = preview("🙂".repeat(5000));
  assert.ok(!text.includes("\ufffd"));
  assert.ok(Buffer.byteLength(text) < MAX_EXCERPT_BYTES);
});

test("images are preserved and multiple text blocks are archived together", async (t) => {
  const store = new ArtifactStore(join(await temporary(t), "artifacts"));
  const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
  const text = output();
  const archived = await archiveResult(result("", { content: [{ type: "text", text }, image, { type: "text", text: "last block" }] }), store);
  assert.ok(archived);
  assert.equal(archived.content.length, 2);
  assert.equal(archived.content[1], image);
  assert.equal(await store.read(archived.artifact.id), `${text}\n\nlast block`);
});

test("parallel saves are unique and another runtime can restore the same IDs", async (t) => {
  const root = join(await temporary(t), "artifacts");
  const store = new ArtifactStore(root);
  const saved = await Promise.all(Array.from({ length: 20 }, (_, i) => store.save(`output ${i}`)));
  assert.equal(new Set(saved.map((entry) => entry.id)).size, 20);
  const resumed = new ArtifactStore(root);
  for (let i = 0; i < saved.length; i++) assert.equal(await resumed.read(saved[i].id), `output ${i}`);
});

test("storage failures reject without changing the original result", async (t) => {
  const dir = await temporary(t);
  const store = new ArtifactStore(join(dir, "artifacts"));
  await symlink(dir, store.root);
  const event = result(output());
  const before = structuredClone(event);
  await assert.rejects(archiveResult(event, store), /symlink/);
  assert.deepEqual(event, before);
});

test("artifact reads reject arbitrary paths, malformed IDs and symlink files", async (t) => {
  const dir = await temporary(t);
  const store = new ArtifactStore(join(dir, "artifacts"));
  const saved = await store.save("private artifact");
  for (const id of ["../auth.json", saved.path, "abc", `${saved.id}/../auth.json`]) {
    await assert.rejects(store.read(id), /UUID/);
  }
  const linkedId = "12345678-1234-4234-8234-123456789abc";
  await symlink(saved.path, join(store.root, `${linkedId}.txt`));
  await assert.rejects(store.read(linkedId), { code: "ELOOP" });
});

test("oversized artifact input fails rather than pretending to save everything", async (t) => {
  const store = new ArtifactStore(join(await temporary(t), "artifacts"));
  await assert.rejects(store.save("x".repeat(16 * 1024 * 1024 + 1)), /16 MiB/);
});

test("line ranges and literal queries return original source line numbers", () => {
  const text = "first\n[error] here\nthird\n[error] later\nlast";
  assert.match(readExcerpt(text, { offset: 3, limit: 2 }), /L3: third\nL4: \[error\] later/);
  assert.match(readExcerpt(text, { offset: 3, limit: 2 }), /offset=5/);
  const filtered = readExcerpt(text, { query: "[error]", limit: 1 });
  assert.match(filtered, /L2: \[error\] here/);
  assert.match(filtered, /offset=4 and the same query/);
  assert.ok(!filtered.includes("L1:"));
  assert.match(readExcerpt(text, { query: "ERROR" }), /No matching lines/);
  assert.match(readExcerpt(text, { offset: 99 }), /No matching lines/);
});

test("retrieval stays bounded and never skips a line at the byte boundary", () => {
  const text = Array.from({ length: 20 }, (_, i) => `${i}: ${"é".repeat(400)}`).join("\n");
  const excerpt = readExcerpt(text, { limit: 80 });
  assert.ok(Buffer.byteLength(excerpt) <= MAX_EXCERPT_BYTES);
  assert.match(excerpt, /offset=8/);
  assert.ok(!excerpt.includes("\ufffd"));
});

test("long lines can be retrieved completely via Unicode-safe column continuation", () => {
  const text = "🙂".repeat(4000);
  let column = 1;
  let restored = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const excerpt = readExcerpt(text, { column, limit: 1 });
    assert.ok(Buffer.byteLength(excerpt) <= MAX_EXCERPT_BYTES);
    assert.ok(!excerpt.includes("\ufffd"));
    const line = excerpt.split("\n").find((line) => line.startsWith("L1"))!;
    restored += line.slice(line.indexOf(": ") + 2);
    const next = excerpt.match(/column=(\d+)/);
    if (!next) break;
    assert.ok(Number(next[1]) > column);
    column = Number(next[1]);
  }
  assert.equal(restored, text);
});

test("retrieval rejects invalid ranges and caps the page size", () => {
  for (const options of [{ offset: 0 }, { offset: 1.5 }, { limit: 0 }, { limit: 1.5 }, { query: "" }, { query: "x".repeat(501) }, { column: 0 }]) {
    assert.throws(() => readExcerpt("text", options));
  }
  const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
  const page = readExcerpt(text, { limit: 135 });
  assert.match(page, /L80: line 80\n/);
  assert.doesNotMatch(page, /L81:/);
  assert.match(page, /offset=81/);
});
