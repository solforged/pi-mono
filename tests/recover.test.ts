import assert from "node:assert/strict";
import test from "node:test";
import { blockNote, callKey, diagnose, label, limits, notes, RECOVER_TYPE, registerRecover, turnKey } from "../extensions/recover/recover.ts";

const text = (value: string) => ({ type: "text", text: value });
const call = (name: string, args: object) => ({ type: "toolCall", id: `${name}-${Math.random()}`, name, arguments: args });
const assistant = (stopReason: string, ...content: object[]) => ({ role: "assistant", stopReason, content });
const result = (value: string, isError = false) => ({ role: "toolResult", isError, content: [text(value)] });

function install() {
  const handlers: Record<string, (event: any, ctx?: any) => any> = {}, commands: Record<string, any> = {};
  registerRecover({ on: (name: string, fn: any) => { handlers[name] = fn; }, registerCommand: (name: string, options: any) => { commands[name] = options; } } as any);
  const end = (message: any, toolResults: any[] = [], outcome = "completed") =>
    handlers.turn_end({ message, toolResults, outcome, messageEntryId: "m1", entries: [{ type: "custom", customType: "other" }] });
  return { handlers, commands, end };
}

test("only turns without tool calls or visible text are diagnosed", () => {
  assert.equal(diagnose(assistant("stop")), "empty");
  assert.equal(diagnose(assistant("stop", { type: "thinking", thinking: "I will call the tool now." })), "empty");
  assert.equal(diagnose(assistant("stop", text("  \n"))), "empty");
  assert.equal(diagnose(assistant("stop", text("Done."))), undefined);
  assert.equal(diagnose(assistant("length", text("A long answer that stops mid"))), "cut");
  assert.equal(diagnose(assistant("length", { type: "thinking", thinking: "Still reasoning" })), "cut-thinking");
  assert.equal(diagnose(assistant("toolUse", call("read", { path: "a" }))), undefined);
  assert.equal(diagnose(assistant("error")), undefined);
  assert.equal(diagnose({ role: "user", content: "hi" }), undefined);
});

test("an empty stop is dropped from context and continued, twice per prompt", () => {
  const { handlers, end } = install();
  const first = end(assistant("stop"));
  assert.equal(first.continue, true);
  assert.deepEqual(first.entries.map((e: any) => e.type), ["custom", "context_edit", "custom_message"]);
  assert.deepEqual(first.entries[1], { type: "context_edit", targetId: "m1", replacement: null });
  assert.deepEqual([first.entries[2].customType, first.entries[2].content, first.entries[2].details], [RECOVER_TYPE, notes.empty, { kind: "empty", count: 1 }]);
  assert.equal(end(assistant("stop")).entries[2].details.count, 2);
  assert.equal(end(assistant("stop")), undefined);
  // A steering or extension message keeps the budget; the user's next prompt renews it.
  handlers.before_agent_start({ messageType: "custom" });
  assert.equal(end(assistant("stop")), undefined);
  handlers.before_agent_start({ messageType: "user" });
  assert.equal(end(assistant("stop")).continue, true);
});

test("a reply cut at the output limit keeps its text; reasoning cut there is dropped", () => {
  const { end } = install();
  const cut = end(assistant("length", text("A long answer that stops mid")));
  assert.deepEqual(cut.entries.map((e: any) => e.type), ["custom", "custom_message"]);
  assert.equal(cut.entries[1].content, notes.cut);
  const thinking = end(assistant("length", { type: "thinking", thinking: "Still reasoning" }));
  assert.deepEqual(thinking.entries.map((e: any) => e.type), ["custom", "context_edit", "custom_message"]);
  assert.equal(thinking.entries[2].content, notes["cut-thinking"]);
});

test("failed, aborted and ordinary turns are left alone", () => {
  const { end } = install();
  assert.equal(end(assistant("error"), [], "error"), undefined);
  assert.equal(end(assistant("stop"), [], "aborted"), undefined);
  assert.equal(end(assistant("stop", text("Done."))), undefined);
  assert.equal(end(assistant("toolUse", call("read", { path: "a" })), [result("contents")]), undefined);
});

test("a call repeated with the same result is warned about, then refused", () => {
  const { handlers, end } = install();
  const turn = () => end(assistant("toolUse", call("bash", { command: "ls", timeout: 5 })), [result("a.txt")]);
  const same = { toolName: "bash", input: { timeout: 5, command: "ls" } };
  assert.equal(turn(), undefined);
  assert.equal(turn(), undefined);
  assert.equal(handlers.tool_call(same), undefined);
  const warned = turn();
  assert.equal(warned.continue, undefined);
  assert.deepEqual(warned.entries.at(-1).details, { kind: "loop", count: limits.warnAt });
  assert.match(warned.entries.at(-1).content, /same tool call 3 times.*bash \{"command":"ls","timeout":5\}/);
  assert.equal(handlers.tool_call(same), undefined);
  assert.equal(turn(), undefined);
  // The fifth identical call is not run; other calls still are.
  assert.deepEqual(handlers.tool_call(same), { block: true, reason: blockNote(4) });
  assert.equal(handlers.tool_call({ toolName: "bash", input: { command: "pwd" } }), undefined);
  // The refusal is a different result, so the count starts over.
  end(assistant("toolUse", call("bash", { command: "ls", timeout: 5 })), [result(blockNote(4), true)]);
  assert.equal(handlers.tool_call(same), undefined);
});

test("polling is not a loop: a changed result or a different turn resets the count", () => {
  const { handlers, end } = install();
  const poll = (output: string) => end(assistant("toolUse", call("rex_result", { next: true })), [result(output)]);
  for (const output of ["waiting", "waiting", "one done", "one done", "two done", "two done"]) assert.equal(poll(output), undefined);
  assert.equal(handlers.tool_call({ toolName: "rex_result", input: { next: true } }), undefined);
  poll("x"); poll("x");
  end(assistant("stop", text("Summary.")));
  assert.equal(poll("x"), undefined);
  assert.equal(callKey("a", { x: 1, y: { b: 2, a: [1, 2] } }), callKey("a", { y: { a: [1, 2], b: 2 }, x: 1 }));
  assert.notEqual(turnKey(["a {}"], [result("ok")]), turnKey(["a {}"], [result("ok", true)]));
});

test("/recover reports counts and switches every mechanism off", async () => {
  const { handlers, commands, end } = install();
  const said: string[] = [], ctx = { hasUI: true, ui: { notify: (message: string) => said.push(message) } };
  end(assistant("stop"));
  await commands.recover.handler("", ctx);
  assert.match(said.at(-1)!, /^Recovery on\. Since load: 1 empty, 0 cut off, 0 loop warnings, 0 calls refused\.$/);
  await commands.recover.handler("off", ctx);
  assert.equal(end(assistant("stop")), undefined);
  for (let i = 0; i < 6; i++) assert.equal(end(assistant("toolUse", call("bash", { command: "ls" })), [result("a")]), undefined);
  assert.equal(handlers.tool_call({ toolName: "bash", input: { command: "ls" } }), undefined);
  await commands.recover.handler("sometimes", ctx);
  assert.match(said.at(-1)!, /^Usage:/);
});

test("transcript labels name what happened", () => {
  assert.equal(label({ kind: "empty", count: 1 }), "Empty response; asked the model to continue (1/2)");
  assert.match(label({ kind: "loop", count: 3 }), /^Same tool call 3 times/);
  assert.equal(label(undefined), "Recovery note");
});
