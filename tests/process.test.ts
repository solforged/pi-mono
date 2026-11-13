import assert from "node:assert/strict";
import test from "node:test";
import { JsonLines, runProcess, Semaphore, stopped, timeoutSignal } from "../extensions/workflows/process.ts";

test("JSON framing survives split UTF-8 and Unicode separators; cancellation kills a stubborn child", async () => {
  const values: any[] = [];
  const lines = new JsonLines((event) => values.push(event));
  const data = Buffer.from(JSON.stringify({ text: "猫\u2028one" }) + "\n");
  for (const byte of data) lines.push(Buffer.from([byte]));
  lines.finish();
  assert.deepEqual(values, [{ text: "猫\u2028one" }]);
  const controller = new AbortController();
  let pid = 0;
  await assert.rejects(runProcess(process.execPath, ["-e", 'process.on("SIGTERM",()=>{}); console.log(JSON.stringify({pid:process.pid})); setInterval(()=>{},1000)'], {
    cwd: process.cwd(), signal: controller.signal,
    onEvent: (event) => { pid = event.pid; controller.abort(new Error("test cancellation")); },
  }), /test cancellation/);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("a finished child settles at once, whatever it left holding its pipes", async () => {
  const options = { cwd: process.cwd(), signal: new AbortController().signal };
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  let started = Date.now();
  const [job, ...rest] = (await runProcess("sh", ["-c", "sleep 5 & echo $!; echo done"], options)).stdout.trim().split("\n");
  assert.ok(Date.now() - started < 2000, "did not wait for the background job");
  assert.deepEqual(rest, ["done"]);
  // The job in the child's process group was killed; init reaps it a moment later.
  for (let tick = 0; tick < 100 && !gone(Number(job)); tick++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(gone(Number(job)));

  // A descendant in its own process group cannot be killed that way, and keeps the pipes
  // open. Everything the child wrote before it exited still arrives.
  const events: any[] = [];
  started = Date.now();
  const holder = 'const c = require("child_process").spawn("sleep", ["5"], { detached: true, stdio: "inherit" }); c.unref();';
  const result = await runProcess(process.execPath, ["-e", `${holder} console.log(JSON.stringify({ holder: c.pid })); for (let i = 0; i < 5000; i++) console.log(JSON.stringify({ i, pad: "x".repeat(100) }));`], {
    ...options, onEvent: (event) => events.push(event),
  });
  assert.ok(Date.now() - started < 3000, "did not wait for the pipes to close");
  assert.equal(result.code, 0);
  assert.equal(events.length, 5001);
  assert.equal(events.at(-1).i, 4999);
  process.kill(events[0].holder, "SIGKILL");
});

test("a timeout names what gave up, and a closing session can wait for stopped children to die", async () => {
  await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: process.cwd(), signal: timeoutSignal(50, "Git did not answer"),
  }), /Git did not answer/);

  const controller = new AbortController();
  let pid = 0;
  const stubborn = runProcess(process.execPath, ["-e", 'process.on("SIGTERM",()=>{}); console.log(JSON.stringify({pid:process.pid})); setInterval(()=>{},1000)'], {
    cwd: process.cwd(), signal: controller.signal, onEvent: (event) => { pid = event.pid; },
  }).catch(() => {});
  const other = new AbortController();
  const bystander = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), signal: other.signal }).catch(() => {});
  while (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
  const started = Date.now();
  await stopped();
  assert.ok(Date.now() - started < 500, "children that were not told to stop are not waited for");
  controller.abort(new Error("session closed"));
  await stopped();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the child ignoring SIGTERM was killed before stopped() resolved");
  other.abort();
  await Promise.all([stubborn, bystander]);
});

test("parallel calls share a concurrency limit and cancelled waiters do not take a slot", async () => {
  const semaphore = new Semaphore();
  const alive = new AbortController();
  const cancelled = new AbortController();
  let release: () => void = () => {};
  const first = semaphore.run(1, alive.signal, () => new Promise<void>((resolve) => { release = resolve; }));
  const queued = semaphore.run(1, cancelled.signal, async () => assert.fail("cancelled task ran"));
  cancelled.abort();
  await assert.rejects(queued);
  release(); await first;
  assert.equal(await semaphore.run(1, alive.signal, async () => "slot freed"), "slot freed");
});
