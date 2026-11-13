import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { Jobs, parseJudgment, parseStructured, type Backend, type Item } from "../extensions/workflowz/jobs.ts";
import { Kernel } from "../extensions/workflowz/kernel.ts";
import { budgetIn, keywordsIn, loadNotices, renderNotice } from "../extensions/workflowz/notices.ts";
import { tokenize, transformCell, wrapCell } from "../extensions/workflowz/transform.ts";
import { emptyUsage } from "../extensions/workflows/process.ts";
import { root } from "./helpers.ts";

const usage = (tokens: number) => ({ ...emptyUsage(), totalTokens: tokens, cost: { ...emptyUsage().cost, total: tokens / 1e6 } });
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A backend whose children answer from `answer` after `delay` ms, recording peak concurrency. */
function fake(answer: (task: string) => string = (task) => `answer: ${task}`, delay = 5) {
  const state = { running: 0, peak: 0, tasks: [] as string[], prompts: [] as string[] };
  const backend: Backend = {
    async runAgent(task, signal) {
      state.running++; state.peak = Math.max(state.peak, state.running); state.tasks.push(task.task);
      try {
        await new Promise((resolve, reject) => { const t = setTimeout(resolve, delay); signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true }); });
        const text = answer(task.task);
        return { id: "x", agent: task.agent, provider: "p", model: "m", status: text.startsWith("FAIL") ? "failed" : "done", text, transcript: "/t/events.jsonl", cwd: "/", elapsedMs: delay, usage: usage(100) };
      } finally { state.running--; }
    },
    async complete(_tier, system, prompt) {
      state.prompts.push(`${system}\n---\n${prompt}`);
      await tick(1);
      return { text: answer(prompt), usage: usage(10), provider: "p", model: "m" };
    },
  };
  return { backend, state };
}
async function cell(kernel: Kernel, code: string) {
  const result = await kernel.run(code, { timeoutMs: 5000 });
  if (result.error) throw new Error(result.error);
  return result;
}

test("cells keep top-level declarations, allow redeclaration and return the last expression", async () => {
  const context = vm.createContext({ setTimeout });
  const run = async (code: string) => {
    const t = transformCell(code);
    const value = await new vm.Script(wrapCell(t.body, t.prelude)).runInContext(context);
    return value && typeof value === "object" ? plain(value) : value;
  };
  assert.equal(await run("const q = await Promise.resolve(3); q"), 3);
  assert.equal(await run("const q = 4\nq"), 4);
  assert.deepEqual(await run("let {a, b: [c]} = await {a: 1, b: [2]}, d = `x${a + `${c}`}y`; [a, c, d]"), [1, 2, "x12y"]);
  assert.equal(await run("let z; typeof z"), "undefined");
  assert.equal(await run("function f(x) { return x * q }\nclass K { m() { return f(2) } }\nnew K().m()"), 8);
  assert.equal(await run("f(10) + new K().m()"), 48);
  assert.deepEqual(await run("const fns = [];\nfor (let i = 0; i < 2; i++) {\n  const v = i;\n  fns.push(() => v);\n}\nfns.map(f => f())"), [0, 1]);
  assert.deepEqual(await run("const re = /a\\/b[/]/g, s = 'it\\'s }'; const n = 1 / 2 / 1\n;[re.source, s, n]"), ["a\\/b[/]", "it's }", 0.5]);
  assert.deepEqual(await run("const o = {\n  a: 1,\n  b: [1, 2]\n    .map(x => x)\n}\no.b"), [1, 2]);
  assert.equal(await run("const long = [1,2,3]\n  .filter(Boolean)\n  .length\nlong"), 3);
  assert.equal(await run("async function g() { return 9 }\nawait g()"), 9);
  assert.equal(await run("q // trailing comment"), 4);
  assert.equal(await run("const x = 1 // c\n/* block\n comment */\nx + 1"), 2);
  assert.equal(await run("class L extends K {}\nnew L().m()"), 8);
  assert.equal(await run("if (q > 1) { 'big' } else { 'small' }"), undefined);
  // A closed statement block ends its statement, even before `[` or `(`.
  assert.deepEqual(await run("let e; try { null.x } catch (err) { e = err.name } [e, 1]"), ["TypeError", 1]);
  assert.deepEqual(await run("if (q) { e = 2 } else { e = 3 }\n[e]"), [2]);
  assert.equal(await run("function h() { return 5 } h()"), 5);
  assert.equal(await run("for (const i of [1]) { e = i } e + 1"), 2);
  assert.equal(await run("const arrow = () => {\n  return 6\n}\narrow()"), 6);
  assert.equal(await run("const obj = { k: 1 }\nobj.k"), 1);
  assert.equal(await run("var w = 1; q + w"), 5);
  assert.equal(await run("w + 1"), 2);
});

