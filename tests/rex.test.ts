import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ChildState } from "../extensions/rex/child.ts";
import { childCommand, RexRunner, validateReady, waitFor, type RexBackend } from "../extensions/rex/runner.ts";
import { claimOwner, FRAME_BYTES, Frames, record, send, validateManifest, VERSION, type Manifest } from "../extensions/rex/protocol.ts";
import { emptyUsage } from "../extensions/workflows/process.ts";
import { saveJson } from "../extensions/workflows/state.ts";
import { config, registry, root, temporary } from "./helpers.ts";

const session = "session:11111111-1111-1111-1111-111111111111", parent = "block:22222222-2222-2222-2222-222222222222";
const identity = { hostId: "44444444-4444-4444-4444-444444444444", instanceId: "55555555-5555-5555-5555-555555555555", sessionId: session, parentBlock: parent };
const manifest = (): Manifest => ({ version: VERSION, id: randomUUID(), token: "a".repeat(64), socket: "/tmp/example/control", dir: "/tmp/example", cwd: "/tmp",
  rexSession: session, parentBlock: parent, role: config.roles.task!, tools: ["read"], maxTurns: 4, outputBytes: 1024, deadline: Date.now() + 60_000 });
const ready = (m: Manifest, block = `block:${randomUUID()}`) => ({ type: "ready", version: VERSION, id: m.id, token: m.token, block, rexSession: session,
  cwd: m.cwd, provider: m.role.provider, model: m.role.model, sessionId: "child-session", sessionFile: join(m.dir, "session.jsonl"), tools: m.tools });
