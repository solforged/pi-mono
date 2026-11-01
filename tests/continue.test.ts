import assert from "node:assert/strict";
import test from "node:test";
import registerContinue from "../extensions/continue/index.ts";

function harness() {
  const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
  registerContinue({ on: (name: string, handler: any) => { handlers[name] = handler; } } as any);
  return (text: string, options: { source?: string; mode?: string; images?: unknown[] } = {}) =>
    handlers.input({ text, source: options.source ?? "interactive", images: options.images },
      { mode: options.mode ?? "tui" });
}

test("a submitted lone dot becomes a normal continuation prompt", () => {
  const input = harness();
  for (const text of [".", " . ", "\n.\n"]) {
    assert.deepEqual(input(text), { action: "transform", text: "Continue." });
  }
});

test("ordinary input is unchanged", () => {
  const input = harness();
  for (const text of ["", "...", "./file.ts", "Explain .", "hello", ".\nmore"]) {
    assert.deepEqual(input(text), { action: "continue" });
  }
});

test("extension messages and noninteractive sessions are unchanged", () => {
  const input = harness();
  assert.deepEqual(input(".", { source: "extension" }), { action: "continue" });
  assert.deepEqual(input(".", { source: "rpc" }), { action: "continue" });
  for (const mode of ["rpc", "print", "json"]) {
    assert.deepEqual(input(".", { mode }), { action: "continue" });
  }
});

test("a dot accompanying images remains literal input", () => {
  const input = harness();
  assert.deepEqual(input(".", { images: [{ type: "image" }] }), { action: "continue" });
  assert.deepEqual(input(".", { images: [] }), { action: "transform", text: "Continue." });
});