test("the tokenizer tells regex from division and skips nested templates", () => {
  const values = (code: string) => tokenize(code).tokens.map((t) => `${t.type}:${t.value}`);
  assert.deepEqual(values("a / b / c"), ["name:a", "punct:/", "name:b", "punct:/", "name:c"]);
  assert.deepEqual(values("x = /}/g"), ["name:x", "punct:=", "regex:/}/g"]);
  assert.deepEqual(values("`a${ {b: `}`}.b }c` + 1"), ["template:`a${ {b: `}`}.b }c`", "punct:+", "number:1"]);
});

test("the kernel prints, reports errors with cell frames and survives syntax errors", async () => {
  const kernel = new Kernel(new Jobs(fake().backend, { concurrency: 2, outputBytes: 4000 }));
  const out = await cell(kernel, "print('hi', { a: 1 }); console.log('there'); const x = 2\nx * 21");
  assert.equal(out.output, "hi { a: 1 }\nthere");
  assert.equal(out.value, "42");
  const failed = await kernel.run("await null\nnull.boom", { timeoutMs: 1000 });
  assert.match(failed.error!, /TypeError: .*boom/);
  assert.match(failed.error!, /cell-2\.js:2/);
  const syntax = await kernel.run("const = ;", { timeoutMs: 1000 });
  assert.match(syntax.error!, /SyntaxError/);
  assert.equal((await cell(kernel, "x")).value, "2");
  assert.equal((await cell(kernel, "typeof require + typeof process")).value, "undefinedundefined");
});

test("a cell that outlives its wait keeps running and reports in the next cell", async () => {
  const kernel = new Kernel(new Jobs(fake().backend, { concurrency: 2, outputBytes: 4000 }));
  const slow = await kernel.run("await sleep(60); print('late'); 7", { timeoutMs: 10 });
  assert.equal(slow.detached, "timeout");
  await tick(100);
  const next = await cell(kernel, "1");
  assert.match(next.output, /late/);
  assert.match(next.output, /\[cell 1 finished\] 7/);
  const user = await kernel.run("await sleep(1000)", { timeoutMs: 5000, pending: (() => { let n = 0; return () => n++ > 0; })() });
  assert.equal(user.detached, "user");
});

test("tools.* bridges to Pi tools only while a cell is awaited", async () => {
  const kernel = new Kernel(new Jobs(fake().backend, { concurrency: 1, outputBytes: 4000 }));
  const calls: unknown[] = [];
  const result = await kernel.run("await tools.read({ path: 'a.txt' })", { timeoutMs: 1000, tools: { call: async (name, args) => { calls.push([name, args]); return "file text"; } } });
  assert.equal(result.value, "file text");
  assert.deepEqual(plain(calls), [["read", { path: "a.txt" }]]);
  assert.match((await kernel.run("await tools.read({})", { timeoutMs: 1000 })).error!, /only while an eval cell/);
  assert.match((await kernel.run("await tools.eval({})", { timeoutMs: 1000, tools: { call: async () => "x" } })).error!, /cannot be called/);
});

