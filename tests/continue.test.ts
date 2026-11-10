import assert from "node:assert/strict";
import test from "node:test";
import registerContinue from "../extensions/continue/index.ts";

type Options = { source?: string; mode?: string; images?: unknown[]; streamingBehavior?: string };

const entry = (id: number, message: any) => ({ type: "message", id: `e${id}`, parentId: id ? `e${id - 1}` : null, message });
const settled = [entry(0, { role: "user", content: "hi" }), entry(1, { role: "assistant", stopReason: "stop" })];
const failed = [entry(0, { role: "user", content: "hi" }), entry(1, { role: "assistant", stopReason: "aborted" })];

function harness(state: { branch?: any[]; idle?: boolean; commands?: string[] } = {}) {
  const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
  const sent: [any, any][] = [], user: [any, any][] = [];
  registerContinue({
    on: (name: string, handler: any) => { handlers[name] = handler; },
    sendMessage: (message: any, options: any) => { sent.push([message, options]); },
    sendUserMessage: (content: any, options: any) => { user.push([content, options]); },
    getCommands: () => (state.commands ?? ["retry"]).map(name => ({ name })),
  } as any);
  const ctx = (mode: string) => ({
    mode, isIdle: () => state.idle ?? true,
    sessionManager: { getBranch: () => state.branch ?? settled },
  });
  const input = (text: string, options: Options = {}) =>
    handlers.input({ text, source: options.source ?? "interactive", images: options.images, streamingBehavior: options.streamingBehavior },
      ctx(options.mode ?? "tui"));
  return { input, sent, user };
}

const hidden = { customType: "continue", content: "continue", display: false };
const tick = () => new Promise(r => setTimeout(r, 0));

test("a submitted lone dot continues with a hidden message", () => {
  for (const text of [".", " . ", "\n.\n"]) {
    const { input, sent } = harness();
    assert.deepEqual(input(text), { action: "handled" });
    assert.deepEqual(sent, [[hidden, { triggerTurn: true, deliverAs: undefined }]]);
  }
});

test("a dot submitted while streaming keeps its steer or follow-up delivery", () => {
  for (const streamingBehavior of ["steer", "followUp"]) {
    const { input, sent, user } = harness({ branch: failed });
    assert.deepEqual(input(".", { streamingBehavior }), { action: "handled" });
    assert.deepEqual(sent, [[hidden, { triggerTurn: true, deliverAs: streamingBehavior }]]);
    assert.deepEqual(user, []);
  }
});

test("a dot after a failed turn retries it once the prompt has finished", async () => {
  const { input, sent, user } = harness({ branch: failed });
  assert.deepEqual(input("."), { action: "handled" });
  assert.deepEqual(user, []);
  await tick();
  assert.deepEqual(user, [["/retry", { expandPromptTemplates: true }]]);
  assert.deepEqual(sent, []);
});

test("a dot after a failed turn continues when retry is unavailable or Pi is busy", () => {
  for (const state of [{ commands: [] }, { idle: false }]) {
    const { input, sent } = harness({ branch: failed, ...state });
    assert.deepEqual(input("."), { action: "handled" });
    assert.deepEqual(sent, [[hidden, { triggerTurn: true, deliverAs: undefined }]]);
  }
});

test("ordinary input is unchanged", () => {
  const { input, sent } = harness();
  for (const text of ["", "...", "./file.ts", "Explain .", "hello", ".\nmore"]) {
    assert.deepEqual(input(text), { action: "continue" });
  }
  assert.deepEqual(sent, []);
});

test("extension messages and noninteractive sessions are unchanged", () => {
  const { input, sent } = harness();
  assert.deepEqual(input(".", { source: "extension" }), { action: "continue" });
  assert.deepEqual(input(".", { source: "rpc" }), { action: "continue" });
  for (const mode of ["rpc", "print", "json"]) {
    assert.deepEqual(input(".", { mode }), { action: "continue" });
  }
  assert.deepEqual(sent, []);
});

test("a dot accompanying images remains literal input", () => {
  const { input, sent } = harness();
  assert.deepEqual(input(".", { images: [{ type: "image" }] }), { action: "continue" });
  assert.deepEqual(sent, []);
  assert.deepEqual(input(".", { images: [] }), { action: "handled" });
  assert.equal(sent.length, 1);
});
