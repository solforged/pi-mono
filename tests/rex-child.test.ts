import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { activity, registerChild, todoProgress } from "../extensions/rex/child.ts";
import { registerProgressStatus, withProgress } from "../extensions/rex/status.ts";
import { claimOwner, readOwner, Frames, LEASE_MS, record, send, VERSION, type Manifest } from "../extensions/rex/protocol.ts";
import { saveJson } from "../extensions/workflows/state.ts";
import { config, root } from "./helpers.ts";

async function harness(t: any) {
  const dir = await realpath(await mkdtemp("/tmp/pi-rex-test-"));
  const old = { REX_SESSION: process.env.REX_SESSION, REX_BLOCK: process.env.REX_BLOCK };
  process.env.REX_SESSION = "session:11111111-1111-1111-1111-111111111111";
  process.env.REX_BLOCK = "block:22222222-2222-2222-2222-222222222222";
  const m: Manifest = { version: VERSION, id: randomUUID(), token: "f".repeat(64), socket: join(dir, "control"), dir, cwd: root,
    rexSession: process.env.REX_SESSION, parentBlock: "block:33333333-3333-3333-3333-333333333333", role: config.roles.task!,
    tools: ["read"], agent: "scout", maxTurns: 3, outputBytes: 1024, deadline: Date.now() + 60_000 };
  await saveJson(join(dir, "child.json"), m);
  const hooks = new Map<string, Function>(), commands = new Map<string, any>();
  const events: any[] = [], prompts: string[] = [], messages: any[] = [], notices: string[] = [];
  let sessionName: string | undefined, peer: Socket | undefined, aborts = 0, shutdowns = 0, activeTools: string[] = [], busy = false;
  const ctx: any = {
    mode: "tui", cwd: root, model: { provider: m.role.provider, id: m.role.model, maxTokens: 8192 },
    ui: { notify: (s: string) => notices.push(s), setStatus() {} },
    sessionManager: { getSessionId: () => "child", getSessionFile: () => join(dir, "session.jsonl") },
    abort: () => { aborts++; }, shutdown: () => { shutdowns++; }, isIdle: () => !busy,
  };
  const emit = async (name: string, event = {}) => { if (name === "agent_settled") busy = false; return hooks.get(name)?.(event, ctx); };
  const pi: any = {
    on: (name: string, fn: Function) => hooks.set(name, fn), registerCommand: (name: string, command: any) => commands.set(name, command),
    setModel: async (model: any) => { ctx.model = model; return true; },
    setActiveTools: (tools: string[]) => { activeTools = tools; }, getActiveTools: () => activeTools,
    setSessionName: (name: string) => { sessionName = name; }, getSessionName: () => sessionName,
    sendUserMessage: (message: string, options: any) => {
      busy = true; assert.equal(options.expandPromptTemplates, false);
      void emit("input", { text: message, source: "extension" }).then(async result => {
        assert.equal(result.action, "continue"); await emit("before_agent_start"); prompts.push(message);
      });
    },
    sendMessage: (message: any, options: any) => { assert.equal(options.deliverAs, "steer"); assert(busy); messages.push(message); },
  };
  const server = createServer(socket => {
    peer = socket; const frames = new Frames(); socket.on("error", () => {});
    socket.on("data", chunk => frames.push(chunk, v => events.push(record(v))));
  });
  await new Promise<void>(resolve => server.listen(m.socket, resolve));
  const progressed: unknown[] = [];
  registerChild(pi, join(dir, "child.json"), () => {}, progress => progressed.push(progress));
  const until = async (predicate: () => unknown) => {
    const limit = performance.now() + 3000;
    while (!predicate()) { if (performance.now() > limit) throw new Error(`Timed out; events ${JSON.stringify(events)}; notices ${notices}`); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  t.after(async () => {
    await emit("session_shutdown"); peer?.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  await emit("session_start"); await until(() => events.some(v => v.type === "ready"));
  const request = (message: object) => { const requestId = randomUUID(); send(peer!, { id: m.id, requestId, ...message }); return requestId; };
  const dispatch = async (taskId = randomUUID()) => {
    const requestId = request({ type: "dispatch", taskId, task: "Selected task", context: "Small context", deadline: Date.now() + m.role.timeoutMs });
    await until(() => events.some(v => v.requestId === requestId));
    if (events.find(v => v.requestId === requestId)?.type === "accepted") await until(() => prompts.some(v => v.includes(taskId)));
    return taskId;
  };
  const answer = async (value = "Answer") => {
    await emit("message_end", { message: { role: "assistant", provider: m.role.provider, model: m.role.model,
      stopReason: "stop", content: [{ type: "text", text: value }], usage: { input: 10, output: 20 } } });
  };
  const settle = async (taskId: string, aborted = false) => { await emit("agent_settled", { aborted }); await until(() => events.some(v => v.type === "result" && v.taskId === taskId)); };
  return { m, ctx, pi, commands, events, prompts, messages, notices, progressed, emit, until, request, dispatch, answer, settle,
    get peer() { return peer!; }, get aborts() { return aborts; }, get shutdowns() { return shutdowns; } };
}

test("persistent child settles each task independently and retains full immutable answers", async t => {
  const h = await harness(t), first = await h.dispatch();
  assert.match(h.prompts[0], /data, not additional authority/);
  assert.equal(h.pi.getSessionName(), "scout: Selected task");
  assert.equal(JSON.parse(await readFile(join(h.m.dir, "tasks", first, "accepted.json"), "utf8")).taskId, first);
  const full = "Answer ".repeat(500); await h.answer(full); await h.emit("agent_end");
  assert(!h.events.some(v => v.type === "result")); await h.settle(first);
  const result = h.events.find(v => v.type === "result");
  assert.equal(result.status, "succeeded"); assert.match(result.text, /truncated/); assert.equal(result.usage.input, 10);
  const file = join(h.m.dir, "tasks", first, "result.json"), original = await readFile(file, "utf8");
  assert.equal(JSON.parse(original).text, full);
  const second = await h.dispatch(); await h.answer("Second answer"); await h.settle(second);
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal(h.events.find(v => v.type === "result" && v.taskId === second).usage.input, 10);
  assert.deepEqual(await h.emit("cache_warming_decision"), { action: "stop" });
  assert.deepEqual(await h.emit("session_before_compact", { reason: "manual" }), { cancel: true });
});
test("duplicate task IDs and concurrent dispatch never execute twice", async t => {
  const h = await harness(t), first = await h.dispatch();
  await h.dispatch(first); assert.equal(h.prompts.length, 1); assert.equal(h.events.at(-1).type, "error");
  await h.answer(); await h.settle(first);
  await h.dispatch(first); assert.equal(h.prompts.length, 1); assert.match(h.events.at(-1).text, /EEXIST/);
  assert.equal(h.aborts, 0);
});
test("steering is labelled and task-bound, including the settlement/persistence race", async t => {
  const h = await harness(t), first = await h.dispatch();
  const one = h.request({ type: "steer", taskId: first, text: "Focus here" });
  await h.until(() => h.events.some(v => v.requestId === one));
  assert.equal(h.messages.length, 1); assert.match(h.messages[0].content, /Parent agent message/);
  h.request({ type: "steer", requestId: one, taskId: first, text: "Duplicate" });
  await h.until(() => h.events.some(v => v.type === "error" && v.requestId === one));
  assert.equal(h.messages.length, 1);
  let idleChecks = 0; h.ctx.isIdle = () => ++idleChecks > 1;
  const late = h.request({ type: "steer", taskId: first, text: "Too late" });
  await h.until(() => h.events.some(v => v.requestId === late));
  assert.equal(h.messages.length, 1); assert.match(h.events.find(v => v.requestId === late).text, /settled before delivery/);
});
test("cancellation waits for Pi settlement, then permits another task", async t => {
  const h = await harness(t), first = await h.dispatch();
  const cancel = h.request({ type: "cancel", taskId: first });
  await h.until(() => h.events.some(v => v.requestId === cancel)); assert(h.aborts > 0);
  assert(!h.events.some(v => v.type === "result"));
  assert.equal((await h.emit("tool_call", { toolName: "read" })).block, true);
  await h.settle(first, true);
  assert.equal(h.events.find(v => v.type === "result" && v.taskId === first).status, "cancelled");
  const second = await h.dispatch(); assert.notEqual(second, first); assert.equal(h.prompts.length, 2);
  // A reason from the parent (its deadline, say) is what the receipt reports.
  const timed = h.request({ type: "cancel", taskId: second, text: " Task deadline exceeded " });
  await h.until(() => h.events.some(v => v.requestId === timed));
  await h.settle(second, true);
  assert.equal(h.events.find(v => v.type === "result" && v.taskId === second).text, "Task deadline exceeded");
});
test("takeover requires idle, persists ownership, preserves tool policy, and survives reload", async t => {
  const h = await harness(t), task = await h.dispatch();
  const denied = h.request({ type: "take" }); await h.until(() => h.events.some(v => v.requestId === denied));
  assert.match(h.events.find(v => v.requestId === denied).text, /Finish|Cancel|finish/);
  await h.answer(); await h.settle(task);
  await h.commands.get("take").handler("", h.ctx);
  assert.equal(await readOwner(h.m.dir, h.m.id), "human");
  assert.deepEqual(await h.emit("input", { source: "interactive", text: "Human task" }), { action: "continue" });
  assert.equal(await h.emit("session_before_switch"), undefined);
  await assert.rejects(h.emit("user_bash"), /worker role/);
  assert.equal((await h.emit("tool_call", { toolName: "bash" })).block, true);
  assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined);
  await h.emit("session_shutdown"); registerChild(h.pi, join(h.m.dir, "child.json")); await h.emit("session_start");
  assert.deepEqual(await h.emit("input", { source: "interactive", text: "Still human" }), { action: "continue" });
});
test("closure and local takeover use one exclusive ownership claim", async t => {
  const h = await harness(t);
  assert.equal(await claimOwner(h.m.dir, h.m.id, "closing"), true);
  await assert.rejects(h.commands.get("take").handler("", h.ctx), /closure/);
  assert.equal(await readOwner(h.m.dir, h.m.id), "closing");
  assert.deepEqual(await h.emit("input", { source: "interactive", text: "No" }), { action: "handled" });
});
test("managed runtime restart cannot reconnect or reset task budgets", async t => {
  const h = await harness(t); await h.emit("session_shutdown");
  registerChild(h.pi, join(h.m.dir, "child.json")); await h.emit("session_start");
  assert(h.notices.some(v => /EEXIST/.test(v))); assert.equal(h.events.filter(v => v.type === "ready").length, 1);
  assert.deepEqual(await h.emit("input", { source: "extension", text: "Replay" }), { action: "handled" });
});
test("parent disconnect aborts unattended work and requests shutdown", async t => {
  const h = await harness(t), task = await h.dispatch(); h.peer.destroy();
  await h.until(() => h.shutdowns > 0); assert(h.aborts > 0);
  await h.emit("agent_settled", { aborted: true });
  assert.equal(JSON.parse(await readFile(join(h.m.dir, "tasks", task, "result.json"), "utf8")).status, "cancelled");
});
// A running process sees every one-second tick; one large jump would look like a suspension.
const elapse = (t: any, ms: number) => { for (let at = 0; at < ms; at += 1000) t.mock.timers.tick(1000); };
test("parent heartbeat lease expires even while its socket remains open", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const h = await harness(t), task = await h.dispatch(); elapse(t, LEASE_MS + 2000);
  await h.until(() => h.shutdowns > 0); assert(h.aborts > 0); await h.settle(task, true);
  assert.match(h.events.find(v => v.type === "result").text, /lease expired/);
});
test("a suspended process restarts the lease and deadline clocks instead of expiring", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const h = await harness(t), task = await h.dispatch();
  t.mock.timers.tick(2000);
  // System sleep: wall time jumps an hour while no timer or ping runs.
  t.mock.timers.setTime(Date.now() + 3_600_000);
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.shutdowns, 0); assert.equal(h.aborts, 0);
  // Awake again with no ping from the parent, the lease still runs out.
  elapse(t, LEASE_MS + 2000);
  await h.until(() => h.shutdowns > 0); await h.settle(task, true);
  assert.match(h.events.find(v => v.type === "result").text, /lease expired/);
});
test("model and turn policy is enforced for each managed task", async t => {
  const h = await harness(t), task = await h.dispatch();
  assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined);
  await h.emit("turn_start"); await h.emit("turn_start"); await h.emit("turn_start");
  assert.equal((await h.emit("tool_call", { toolName: "read" })).block, true);
  await h.emit("turn_start"); assert(h.aborts > 0);
  h.ctx.model = { ...h.ctx.model, id: "other" }; await h.emit("model_select"); await h.settle(task);
  assert.equal(h.events.find(v => v.type === "result").status, "failed");
});
test("an ask names the wait, and waiting for the user extends the task deadline", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const h = await harness(t), taskId = randomUUID();
  const requestId = h.request({ type: "dispatch", taskId, task: "Ask", context: "", deadline: Date.now() + 2000 });
  await h.until(() => h.prompts.some(v => v.includes(taskId))); assert(h.events.some(v => v.requestId === requestId && v.type === "accepted"));
  await h.emit("tool_execution_start", { toolName: "ask_user_question", args: { questions: [{ question: "Which database?" }] } });
  await h.emit("ui_prompt_start", { kind: "custom" });
  await h.until(() => h.events.some(v => v.type === "progress" && v.text === "Waiting for user: Which database?"));
  t.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.aborts, 0);
  await h.emit("tool_execution_start", { toolName: "read", args: { path: "x" } });
  await h.answer("Still asking");
  await h.until(() => h.events.filter(v => v.type === "progress").length >= 3);
  assert.equal(h.events.filter(v => v.type === "progress").at(-1).text, "Waiting for user: Which database?");
  await h.emit("ui_prompt_end", { kind: "custom" });
  await h.until(() => h.events.at(-1)?.text === "Running");
  t.mock.timers.tick(1000); assert.equal(h.aborts, 0);
  t.mock.timers.tick(1500); assert(h.aborts > 0);
  await h.settle(taskId, true);
  assert.match(h.events.find(v => v.type === "result").text, /deadline expired/);
});