test("pools run items within the concurrency limit, settle once, and queue results for delivery", async () => {
  const { backend, state } = fake(undefined, 15);
  const jobs = new Jobs(backend, { concurrency: 2, outputBytes: 4000 });
  let ready = 0;
  jobs.onReady = () => { ready++; };
  const kernel = new Kernel(jobs);
  await cell(kernel, "const review = workpool('scout', { name: 'review', context: 'shared' }); await review.push('a', 'b', { task: 'c', label: 'third' }, 'd')");
  assert.deepEqual(jobs.poolStatus("review"), { name: "review", agent: "scout", queued: 2, running: 2, done: 0, failed: 0, cancelled: 0, total: 4, settled: false, closed: false });
  await jobs.until(() => jobs.poolStatus("review").settled, 2000);
  assert.equal(state.peak, 2);
  assert.ok(ready >= 1);
  const batch = jobs.take(100_000);
  assert.deepEqual(batch.items.map((i) => i.id), ["review#1", "review#2", "review#3", "review#4"]);
  assert.match(batch.text, /### review#3 · scout · p\/m · done · \d+s · third\nanswer: c\nTranscript: \/t\/events.jsonl/);
  assert.match(batch.text, /Pool review settled: 4 done, 0 failed/);
  assert.equal(jobs.take(100_000).items.length, 0);
  assert.match((await kernel.run("await review.push('e')", { timeoutMs: 1000 })).error!, /drained; create a new named pool/);
  assert.match((await kernel.run("workpool({ name: 'review' })", { timeoutMs: 1000 })).error!, /taken/);
  assert.equal(jobs.takeUsage()?.totalTokens, 400);
  assert.equal(jobs.takeUsage(), undefined);
});

test("pool.wait and handle.wait consume results so they are not delivered twice", async () => {
  const jobs = new Jobs(fake((t) => t === "bad" ? "FAIL nope" : t.startsWith("json") ? 'Here:\n```json\n{"n": 3}\n```' : `ok ${t}`).backend, { concurrency: 4, outputBytes: 4000 });
  const kernel = new Kernel(jobs);
  const pooled = await cell(kernel, "const p = workpool({ name: 'p' }); await p.push(['x', 'bad']); (await p.wait()).map(r => r.status)");
  assert.equal(pooled.value, "[ 'done', 'failed' ]");
  const handled = await cell(kernel, "const h = agent('json', { schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } }); (await h.wait()).n");
  assert.equal(handled.value, "3");
  const both = await kernel.run("await wait([agent('one'), completion('two', { model: 'smol' })])", { timeoutMs: 1000 });
  assert.equal(both.value, "[ 'ok one', 'ok two' ]");
  const raised = await kernel.run("await wait([agent('bad')], { raiseErrors: false }).then(r => String(r[0]))", { timeoutMs: 1000 });
  assert.match(raised.value!, /failed: FAIL nope/);
  assert.deepEqual(jobs.ready().map((i: Item) => i.id), []);
  // An unwaited handle is delivered.
  await cell(kernel, "agent('later')");
  await jobs.until(() => jobs.ready().length === 1, 1000);
  assert.equal(jobs.ready()[0]!.text, "ok later");
});

test("closing a pool drops queued items and cancels running ones", async () => {
  const jobs = new Jobs(fake(undefined, 200).backend, { concurrency: 1, outputBytes: 4000 });
  const kernel = new Kernel(jobs);
  await cell(kernel, "const c = workpool({ name: 'c' }); await c.push('a', 'b'); await sleep(10); await c.close(); await c.status()");
  await jobs.until(() => jobs.poolStatus("c").running === 0, 1000);
  assert.deepEqual(jobs.poolItems("c").map((i) => i.status), ["cancelled", "cancelled"]);
  assert.equal(jobs.ready().length, 0);
});

test("a hard budget refuses new work once spent; an advisory one only reports", async () => {
  const jobs = new Jobs(fake().backend, { concurrency: 2, outputBytes: 4000 });
  const kernel = new Kernel(jobs);
  jobs.setBudget({ total: 150, hard: true });
  await cell(kernel, "await agent('a').wait()");
  assert.equal((await cell(kernel, "[await budget.total(), await budget.spent(), await budget.remaining()]")).value, "[ 150, 100, 50 ]");
  await cell(kernel, "await agent('b').wait()");
  assert.match((await kernel.run("agent('c')", { timeoutMs: 1000 })).error!, /Hard budget of 150 tokens is spent/);
  jobs.setBudget({ total: 10, hard: false });
  assert.equal((await cell(kernel, "await agent('d').wait()")).value, "answer: d");
});

test("structured answers and judgments are parsed and checked", () => {
  assert.deepEqual(parseStructured('Sure:\n```json\n{"a": [1]}\n```', { type: "object", properties: { a: { type: "array", items: { type: "integer" } } } }), { a: [1] });
  assert.throws(() => parseStructured('{"a": "x"}', { type: "object", properties: { a: { type: "number" } } }), /\$\.a: expected number/);
  assert.throws(() => parseStructured("{}", { type: "object", required: ["k"] }), /\$\.k: missing/);
  const questions = {
    ok: { type: "bool" as const, instructions: "Correct?", criteria: { true: "yes", false: "no" } },
    kind: { type: "choice" as const, instructions: "Kind?", criteria: { bug: "a bug", style: "style" } },
    sev: { type: "score" as const, instructions: "Severity", criteria: ["low", "mid", "high"] },
  };
  const answers = parseJudgment('{"ok": {"probability": 0.8}, "kind": {"choice": "bug", "probabilities": {"bug": 0.7, "style": 0.3}}, "sev": {"score": 2, "confidence": 0.6}}', questions);
  assert.deepEqual(answers, {
    ok: { type: "bool", value: true, probability: 0.8 },
    kind: { type: "choice", choice: "bug", confidence: 0.7, probabilities: { bug: 0.7, style: 0.3 } },
    sev: { type: "score", score: 2, confidence: 0.6 },
  });
  assert.throws(() => parseJudgment('{"ok": {"probability": 2}, "kind": {"choice": "bug"}, "sev": {"score": 1}}', questions), /probability/);
  assert.throws(() => parseJudgment('{"ok": {"probability": 1}, "kind": {"choice": "bug"}, "sev": {"score": 3}}', questions), /level index/);
});

test("judge and judgeBatch run on the smol tier and drain incrementally", async () => {
  const answer = (prompt: string) => prompt.includes('"n": 2') ? "not json" : '{"good": {"probability": 0.9}}';
  const { backend, state } = fake(answer);
  const jobs = new Jobs(backend, { concurrency: 2, outputBytes: 4000 });
  const kernel = new Kernel(jobs);
  await cell(kernel, "const Q = { good: { type: 'bool', instructions: 'Is it good?', criteria: { true: 'good', false: 'bad' } } }");
  assert.equal((await cell(kernel, "(await judge({ n: 1 }, Q)).good.probability")).value, "0.9");
  assert.match(state.prompts[0]!, /typed questions about a JSON state/);
  await assert.rejects(kernel.run("await judge({}, { bad: { type: 'nope', instructions: 'x' } })", { timeoutMs: 1000 }).then((r) => { if (r.error) throw new Error(r.error); }), /choice, bool or score/);
  const out = await cell(kernel, `const b = judgeBatch([{ n: 1 }, { n: 2 }, { n: 3 }], Q, { concurrency: 2, retries: 1, intent: 'Grading' });
const seen = [];
for await (const [k, item] of b.drainIter({ timeout: 2 })) seen.push([k, item.ok]);
[seen.sort(), await b.status(), Object.keys(await b.results()), await b.failed()]`);
  assert.match(out.value!, /\[ 0, true \], \[ 1, false \], \[ 2, true \]/);
  assert.match(out.value!, /judged: 3,\s+ok: 2,\s+failed: 1,\s+done: true/);
  assert.match(out.value!, /'0', '2'/);
  assert.match(out.value!, /key: 1, error: 'Expected a JSON answer'/);
  // Two attempts for the bad state.
  assert.equal(state.prompts.filter((p) => p.includes('"n": 2')).length, 2);
  assert.match(jobs.take(10_000).text, /Judge batch judge-1 \(Grading\) finished: 2\/3 ok/);
});

test("keywords trigger only as standalone words outside code, and budgets parse", () => {
  assert.deepEqual(keywordsIn("workflowz research Rust async runtimes"), ["workflowz"]);
  assert.deepEqual(keywordsIn("Please orchestrate this, then workflowz."), ["workflowz", "orchestrate"]);
  assert.deepEqual(keywordsIn("WORKFLOWZ: audit the auth layer"), ["workflowz"]);
  assert.deepEqual(keywordsIn("see extensions/workflowz/index.ts and `workflowz` and orchestrated"), []);
  assert.deepEqual(keywordsIn("```\nworkflowz\n```"), []);
  assert.deepEqual(budgetIn("workflowz +500k survey"), { total: 500_000, hard: false });
  assert.deepEqual(budgetIn("workflowz +1.5m! survey"), { total: 1_500_000, hard: true });
  assert.equal(budgetIn("a+500k"), undefined);
});

test("notices render without placeholders and describe the tools that are active", async () => {
  const notices = await loadNotices(join(root, "extensions/workflowz/notices"));
  const state = { active: ["read", "subagent", "eval", "wait"], concurrency: 6, subagentConcurrency: 3, maxTasks: 6, budget: { total: 200_000, hard: true } };
  const workflowz = renderNotice(notices.workflowz, state), orchestrate = renderNotice(notices.orchestrate, state);
  assert.doesNotMatch(workflowz + orchestrate, /\{\{/);
  assert.match(workflowz, /At most 6 children run at once/);
  assert.match(workflowz, /hard budget of 200,000 tokens/);
  assert.match(orchestrate, /`subagent` tool: one call with up to 6 tasks/);
  assert.match(renderNotice(notices.orchestrate, { ...state, active: ["read", "rex_agent"] }), /`rex_agent`/);
  assert.match(renderNotice(notices.orchestrate, { ...state, active: ["read"] }), /No subagent tool is active/);
  // The researcher definition exists for the runner.
  assert.match(await readFile(join(root, "agent-definitions/researcher.md"), "utf8"), /primary/);
});

test("review fixes: timeouts keep results, waits hold delivery, reset stops everything", async () => {
  const jobs = new Jobs(fake(undefined, 60).backend, { concurrency: 2, outputBytes: 4000 });
  const kernel = new Kernel(jobs, { syncTimeoutMs: 100 });
  // A timed-out handle wait leaves the result for delivery.
  const timedOut = await kernel.run("const slow = agent('slow'); await slow.wait({ timeout: 0.01 })", { timeoutMs: 1000 });
  assert.match(timedOut.error!, /Timed out waiting for agent-1/);
  await jobs.until(() => jobs.ready().length === 1, 1000);
  assert.equal(jobs.take(10_000).items[0]!.id, "agent-1");
  // While pool.wait() runs, finished items are held back from delivery.
  const waiting = kernel.run("const held = workpool({ name: 'held' }); await held.push('a'); await sleep(0); (await held.wait()).length", { timeoutMs: 2000 });
  await jobs.until(() => jobs.poolItems("held")[0]?.status === "done", 1000);
  assert.equal(jobs.ready().length, 0);
  assert.equal((await waiting).value, "1");
  assert.equal(jobs.ready().length, 0);
  // A synchronous busy loop is stopped.
  assert.match((await kernel.run("while (true) {}", { timeoutMs: 5000 })).error!, /timed out/i);
  // Redeclaring a var without a value keeps it.
  assert.equal((await cell(kernel, "var kept = 1; var kept; kept")).value, "1");
  // Reset: timers stop and the old Jobs refuses new work.
  await cell(kernel, "globalThis.fired = 0; setTimeout(() => { fired = 1 }, 30)");
  jobs.dispose("reset"); kernel.dispose();
  await tick(60);
  assert.equal((await cell(kernel, "fired")).value, "0");
  assert.match((await kernel.run("agent('more')", { timeoutMs: 1000 })).error!, /reset or closed/);
  await assert.rejects(jobs.until(() => false, 1000), /reset/);
});

test("failed completions still count toward the budget", async () => {
  const backend: Backend = {
    runAgent: async () => { throw new Error("unused"); },
    complete: async () => { throw Object.assign(new Error("tiny: length"), { usage: usage(70) }); },
  };
  const jobs = new Jobs(backend, { concurrency: 1, outputBytes: 4000 });
  const kernel = new Kernel(jobs);
  assert.match((await kernel.run("await completion('x').wait()", { timeoutMs: 1000 })).error!, /tiny: length/);
  assert.equal(jobs.spent(), 70);
});
