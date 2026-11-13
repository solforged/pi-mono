import assert from "node:assert/strict";
import test from "node:test";
import { registerRexTitle, rexTitle, setTitlePrefix } from "../extensions/rex/title.ts";

function stream() {
  const written: unknown[] = [];
  return { written, out: { write: (chunk: unknown) => { written.push(chunk); return true; } } as any };
}

test("rexTitle keeps the session name, or the directory when unnamed", () => {
  assert.equal(rexTitle("pi-mono", "pi-mono"), "pi-mono");
  assert.equal(rexTitle("Remove pi from logo - pi-mono", "pi-mono"), "Remove pi from logo");
  assert.equal(rexTitle("birch: a - b", "pi-mono"), "birch: a - b");
});

test("inside Rex, Pi's title writes are rewritten and other output passes through", () => {
  const s = stream();
  registerRexTitle({ REX_SESSION: "s1" }, s.out, () => "/src/pi-mono");
  s.out.write("\x1b]0;\u03c0 - Remove pi from logo - pi-mono\x07");
  s.out.write("\x1b]0;\u03c0 - pi-mono\x07");
  s.out.write("\x1b]0;custom\x07");
  s.out.write("hello \u03c0 - x");
  const bytes = Buffer.from("x");
  s.out.write(bytes);
  assert.deepEqual(s.written, ["\x1b]0;Remove pi from logo\x07", "\x1b]0;pi-mono\x07", "\x1b]0;custom\x07", "hello \u03c0 - x", bytes]);
});

test("outside Rex nothing is patched, and reloads patch only once", () => {
  const outside = stream(), write = outside.out.write;
  registerRexTitle({}, outside.out);
  assert.equal(outside.out.write, write);
  const s = stream();
  registerRexTitle({ REX_SESSION: "s1" }, s.out, () => "/src/pi-mono");
  const patched = s.out.write;
  registerRexTitle({ REX_SESSION: "s1" }, s.out, () => "/src/pi-mono");
  assert.equal(s.out.write, patched);
});

test("a colour prefix rewrites the current title at once and marks later ones", () => {
  const s = stream();
  setTitlePrefix("🟦", s.out);
  assert.deepEqual(s.written, [], "an unpatched stream is left alone");
  registerRexTitle({ REX_SESSION: "s1" }, s.out, () => "/src/pi-mono");
  setTitlePrefix("🟦", s.out);
  assert.deepEqual(s.written, [], "nothing to rewrite before Pi's first title");
  s.out.write("\x1b]0;\u03c0 - fix-login - pi-mono\x07");
  setTitlePrefix("🟦", s.out);
  // A reloaded module reaches the same state through the stream.
  registerRexTitle({ REX_SESSION: "s1" }, s.out, () => "/src/pi-mono");
  setTitlePrefix("", s.out);
  assert.deepEqual(s.written, ["\x1b]0;🟦 fix-login\x07", "\x1b]0;fix-login\x07"]);
});