test("activity names the tool and its main argument on one bounded line", () => {
  assert.equal(activity("read", { path: "docs/rex.md", offset: 3 }), "read docs/rex.md");
  assert.equal(activity("bash", { command: "npm test\nrm -rf /" }), "bash npm test");
  assert.equal(activity("grep", { pattern: "a\u001b[2Jb" }), "grep a [2Jb");
  assert.equal(activity("todo", undefined), "todo");
  assert.equal(activity("read", { path: "/repo/src/a.ts" }, "/repo"), "read src/a.ts");
  assert.equal(activity("find", { path: "/repo" }, "/repo"), "find .");
  assert.equal(activity("read", { path: `${process.env.HOME}/notes.md` }, "/repo"), "read ~/notes.md");
  assert.equal(activity("bash", { command: "x".repeat(200) }).length, 80);
});

test("typing into a managed child steers its running task, or asks the parent to start a follow-up when idle", async t => {
  const h = await harness(t), first = await h.dispatch();
  // Running: Pi queues the text into the agent, inside the task the parent awaits.
  assert.deepEqual(await h.emit("input", { source: "interactive", text: "Look at the tests too", streamingBehavior: "steer" }), { action: "continue" });
  await h.answer(); await h.settle(first);
  // Idle: the parent is asked to start it, once.
  assert.deepEqual(await h.emit("input", { source: "interactive", text: "Now fix them" }), { action: "handled" });
  await h.until(() => h.events.some(v => v.type === "request"));
  const asked = h.events.find(v => v.type === "request");
  assert.equal(asked.text, "Now fix them");
  assert.deepEqual(await h.emit("input", { source: "interactive", text: "Again" }), { action: "handled" });
  assert.equal(h.events.filter(v => v.type === "request").length, 1); assert.match(h.notices.at(-1)!, /already on its way/);
  // The parent declines (say it just dispatched its own task): the user can type again.
  send(h.peer, { id: h.m.id, type: "declined", requestId: asked.requestId, text: "Child is busy" });
  await h.until(() => h.notices.some(v => /could not start your follow-up: Child is busy/.test(v)));
  assert.deepEqual(await h.emit("input", { source: "interactive", text: "Now fix them" }), { action: "handled" });
  await h.until(() => h.events.filter(v => v.type === "request").length === 2);
  // The parent starts it: framed as the user's task.
  const taskId = randomUUID(), requestId = h.request({ type: "dispatch", taskId, task: "Now fix them", context: "", from: "user", deadline: Date.now() + h.m.role.timeoutMs });
  await h.until(() => h.prompts.some(v => v.includes(taskId)));
  assert(h.events.some(v => v.requestId === requestId && v.type === "accepted"));
  assert.equal(h.prompts.at(-1), `Task ${taskId} from the user, typed in this pane:\nNow fix them`);
  // Images cannot travel through the parent; nothing typed while retired starts work.
  await h.answer(); await h.settle(taskId);
  assert.deepEqual(await h.emit("input", { source: "interactive", text: "See this", images: [{}] }), { action: "handled" });
  assert.equal(h.events.filter(v => v.type === "request").length, 2);
});

