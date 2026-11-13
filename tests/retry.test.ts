import assert from "node:assert/strict";
import test from "node:test";
import { planRetry, registerRetry, retryNote, RETRY_TYPE } from "../extensions/retry/retry.ts";

let n = 0;
function chain(...specs: object[]) {
  const entries: any[] = [];
  for (const spec of specs) entries.push({ id: `e${++n}`, parentId: entries.at(-1)?.id ?? null, ...spec });
  return entries;
}
const user = (content: unknown = "fix it") => ({ type: "message", message: { role: "user", content } });
const assistant = (stopReason: string) => ({ type: "message", message: { role: "assistant", content: [], stopReason } });
const tool = (content = "ok", isError = false) => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: content }], isError } });
const system = { type: "message", message: { role: "system", content: "" } };
const modelChange = (modelId: string) => ({ type: "model_change", provider: "p", modelId });

test("a failed first response resends its prompt from before it", () => {
  const branch = chain(user("earlier"), assistant("stop"), user([{ type: "text", text: "fix it" }]), system, assistant("error"));
  const plan = planRetry(branch)!;
  assert.equal(plan.kind, "prompt");
  assert.equal(plan.target, branch[2].id);
  assert.deepEqual((plan as any).content, [{ type: "text", text: "fix it" }]);
  assert.equal(plan.dropped.length, 3);
});

test("a failure after tool results continues from them, past earlier attempts and metadata", () => {
  const branch = chain(user(), assistant("toolUse"), tool(), assistant("error"),
    { type: "context_edit", targetId: "x", replacement: null }, assistant("error"), { type: "label" }, modelChange("b"));
  const plan = planRetry(branch)!;
  assert.deepEqual([plan.kind, plan.target, (plan as any).interrupted], ["continue", branch[2].id, false]);
  assert.equal(plan.dropped.length, 5);
});

test("an abort during tool execution marks the interrupted results", () => {
  const branch = chain(user(), assistant("toolUse"), tool("done"), tool("Operation aborted", true), assistant("aborted"));
  const plan = planRetry(branch)!;
  assert.equal((plan as any).interrupted, true);
  assert.match(retryNote(true), /Operation aborted/);
  assert.doesNotMatch(retryNote(false), /Operation aborted/);
});

test("an extension message that started the turn is resent", () => {
  const branch = chain(user(), assistant("stop"),
    { type: "custom_message", customType: "trigger", content: "go", display: true, details: { a: 1 } }, assistant("error"));
  const plan = planRetry(branch)!;
  assert.equal(plan.kind, "message");
  assert.deepEqual((plan as any).message, { customType: "trigger", content: "go", display: true, details: { a: 1 } });
});

test("context attached to a prompt is dropped with it, and the prompt is resent", () => {
  const note = { type: "custom_message", customType: "memory-terms", content: "Terms: ...", display: true };
  const branch = chain(user("earlier"), assistant("stop"), user("what is herdr?"), note, system, note, assistant("error"));
  const plan = planRetry(branch)!;
  assert.deepEqual([plan.kind, plan.target, (plan as any).content, plan.dropped.length], ["prompt", branch[2].id, "what is herdr?", 5]);
});

test("settled turns and later activity leave nothing to retry", () => {
  assert.equal(planRetry([]), undefined);
  assert.equal(planRetry(chain(user(), assistant("stop"))), undefined);
  assert.equal(planRetry(chain(user(), assistant("error"), user("next"))), undefined);
  assert.equal(planRetry(chain(user(), assistant("error"), { type: "message", message: { role: "bashExecution" } })), undefined);
  assert.equal(planRetry(chain(assistant("error"))), undefined);
});

