import assert from "node:assert/strict";
import test from "node:test";
import {
  compactMessages,
  compactText,
  fileOpsLists,
  frameTokens,
  getArchive,
  historyBlocks,
  injectHistory,
  isVision,
  normalize,
  planArchive,
  previousSnapcompact,
  resolveShape,
  serializeConversation,
} from "../extensions/snapcompact/compact.ts";
import { geometry, NEWLINE_GLYPH, pngSize, renderFrame } from "../extensions/snapcompact/render.ts";

test("vision detection and shape follow the current model", () => {
  assert.equal(isVision({ input: ["text", "image"] }), true);
  assert.equal(isVision({ input: ["text"] }), false);
  assert.equal(isVision(undefined), false);
  assert.deepEqual(resolveShape({ id: "grok-4.6", provider: "xai", api: "openai-responses" }), { cellWidth: 8, cellHeight: 22, frameSize: 1568 });
  assert.deepEqual(resolveShape({ id: "gpt-5.6-sol", provider: "openai-codex" }), { cellWidth: 8, cellHeight: 22, frameSize: 1568 });
  assert.deepEqual(resolveShape({ id: "claude-opus-4-7" }), { cellWidth: 11, cellHeight: 16, frameSize: 1932 });
  assert.deepEqual(resolveShape({ id: "gemini-3.5-flash" }), { cellWidth: 8, cellHeight: 22, frameSize: 2048 });
});

test("normalize folds punctuation, newlines, and box drawing", () => {
  const text = normalize("Hello\n\nworld — “quoted” ✅\n┌─┐");
  assert.match(text, /Hello/);
  assert.match(text, /world - "quoted" \[OK\]/);
  assert.equal(text.includes("\n"), false);
  assert.equal(text.includes(NEWLINE_GLYPH), true);
  assert.match(text, /\+-\+/);
});

test("normalize folds accented Latin to ASCII and keeps other scripts as written", () => {
  assert.equal(normalize("café Zürich, Straße, Ærø, ēĀ ＡＢ"), "cafe Zurich, Strasse, AEro, eA AB");
  // Letters with no ASCII form stay, marks included; the frame font draws them as "?".
  for (const text of ["日本語のテスト。", "Привет, мир", "ภาษาไทย", "سلام دنیا", "한국어", "x ≥ 2"]) assert.equal(normalize(text), text);
  assert.equal(normalize("done 🎉 ok\u0301"), "done ok", "emoji and stray marks are dropped");
  assert.equal(normalize("def f():\n    return 1"), `def f():${NEWLINE_GLYPH}return 1`, "indentation is not kept");
  const shape = { cellWidth: 8, cellHeight: 22, frameSize: 160 };
  assert.equal(renderFrame("日й", shape).data, renderFrame("??", shape).data);
  assert.doesNotMatch(compactMessages([{ role: "user", content: "hi" }], { firstKeptEntryId: "k", tokensBefore: 1 }).summary, /verbatim/);
});

test("pages are cut between characters, never inside one", () => {
  const shape = { cellWidth: 8, cellHeight: 22, frameSize: 160 };
  const cap = geometry(shape).capacity;
  // An odd offset puts every UTF-16 page boundary inside a surrogate pair.
  const plan = planArchive(`a${"𠮷".repeat(cap * 5)}`, shape);
  assert.ok(plan.frames.length >= 3);
  for (const page of [plan.textHead, plan.textTail, ...plan.frames]) {
    assert.equal(page.isWellFormed(), true);
    assert.ok([...page].length <= cap);
  }
  assert.equal(plan.keptText, `a${"𠮷".repeat(cap * 5)}`);
});

test("serializeConversation keeps scopes and truncates tool output", () => {
  const text = serializeConversation([
    { role: "user", content: "Fix the renderer" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Look at png.ts" },
        { type: "text", text: "I will read it." },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "png.ts" } },
      ],
    },
    { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "file body" }] },
  ]);
  assert.match(text, /¶user:Fix the renderer/);
  assert.match(text, /¶think:Look at png.ts/);
  assert.match(text, /¶ai:I will read it/);
  assert.match(text, /¶call:read\(path="png.ts"\)/);
  assert.match(text, /<out>\nfile body\n<\/out>/);
});