function environment(t: any) {
  const old = { REX_SESSION: process.env.REX_SESSION, REX_BLOCK: process.env.REX_BLOCK, PI_REX_CHILD: process.env.PI_REX_CHILD };
  process.env.REX_SESSION = session; process.env.REX_BLOCK = parent; delete process.env.PI_REX_CHILD;
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const context = (cwd = root) => ({ mode: "tui", cwd, modelRegistry: registry(), sessionManager: { getSessionId: () => "parent-session", getLeafId: () => "entry" } }) as any;
const pi = { getAllTools: () => [] } as any;
async function until(predicate: () => unknown) {
  const limit = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > limit) throw new Error("Timed out"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function backend(behavior: "success" | "disconnect" | "wait" | "no-hello" | "lost-receipt" | "lost-take" | "late-cancel" = "success") {
  const calls: string[] = [], labels: string[] = [], messages: any[] = [], children = new Map<string, { socket: ReturnType<typeof connect>; emit: (v: any) => void; manifest: Manifest; block: string }>();
  const rex: RexBackend = {
    async probe() { return identity; },
    async create(_s, label, command, cwd) {
      calls.push("create"); labels.push(label);
      const file = command.find(v => v.startsWith("PI_REX_CHILD="))!.slice("PI_REX_CHILD=".length);
      const m: Manifest = JSON.parse(await readFile(file, "utf8")), block = `block:${randomUUID()}`;
      assert.equal(m.cwd, cwd); assert.equal((await stat(file)).mode & 0o777, 0o600);
      if (behavior === "no-hello") return block;
      const socket = connect(m.socket), frames = new Frames(); let seq = 0;
      const emit = (v: any) => send(socket, { id: m.id, seq: ++seq, ...v });
      children.set(m.id, { socket, emit, manifest: m, block });
      socket.on("error", () => {});
      await new Promise<void>(resolve => socket.on("connect", () => { send(socket, ready(m, block)); resolve(); }));
      socket.on("data", chunk => frames.push(chunk, value => {
        const event = record(value); messages.push(event);
        if (event.type === "dispatch") {
          calls.push("dispatch");
          if (behavior === "disconnect") { socket.destroy(); return; }
          emit({ type: "accepted", requestId: event.requestId, taskId: event.taskId });
          if (!["wait", "late-cancel"].includes(behavior)) emit({ type: "result", taskId: event.taskId, status: "succeeded", text: event.task, usage: { ...emptyUsage(), input: 3, totalTokens: 3 } });
        }
        if (event.type === "steer") emit({ type: "ack", requestId: event.requestId, taskId: event.taskId });
        if (event.type === "cancel") {
          if (behavior === "late-cancel") {
            emit({ type: "result", taskId: event.taskId, status: "succeeded", text: "Finished first", usage: emptyUsage() });
            setTimeout(() => emit({ type: "error", requestId: event.requestId, text: "Task no longer active" }), 30);
            return;
          }
          calls.push("cancel"); emit({ type: "ack", requestId: event.requestId, taskId: event.taskId });
          emit({ type: "result", taskId: event.taskId, status: "cancelled", text: "Stopped", usage: { ...emptyUsage(), input: 4, totalTokens: 4 } });
        }
        if (event.type === "take") {
          if (behavior !== "lost-take") emit({ type: "ownership", requestId: event.requestId, owner: "human" });
          socket.end();
        }
      }));
      if (behavior === "lost-receipt") { await new Promise(resolve => setTimeout(resolve, 10)); throw new Error("creation response timed out; outcome unknown"); }
      return block;
    },
    async close(_s, block) { calls.push("close"); [...children.values()].find(c => c.block === block)?.socket.destroy(); },
    async show() { calls.push("show"); }, async hide() { calls.push("park"); }, async keep() { calls.push("keep"); },
    async peek() { calls.push("peek"); }, async minimize() { calls.push("minimize"); },
    async toggle() { calls.push("toggle"); return "floating" as const; },
  };
  return { rex, calls, labels, messages, children };
}
async function harness(t: any, behavior: Parameters<typeof backend>[0] = "success") {
  environment(t); const dir = await temporary(t), fake = backend(behavior), runner = new RexRunner(pi, root, dir, fake.rex);
  t.after(() => runner.shutdown());
  return { runner, fake, dir, open: (title = "", name?: string, c = config) => runner.open("scout", c, context(), "Approved instructions", new AbortController().signal, () => {}, title, name) };
}
const signal = () => new AbortController().signal;

test("Rex frames handle UTF-8 splits and reject malformed/oversized records", () => {
  const bytes = Buffer.from(JSON.stringify({ text: "日本語" }) + "\n"), parser = new Frames(), values: unknown[] = [];
  for (const byte of bytes) parser.push(Buffer.from([byte]), v => values.push(v));
  assert.deepEqual(values, [{ text: "日本語" }]);
  assert.throws(() => new Frames().push(Buffer.from("nope\n"), () => {}));
  assert.throws(() => new Frames().push(Buffer.from("x".repeat(FRAME_BYTES + 1)), () => {}), /too large/);
});
test("versioned handshake pins model, tools, cwd, block, session and capability", () => {
  const m = manifest(), hello = ready(m);
  assert.equal(validateReady(hello, m).block, hello.block);
  for (const patch of [{ model: "other" }, { token: "b".repeat(64) }, { token: "☃".repeat(64) }, { cwd: "/" }, { block: parent }, { tools: ["bash"] }, { sessionFile: "/tmp/other" }, { version: 1 }]) assert.throws(() => validateReady({ ...hello, ...patch }, m));
  assert.equal(validateManifest(m).id, m.id);
  assert.throws(() => validateManifest({ ...m, deadline: 0 }), /expired/);
});
test("interactive argv omits print flags, prompt, credentials and parent Rex identity", () => {
  const command = childCommand(manifest(), "/private/agent", "work", "/ext/index.ts", ["/routing/index.ts"]);
  assert(command.includes("--session")); assert(command.includes("--no-extensions"));
  for (const forbidden of ["-p", "--mode", "--no-session", "--api-key", "--no-approve"]) assert(!command.includes(forbidden));
  assert(!command.some(v => v.startsWith("REX_")));
  // Rex starts blocks with the server's environment; the parent's PATH carries fd/rg.
  if (process.env.PATH) assert(command.includes(`PATH=${process.env.PATH}`));
  assert(command.indexOf(`PATH=${process.env.PATH}`) < command.findIndex(v => v.startsWith("PI_REX_CHILD=")));
});
test("child completion permits retry recovery but rejects unexpected model", () => {
  const m = manifest(), state = new ChildState(m); state.active = true;
  const message = (stopReason: string) => ({ role: "assistant", provider: m.role.provider, model: m.role.model, stopReason, content: [{ type: "text", text: "Answer" }], usage: { input: 2 } });
  state.message(message("error")); assert.equal(state.settled(false).status, "failed");
  state.message(message("stop")); assert.equal(state.settled(false).status, "succeeded"); assert.equal(state.usage.input, 4);
  state.message({ ...message("stop"), model: "other" }); assert.match(state.settled(false).text, /unexpected model/);
});
test("persistent child handles distinct follow-ups and immutable, once-accounted results", async t => {
  const h = await harness(t), run = await h.open();
  const one = await h.runner.submit(run.id, "First task", "", signal()); await h.runner.wait(one.id, signal());
  const first = structuredClone(one);
  const two = await h.runner.submit(run.id, "Second task", "Selected context", signal()); await h.runner.wait(two.id, signal());
  assert.notEqual(one.id, two.id); assert.deepEqual(one, first); assert.equal(two.text, "Second task");
  assert.equal(h.fake.calls.filter(v => v === "create").length, 1);
  const usage = await Promise.all([h.runner.collect(one.id), h.runner.collect(one.id)]);
  assert.equal(usage.filter(Boolean).length, 1); assert.equal(usage.find(Boolean)!.input, 3);
  assert.equal((await h.runner.collect(two.id))!.input, 3);
  await h.runner.action(run, "peek"); await h.runner.action(run, "hide"); await h.runner.action(run, "keep"); await h.runner.action(run, "park");
  assert.equal(await h.runner.action(run, "toggle"), "floating");
  assert.deepEqual(h.fake.calls.slice(-5), ["peek", "minimize", "keep", "park", "toggle"]);
  const m = h.fake.children.get(run.id)!.manifest;
  await h.runner.shutdown();
  assert(!h.fake.calls.includes("close")); assert.equal(run.owner, "retired");
  await assert.rejects(stat(m.socket), { code: "ENOENT" });
});
test("asynchronous dispatch supports concurrent children; cancelling a wait leaves work running", async t => {
  const h = await harness(t, "wait"), c = { ...config, subagents: { ...config.subagents, rexConcurrency: 2 } };
  const [a, b] = await Promise.all([h.runner.open("scout", c, context(), "", signal()), h.runner.open("scout", c, context(), "", signal())]);
  await assert.rejects(h.runner.open("scout", c, context(), "", signal()), /limit \(2, subagents\.rexConcurrency\) reached/);
  const one = await h.runner.submit(a.id, "One", "", signal()), two = await h.runner.submit(b.id, "Two", "", signal());
  assert.equal(one.status, "running"); assert.equal(two.status, "running");
  await assert.rejects(h.runner.wait(one.id, AbortSignal.abort(new Error("stop waiting"))), /stop waiting/);
  assert.equal(one.status, "running"); assert(!h.fake.calls.includes("cancel"));
  h.fake.children.get(a.id)!.emit({ type: "result", taskId: one.id, status: "succeeded", text: "done", usage: emptyUsage() });
  await h.runner.wait(one.id, signal()); assert.equal(two.status, "running");
  await h.runner.shutdown(); assert.equal(two.status, "cancelled");
});
test("steering is task-addressed; cancellation settles before follow-up", async t => {
  const h = await harness(t, "wait"), run = await h.open(), one = await h.runner.submit(run.id, "One", "", signal());
  await h.runner.steer(run.id, one.id, "Focus here", signal());
  await h.runner.cancel(run.id);
  assert.equal(one.status, "cancelled"); assert.equal(one.usage.input, 4); assert.equal(run.status, "idle");
  const two = await h.runner.submit(run.id, "Two", "", signal());
  await assert.rejects(h.runner.steer(run.id, one.id, "Late message", signal()), /no longer active/);
  assert.equal(h.fake.messages.filter(v => v.type === "steer").length, 1);
  assert.equal(two.status, "running");
});
test("a late cancellation rejection never cancels a newer task", async t => {
  const h = await harness(t, "late-cancel"), run = await h.open(), first = await h.runner.submit(run.id, "First", "", signal());
  let followup: ReturnType<typeof h.runner.submit> | undefined;
  h.runner.onResult = task => { if (task.id === first.id) followup = h.runner.submit(run.id, "Second", "", signal()); };
  await h.runner.cancel(run.id);
  const second = await followup!;
  assert.equal(first.status, "succeeded"); assert.equal(second.status, "running"); assert.equal(run.owner, "managed");
  assert(!h.fake.calls.includes("close"));
});

test("explicit takeover relinquishes control without changing presentation or closing the child", async t => {
  const h = await harness(t), run = await h.open();
  await h.runner.take(run.id); assert.equal(run.owner, "human");
  await assert.rejects(h.runner.submit(run.id, "No", "", signal()), /not available/);
  await assert.rejects(h.runner.action(run, "close"), /no longer parent-owned/);
  await h.runner.shutdown(); assert(!h.fake.calls.includes("close")); assert(!h.fake.calls.includes("peek"));
});
test("ambiguous takeover protects the terminal from automatic cleanup", async t => {
  const h = await harness(t, "lost-take"), run = await h.open();
  await assert.rejects(h.runner.take(run.id), /channel closed/);
  assert.equal(run.owner, "unknown"); await h.runner.shutdown(); assert(!h.fake.calls.includes("close"));
});
test("local child takeover is recognized even without a parent request", async t => {
  const h = await harness(t), run = await h.open();
  h.fake.children.get(run.id)!.emit({ type: "ownership", owner: "human" });
  await until(() => run.owner === "human"); await h.runner.shutdown(); assert(!h.fake.calls.includes("close"));
});
for (const behavior of ["disconnect", "lost-receipt"] as const) test(`unknown outcomes never cause replay: ${behavior}`, async t => {
  const h = await harness(t, behavior);
  if (behavior === "lost-receipt") await assert.rejects(h.open(), /timed out/);
  else { const run = await h.open(); await assert.rejects(h.runner.submit(run.id, "One", "", signal()), /channel closed|not confirmed/); }
  await until(() => h.fake.calls.includes("close"));
  assert.equal(h.fake.calls.filter(v => v === "create").length, 1);
});
test("shutdown interrupts startup and closes a late creation receipt", async t => {
  const h = await harness(t, "no-hello"), opening = h.open(); void opening.catch(() => {});
  await until(() => h.fake.calls.includes("create")); await h.runner.shutdown();
  await assert.rejects(opening, /Parent session closed/); assert(h.fake.calls.includes("close"));
});
test("restore retains results, never adopts live work or another parent's children", async t => {
  const h = await harness(t), run = await h.open(), task = await h.runner.submit(run.id, "First", "", signal());
  await h.runner.wait(task.id, signal()); await h.runner.collect(task.id); await h.runner.shutdown();
  const next = new RexRunner(pi, root, h.dir, h.fake.rex);
  await next.restore([{ id: run.id, profile: run.profile }], context());
  assert.equal(next.runs.get(run.id)!.owner, "retired"); assert.equal(next.tasks.get(task.id)!.text, "First");
  assert.equal(await next.collect(task.id), undefined);
  await assert.rejects(next.submit(run.id, "Again", "", signal()), /not available/);
  const fork = new RexRunner(pi, root, h.dir, h.fake.rex);
  await fork.restore([{ id: run.id, profile: run.profile }], { ...context(), sessionManager: { getSessionId: () => "another-parent" } });
  assert.equal(fork.runs.size, 0);
});
test("durable human ownership wins cleanup even when its channel receipt is lost", async t => {
  const h = await harness(t), run = await h.open();
  await claimOwner(run.dir, run.id, "human");
  await assert.rejects(h.runner.action(run, "close"), /Ownership/);
  assert.equal(run.owner, "human"); assert(!h.fake.calls.includes("close"));
  const next = new RexRunner(pi, root, h.dir, h.fake.rex);
  await next.restore([{ id: run.id, profile: run.profile }], context());
  assert.equal(next.runs.get(run.id)!.owner, "human");
});
test("disconnect reconciles a durable child result without replaying the task", async t => {
  const h = await harness(t, "wait"), run = await h.open(), task = await h.runner.submit(run.id, "One", "", signal());
  await saveJson(task.resultFile, { id: run.id, taskId: task.id, status: "succeeded", text: "Durable answer", usage: { ...emptyUsage(), input: 9, totalTokens: 9 } });
  h.fake.children.get(run.id)!.socket.destroy();
  await h.runner.wait(task.id, signal());
  assert.equal(task.status, "succeeded"); assert.equal(task.text, "Durable answer"); assert.equal(task.usage.input, 9);
  assert.equal(h.fake.calls.filter(v => v === "dispatch").length, 1);
});
test("concurrent completion, notification and collection preserve durable accounting", async t => {
  const h = await harness(t), run = await h.open();
  h.runner.onResult = task => { void h.runner.markNotified(task); };
  const task = await h.runner.submit(run.id, "One", "", signal());
  await h.runner.wait(task.id, signal()); await h.runner.collect(task.id); await h.runner.shutdown();
  const stored = JSON.parse(await readFile(join(run.dir, "tasks", task.id, "task.json"), "utf8"));
  assert.equal(stored.notified, true); assert.equal(stored.collected, true);
});

test("children get unique names, labels, and name lookup; invalid or duplicate names fail before launch", async t => {
  const h = await harness(t), c = { ...config, subagents: { ...config.subagents, rexConcurrency: 4 } };
  const one = await h.open("Find the\nentry points", undefined, c), two = await h.open("", "auth-scan", c);
  assert.equal(one.name, "birch"); assert.equal(two.name, "auth-scan");
  assert.deepEqual(h.fake.labels, ["birch · scout · Find the entry points", "auth-scan · scout"]);
  assert.equal(h.fake.children.get(one.id)!.manifest.name, "birch");
  assert.equal(h.runner.child("auth-scan"), two); assert.equal(h.runner.child(one.id.slice(0, 8)), one);
  assert.throws(() => h.runner.child("nobody"), /No child named/);
  await assert.rejects(h.open("", "auth-scan", c), /already exists/);
  await assert.rejects(h.open("", "Bad Name", c), /lowercase/);
  assert.equal(h.fake.calls.filter(v => v === "create").length, 2);
  assert.equal((await h.open("", undefined, c)).name, "cedar");
});
test("next returns unread results oldest first, then waits across children", async t => {
  const h = await harness(t, "wait"), c = { ...config, subagents: { ...config.subagents, rexConcurrency: 3 } };
  const a = await h.open("", "a-one", c), b = await h.open("", "b-two", c);
  await assert.rejects(h.runner.next(signal()), /No Rex tasks are running/);
  const ta = await h.runner.submit(a.id, "A", "", signal()), tb = await h.runner.submit(b.id, "B", "", signal());
  const waiting = h.runner.next(signal());
  h.fake.children.get(b.id)!.emit({ type: "result", taskId: tb.id, status: "succeeded", text: "B done", usage: emptyUsage() });
  assert.equal((await waiting).id, tb.id);
  h.fake.children.get(a.id)!.emit({ type: "result", taskId: ta.id, status: "succeeded", text: "A done", usage: emptyUsage() });
  await h.runner.wait(ta.id, signal());
  assert.equal((await h.runner.next(signal())).id, tb.id, "unread results are returned until collected");
  await h.runner.collect(tb.id);
  assert.equal((await h.runner.next(signal())).id, ta.id);
  await h.runner.collect(ta.id);
  await assert.rejects(h.runner.next(signal()), /every result has been read/);
  const cancelled = new AbortController(), t2 = await h.runner.submit(a.id, "A2", "", signal());
  const pending = h.runner.next(cancelled.signal); cancelled.abort(new Error("stop"));
  await assert.rejects(pending, /stop/); assert.equal(t2.status, "running");
});

test("noninteractive modes and missing roles refuse launch", async t => {
  const h = await harness(t);
  for (const mode of ["print", "json", "rpc"]) await assert.rejects(h.runner.open("scout", config, { ...context(), mode }, "", signal()), /interactive/);
  await assert.rejects(h.runner.open("scout", { ...config, roles: { ...config.roles, task: null } }, context(), "", signal()), /no fallback/);
  assert.equal(h.fake.calls.length, 0);
});
test("waitFor handles a pre-aborted signal without unhandled rejection", async () => {
  await assert.rejects(waitFor(Promise.reject(new Error("late")), AbortSignal.abort(new Error("cancel"))), /cancel/);
});
