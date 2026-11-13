// Explicit live test: creates one local Rex terminal; no external model or credentials.
// Run from Rex: node tests/fixtures/rex-smoke.ts [--dispatch]
// --dispatch exercises follow-ups, steering and cancellation through a fixed provider.
// --ask also loads the ask extension and answers a question in the child pane.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RexClient } from "../../extensions/rex/client.ts";
import { childCommand, validateReady } from "../../extensions/rex/runner.ts";
import { Frames, record, send, VERSION, type Manifest } from "../../extensions/rex/protocol.ts";
import { atomicWrite, privateDir, saveJson } from "../../extensions/workflows/state.ts";

const root = fileURLToPath(new URL("../../", import.meta.url)), ask = process.argv.includes("--ask"), dispatch = ask || process.argv.includes("--dispatch");
const role = { provider: "rex-smoke", model: "fixture", thinking: "off" as const, maxTokens: 512, timeoutMs: 45_000 };
const session = process.env.REX_SESSION, parent = process.env.REX_BLOCK;
if (!session || !parent) throw new Error("Run this test from a Rex terminal");
const rex = new RexClient(); await rex.probe(session, parent);
const dir = await realpath(await mkdtemp("/tmp/pi-rex-smoke-")); await chmod(dir, 0o700);
const agentDir = join(dir, "agent"); await privateDir(agentDir);
const manifest: Manifest = { version: VERSION, id: randomUUID(), token: randomBytes(32).toString("hex"), socket: join(dir, "control"),
  dir, cwd: await realpath(process.cwd()), rexSession: session, parentBlock: parent, role, tools: ask ? ["read", "ask_user_question"] : ["read"], agent: "scout", name: "smoke", mark: "🟩", maxTurns: 2, outputBytes: 1024, deadline: Date.now() + 45_000 };