test("renderFrame writes a 1-bit PNG whose width is the frame size", () => {
  const shape = { cellWidth: 8, cellHeight: 22, frameSize: 1568 };
  const frame = renderFrame("Hello", shape);
  const size = pngSize(frame.data);
  assert.equal(size.width, 1568);
  assert.equal(size.height, 22);
  assert.equal(frame.cols, geometry(shape).cols);
  assert.equal(frame.chars, 5);
  assert.ok(size.bytes > 50);
});

test("short history stays text; long history images the middle", () => {
  const shape = { cellWidth: 8, cellHeight: 22, frameSize: 160 };
  const cap = geometry(shape).capacity;
  const short = planArchive("a".repeat(cap), shape);
  assert.equal(short.frames.length, 0);
  assert.equal(short.textTail, "");
  const long = planArchive("abcdefghijklmnopqrstuvwxyz".repeat(200), shape, 3);
  assert.equal(long.frames.length, 3);
  assert.ok(long.textHead.length > 0);
  assert.ok(long.textTail.length > 0);
});

test("compactMessages stores frames and injectHistory attaches them for vision models", () => {
  const packed = compactMessages(
    [
      { role: "user", content: "aaaaaaaaaa ".repeat(4000) },
      { role: "assistant", content: [{ type: "text", text: "bbbbbbbbbb ".repeat(4000) }] },
    ],
    { model: { id: "grok-4.6", provider: "xai" }, firstKeptEntryId: "keep", tokensBefore: 40000 },
  );
  const archive = packed.details.snapcompact;
  assert.equal(packed.firstKeptEntryId, "keep");
  assert.match(packed.summary, /HISTORY/);
  assert.ok(archive.frames.length >= 1);
  const injected = injectHistory(
    [{ role: "compactionSummary", summary: packed.summary, timestamp: 1 }],
    archive,
    true,
  );
  const message = injected[0] as { role: string; content: Array<{ type: string }> };
  assert.equal(message.role, "user");
  assert.equal(message.content[0]?.type, "text");
  assert.equal(message.content.some((block) => block.type === "image"), true);
  const textOnly = injectHistory(
    [{ role: "compactionSummary", summary: packed.summary, timestamp: 1 }],
    archive,
    false,
  );
  const fallback = textOnly[0] as { role: string; content: Array<{ type: string }> };
  assert.equal(fallback.content.some((block) => block.type === "image"), false);
  // The hook sees the full transcript; system messages must pass through untouched and in place.
  const head = { role: "system", timestamp: 0 }, patch = { role: "system", timestamp: 2 };
  const full = injectHistory([head, { role: "compactionSummary", summary: packed.summary, timestamp: 1 }, patch], archive, true);
  assert.deepEqual(full.map((m) => m.role), ["system", "user", "system"]);
  assert.equal(full[0], head);
  assert.equal(full[2], patch);
});

test("historyBlocks keep newest frames when the byte budget is tight", () => {
  const shape = { cellWidth: 8, cellHeight: 22, frameSize: 160 };
  const packed = compactText("Hello world. ".repeat(800), shape, { maxFrames: 4 });
  const tiny = historyBlocks(packed.archive, { bytes: 800 });
  const images = tiny.filter((block) => block.type === "image");
  assert.ok(images.length < packed.archive.frames.length);
  assert.ok(tiny.some((block) => block.type === "text" && /omitted/.test(block.text)));
});

