import assert from "node:assert/strict";
import test from "node:test";
import { JsonLines, runProcess, Semaphore } from "../extensions/workflows/process.ts";

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