await saveJson(join(dir, "child.json"), manifest);
await atomicWrite(join(dir, "instructions.md"), "Smoke test. Respond through the fixed-response fixture only.\n");
let peer: Socket | undefined, block: string | undefined, failure: unknown;
const sockets = new Set<Socket>(), events: any[] = [];
const until = async (predicate: () => unknown, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (failure) throw failure; if (Date.now() > deadline) throw new Error(`Timed out; events: ${JSON.stringify(events)}`); await new Promise(r => setTimeout(r, 20)); }
};
const server = createServer(socket => {
  sockets.add(socket); const frames = new Frames();
  socket.on("error", error => { failure = error; });
  socket.on("data", chunk => {
    try { frames.push(chunk, value => {
      const message = record(value); events.push(message);
      if (message.type === "ready") { validateReady(value, manifest); peer = socket; }
    }); } catch (error) { failure = error; }
  });
});
const heartbeat = setInterval(() => { if (peer && !peer.destroyed) { try { send(peer, { type: "ping", id: manifest.id }); } catch {} } }, 3000);
const request = (value: object) => { const requestId = randomUUID(); send(peer!, { id: manifest.id, requestId, ...value }); return requestId; };
const view = () => JSON.parse(execFileSync("rex", ["--autostart=false", "api", "call", "--session", session, "session.view", "{}"], { encoding: "utf8" }));
const focus = (value: any) => ({ active: value.active_window_id, windows: value.windows.map((w: any) => [w.window_id, w.focused_block_id]) });
try {
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(manifest.socket, done); });
  const command = childCommand(manifest, agentDir, "personal", resolve(root, "extensions/rex/index.ts"), [resolve(root, "tests/fixtures/rex-provider.ts"), ...(ask ? [resolve(root, "extensions/ask/index.ts")] : [])]);
  // childCommand normally reuses Pi; this explicitly invoked smoke script is Node.
  const executableIndex = command.findIndex(v => v.startsWith("PI_REX_CHILD=")) + 1, invocation = command.slice(executableIndex);
  const piPath = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  block = await rex.create(session, "pi-rex-smoke", [...command.slice(0, executableIndex), piPath, ...invocation.slice(invocation.indexOf("--offline"))], manifest.cwd);
  console.log(`Created detached block: ${block}`);
  await until(() => !!peer, 25_000); assert.equal(events.find(e => e.type === "ready").block, block);
  const before = focus(view());
  await rex.peek(session, block, parent);
  const layer = view().windows.flatMap((w: any) => w.layers).find((l: any) => l.blocks.some((b: any) => b.block_id === block));
  assert.equal(layer.kind, "floating"); assert.deepEqual(focus(view()), before);
  await rex.minimize(session, block); await rex.peek(session, block, parent); assert.deepEqual(focus(view()), before);
  assert.equal(await rex.toggle(session, block, parent), "minimized");
  assert.equal(await rex.toggle(session, block, parent), "floating"); assert.deepEqual(focus(view()), before);
  await rex.keep(session, block, parent); assert.deepEqual(focus(view()), before);
  assert.equal(await rex.toggle(session, block, parent), "tiled");
  await rex.hide(session, block);
  if (dispatch) {
    const task = async (prompt: string, count: number) => {
      const taskId = randomUUID(); request({ type: "dispatch", taskId, task: prompt, context: "", deadline: Date.now() + role.timeoutMs });
      await until(() => events.some(e => e.type === "result" && e.taskId === taskId));
      const result = events.find(e => e.type === "result" && e.taskId === taskId);
      assert.equal(result.status, "succeeded", result.text); assert.equal(result.usage.totalTokens, 0);
      assert.equal(result.text, `Rex fixture completed without a model request. User messages: ${count}.`);
      return taskId;
    };
    const first = await task("Complete the smoke test", 1);
    const original = await readFile(join(dir, "tasks", first, "result.json"), "utf8");
    // The child's own screen: named header and compact task display, not the raw framing.
    const screen = execFileSync("rex", ["--autostart=false", "capture", "-s", session, "-b", block], { encoding: "utf8" });
    assert.match(screen, /🟩 smoke · scout/); assert.match(screen, /▸ Task for smoke/);
    // The parent's colour leads the terminal title, which names the tab and pane.
    const title = JSON.parse(execFileSync("rex", ["--autostart=false", "api", "call", "--session", session, "block.method", JSON.stringify({ block_id: block, method: "title" })], { encoding: "utf8" }));
    assert.match(title.title, /^🟩 smoke: Complete the smoke test/);
    assert.doesNotMatch(screen, /Delegated task|data, not additional authority/);
    // One-line footer: status and usage share a line; Pi's cwd/branch footer is gone.
    assert.match(screen, /(Managed task|Ready for follow-up)[^\n]*↑\S+ ↓\S+[^\n]*fixture/);
    console.log(screen.trimEnd().split("\n").slice(-4).join("\n"));
    await task("Follow up in the same conversation", 2);
    assert.equal(await readFile(join(dir, "tasks", first, "result.json"), "utf8"), original);
    const taskId = randomUUID(); request({ type: "dispatch", taskId, task: "Wait for cancellation fixture", context: "", deadline: Date.now() + role.timeoutMs });
    await until(() => events.some(e => e.type === "progress" && e.taskId === taskId));
    const steer = request({ type: "steer", taskId, text: "Parent message for the active task" });
    await until(() => events.some(e => e.requestId === steer));
    assert.equal(events.find(e => e.requestId === steer).type, "ack");
    request({ type: "cancel", taskId });
    await until(() => events.some(e => e.type === "result" && e.taskId === taskId));
    assert.equal(events.find(e => e.type === "result" && e.taskId === taskId).status, "cancelled");
    await task("Continue after cancellation", 4);
    if (ask) {
      // The wait is named after the question, and Rex input reaches the child's dialog.
      const taskId = randomUUID(); request({ type: "dispatch", taskId, task: "Ask the user fixture", context: "", deadline: Date.now() + role.timeoutMs });
      await until(() => events.some(e => e.type === "progress" && e.taskId === taskId && e.text === "Waiting for user: Pick one?"));
      execFileSync("rex", ["--autostart=false", "send-key", "-s", session, "-b", block, "2"]);
      await until(() => events.some(e => e.type === "result" && e.taskId === taskId));
      const result = events.find(e => e.type === "result" && e.taskId === taskId);
      assert.equal(result.status, "succeeded", result.text); assert.match(result.text, /Pick one\? → Beta/);
      // Esc in a managed child hands the questions back instead of ending the task without an answer.
      const back = randomUUID(); request({ type: "dispatch", taskId: back, task: "Ask the user fixture", context: "", deadline: Date.now() + role.timeoutMs });
      await until(() => events.some(e => e.type === "progress" && e.taskId === back && e.text === "Waiting for user: Pick one?"));
      execFileSync("rex", ["--autostart=false", "send-key", "-s", session, "-b", block, "escape"]);
      await until(() => events.some(e => e.type === "result" && e.taskId === back));
      const handed = events.find(e => e.type === "result" && e.taskId === back);
      assert.equal(handed.status, "succeeded", handed.text); assert.match(handed.text, /through your parent agent/);
    }
  }
  const take = request({ type: "take" });
  await until(() => events.some(e => e.type === "ownership" && e.requestId === take));
  assert.equal(JSON.parse(await readFile(join(dir, "owner.json"), "utf8")).owner, "human");
  console.log(`Passed: native peek/toggle/keep/park with focus preserved; ${dispatch ? "persistent tasks, steering, cancellation; " : ""}${ask ? "a question answered and one handed back in the child; " : ""}explicit takeover. No external model requests.`);
} catch (error) {
  console.error(`Smoke failed. Block: ${block ?? "unknown"}. Cleaning up the test terminal and files.`); throw error;
} finally {
  clearInterval(heartbeat);
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise<void>(done => server.close(() => done()));
  // This is the fixture's own terminal, explicitly disposed even after its takeover test.
  if (block) await rex.close(session, block);
  await rm(dir, { recursive: true, force: true });
}