test("compaction renders only the newest frames that fit a request and keeps the text of the rest", () => {
  const shape = { cellWidth: 8, cellHeight: 22, frameSize: 160 };
  const text = "Hello world. ".repeat(800);
  const full = compactText(text, shape, { maxFrames: 8 });
  assert.equal(full.archive.frames.length, 8);
  assert.equal(full.archive.omittedFrames, undefined);
  const newestThree = full.archive.frames.slice(-3).reduce((sum, frame) => sum + frame.data.length, 0);
  const capped = compactText(text, shape, { maxFrames: 8, maxFrameDataBytes: newestThree });
  assert.equal(capped.archive.frames.length, 3);
  assert.equal(capped.archive.omittedFrames, 5);
  assert.deepEqual(capped.archive.frames, full.archive.frames.slice(-3));
  assert.equal(capped.archive.text, full.archive.text);
  // A later compaction rebuilds from the text, so unrendered pages are not lost.
  assert.equal(getArchive({ snapcompact: capped.archive })?.omittedFrames, 5);
  const blocks = historyBlocks(capped.archive);
  assert.equal(blocks.filter((block) => block.type === "image").length, 3);
  assert.ok(blocks.some((block) => block.type === "text" && /5 older snapcompact frames omitted/.test(block.text)));
});

test("frames are budgeted in estimated tokens, at compaction and again per request", () => {
  const shape = { cellWidth: 8, cellHeight: 22, frameSize: 160 };
  const text = "Hello world. ".repeat(800);
  const full = compactText(text, shape, { maxFrames: 8 });
  const size = pngSize(full.archive.frames[0]!.data);
  assert.equal(frameTokens(full.archive.frames[0]!), Math.ceil((size.width * size.height) / 750));
  assert.equal(frameTokens({ data: "" }), Number.POSITIVE_INFINITY, "an unreadable frame never fits");
  const newestTwo = full.archive.frames.slice(-2).reduce((sum, frame) => sum + frameTokens(frame), 0);
  const capped = compactText(text, shape, { maxFrames: 8, maxFrameTokens: newestTwo });
  assert.deepEqual(capped.archive.frames, full.archive.frames.slice(-2));
  assert.equal(capped.archive.omittedFrames, 6);
  // A model with a smaller window may read an archive made for a larger one.
  const blocks = historyBlocks(full.archive, { tokens: newestTwo });
  assert.equal(blocks.filter((block) => block.type === "image").length, 2);
  assert.ok(blocks.some((block) => block.type === "text" && /6 older snapcompact frames omitted/.test(block.text)));
  const injected = injectHistory([{ role: "compactionSummary", summary: "guide", timestamp: 1 }], full.archive, true, newestTwo)[0] as any;
  assert.equal(injected.content.filter((block: any) => block.type === "image").length, 2);
});

test("a later compaction reuses the frames of pages that did not change", () => {
  const shape = { cellWidth: 8, cellHeight: 22, frameSize: 160 };
  const lines = (from: number, count: number) => Array.from({ length: count }, (_, i) => `line ${from + i} of the transcript`).join("\n");
  const first = compactText(lines(0, 100), shape);
  const second = compactText(lines(100, 50), shape, { previousText: first.archive.text });
  assert.equal(second.archive.truncatedChars, 0);
  assert.ok(second.archive.frames.length > first.archive.frames.length);
  // Every full page of the first archive sits at the same offset in the second.
  const full = first.archive.frames.slice(0, -1);
  assert.ok(full.length >= 3);
  full.forEach((frame, i) => assert.equal(second.archive.frames[i], frame));
});

test("previousSnapcompact reads the latest compaction archive", () => {
  const found = previousSnapcompact([
    { type: "message" },
    { type: "compaction", details: { snapcompact: { frames: [], totalChars: 3, truncatedChars: 0, text: "abc" } } },
    { type: "message" },
  ]);
  assert.equal(found.archive?.text, "abc");
  assert.equal(previousSnapcompact([{ type: "message" }]).archive, undefined);
});

test("file lists merge Pi's written and edited sets with an earlier archive's lists", () => {
  const lists = fileOpsLists(
    { read: new Set(["a.ts"]), written: new Set(["new.ts"]), edited: new Set(["b.ts"]) },
    { readFiles: ["old.ts"], modifiedFiles: ["b.ts", "c.ts"] },
  );
  assert.deepEqual(lists, { readFiles: ["old.ts", "a.ts"], modifiedFiles: ["b.ts", "c.ts", "new.ts"] });
});