test("progress counts the task's todo items, for the parent and for the terminal", async t => {
  const h = await harness(t);
  const list = (items: Array<[number, string]>) => ({ toolName: "todo", isError: false, result: { details: { nextId: Math.max(0, ...items.map(i => i[0])) + 1, items: items.map(([id, status]) => ({ id, status, text: `#${id}` })) } } });
  const cleared: unknown[] = []; h.pi.events = { emit: (name: string) => cleared.push(name) };
  await h.emit("tool_execution_end", list([[1, "done"], [2, "pending"]])); // Left from an earlier task.
  const task = await h.dispatch();
  assert.deepEqual(cleared, ["todo:clear"], "each task starts with an empty list");
  assert.deepEqual(h.progressed.at(-1), undefined);
  await h.emit("tool_execution_end", list([[1, "done"], [2, "in_progress"], [3, "pending"]]));
  await h.until(() => h.events.some(v => v.type === "progress" && v.total === 3));
  assert.equal(h.events.findLast(v => v.type === "progress").done, 1);
  assert.deepEqual(h.progressed.at(-1), { done: 1, total: 3 });
  await h.answer(); await h.settle(task);
  assert.equal(h.progressed.at(-1), undefined, "a settled task has no progress to show");
  assert.deepEqual(todoProgress([]), undefined);
  assert.deepEqual(todoProgress([{ status: "done" }, { status: "blocked" }]), { done: 1, total: 2 });
});