function harness(branch: any[], options: { idle?: boolean; model?: any; editor?: string; cancelled?: boolean } = {}) {
  const calls: any[] = [];
  const commands = new Map<string, any>(), shortcuts = new Map<string, any>();
  let leaf = branch.at(-1)?.id, editor = options.editor ?? "";
  const byId = new Map(branch.map(e => [e.id, e]));
  const pi = {
    registerCommand: (name: string, c: any) => commands.set(name, c),
    registerShortcut: (key: string, s: any) => shortcuts.set(key, s),
    getThinkingLevel: () => "high",
    setThinkingLevel: (level: string) => calls.push(["level", level]),
    setModel: async (model: any) => { calls.push(["model", model.id]); return true; },
    sendUserMessage: (content: unknown, opts?: unknown) => calls.push(["user", content, opts]),
    sendMessage: (message: any, opts: unknown) => calls.push(["message", message, opts]),
  };
  const ctx = {
    mode: "tui", hasUI: true, model: options.model,
    isIdle: () => options.idle ?? true,
    ui: { notify: (m: string) => calls.push(["notify", m]), getEditorText: () => editor, setEditorText: (t: string) => { editor = t; } },
    sessionManager: {
      getBranch: () => {
        const path = [];
        for (let e = byId.get(leaf); e; e = byId.get(e.parentId)) path.unshift(e);
        return path;
      },
    },
    navigateTree: async (id: string) => {
      calls.push(["navigate", id]);
      if (options.cancelled) return { cancelled: true };
      const target = byId.get(id)!;
      const isMessage = target.type === "custom_message" || target.message?.role === "user";
      leaf = isMessage ? target.parentId : id;
      if (isMessage && !editor) editor = "restored";
      return { cancelled: false };
    },
  };
  registerRetry(pi as any);
  return { calls, run: () => commands.get("retry").handler("", ctx), press: () => shortcuts.get("f5").handler(ctx), editor: () => editor };
}

test("/retry branches before the prompt and resends it without leaving it in the editor", async () => {
  const branch = chain(user("earlier"), assistant("stop"), user("fix it"), assistant("error"));
  const h = harness(branch);
  await h.run();
  assert.deepEqual(h.calls, [["navigate", branch[2].id], ["user", "fix it", undefined]]);
  assert.equal(h.editor(), "");
});

test("/retry keeps an existing draft and continues after tool results with a note", async () => {
  const branch = chain(user(), assistant("toolUse"), tool(), assistant("error"));
  const h = harness(branch, { editor: "draft" });
  await h.run();
  assert.deepEqual(h.calls, [["navigate", branch[2].id],
    ["message", { customType: RETRY_TYPE, content: retryNote(false), display: false }, { triggerTurn: true }]]);
  assert.equal(h.editor(), "draft");
});

test("/retry records a model switched after the failure on the new branch", async () => {
  const branch = chain(modelChange("a"), user(), assistant("error"), modelChange("b"));
  const h = harness(branch, { model: { provider: "p", id: "b" } });
  await h.run();
  assert.deepEqual(h.calls.slice(1, 3), [["model", "b"], ["level", "high"]]);
  const same = harness(chain(modelChange("a"), user(), assistant("error"), modelChange("a")), { model: { provider: "p", id: "a" } });
  await same.run();
  assert.equal(same.calls.some(c => c[0] === "model"), false);
});

test("/retry refuses while busy, with nothing to retry, or when navigation is cancelled", async () => {
  const failedBranch = chain(user(), assistant("error"));
  const busy = harness(failedBranch, { idle: false });
  await busy.run();
  assert.match(busy.calls[0][1], /^Wait/);
  const settled = harness(chain(user(), assistant("stop")));
  await settled.run();
  assert.deepEqual(settled.calls, [["notify", "Nothing to retry"]]);
  const cancelled = harness(failedBranch, { cancelled: true });
  await cancelled.run();
  assert.deepEqual(cancelled.calls.at(-1), ["notify", "Retry cancelled"]);
});

test("F5 dispatches /retry only when idle", async () => {
  const h = harness(chain(user(), assistant("error")));
  await h.press();
  assert.deepEqual(h.calls, [["user", "/retry", { expandPromptTemplates: true }]]);
  const busy = harness([], { idle: false });
  await busy.press();
  assert.match(busy.calls[0][1], /^Wait/);
});