test("Pi's program status reports carry the progress while working, and are rewritten when it changes", () => {
  const working = "\x1b]7501;state=working:app=pi:msg=YQ==\x1b\\", done = "\x1b]7501;state=done:app=pi\x1b\\";
  assert.equal(withProgress(working, 42.4), "\x1b]7501;state=working:app=pi:msg=YQ==:progress=42\x1b\\");
  assert.equal(withProgress(withProgress(working, 10), 60), "\x1b]7501;state=working:app=pi:msg=YQ==:progress=60\x1b\\");
  assert.equal(withProgress(working), working); assert.equal(withProgress(done, 50), done);
  assert.equal(withProgress("\x1b]7501;?\x1b\\", 50), "\x1b]7501;?\x1b\\", "the support query passes untouched");
  const written: string[] = [], out = { write: (chunk: string) => { written.push(chunk); return true; } } as any;
  const set = registerProgressStatus(out);
  set(25); assert.deepEqual(written, [], "nothing to rewrite before Pi has reported");
  out.write(working); out.write("text");
  assert.deepEqual(written, ["\x1b]7501;state=working:app=pi:msg=YQ==:progress=25\x1b\\", "text"]);
  set(50); assert.equal(written.at(-1), "\x1b]7501;state=working:app=pi:msg=YQ==:progress=50\x1b\\");
  set(50); assert.equal(written.length, 3, "an unchanged value writes nothing");
  // A /reload registers again on the same stream: it is not wrapped twice.
  const again = registerProgressStatus(out);
  out.write(working); assert.equal(written.length, 4); assert.equal(written.at(-1), "\x1b]7501;state=working:app=pi:msg=YQ==:progress=50\x1b\\");
  again(undefined); assert.equal(written.at(-1), working);
});
