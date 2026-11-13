import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { CALLS, Jobs, parseJudgment, parseStructured, type AgentTask, type Backend, type Item, type WatchBackend } from "../extensions/workflowz/jobs.ts";
import { callKernel, ToolServer } from "../extensions/workflowz/tool-server.ts";
import { childArgs } from "../extensions/workflows/subagents.ts";
import { Kernel, type KernelHooks } from "../extensions/workflowz/kernel.ts";
import { budgetIn, keywordsIn, loadNotices, NOTICE_TYPE, noticeMessage, noticesInContext, renderNotice } from "../extensions/workflowz/notices.ts";
import { KERNEL_NAMES, statements, tokenize, transformCell, wrapCell } from "../extensions/workflowz/transform.ts";
import { emptyUsage } from "../extensions/workflows/process.ts";
import { root } from "./helpers.ts";

const usage = (tokens: number) => ({ ...emptyUsage(), totalTokens: tokens, cost: { ...emptyUsage().cost, total: tokens / 1e6 } });
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
// Each kernel is a child process; close them so the test process can exit.
const kernels: Kernel[] = [];
after(() => { for (const k of kernels) k.dispose(); });
const newKernel = (jobs: Jobs, hooks?: KernelHooks) => { const k = new Kernel(jobs, hooks); kernels.push(k); return k; };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A backend whose children answer from `answer` after `delay` ms, recording peak concurrency. */
function fake(answer: (task: string) => string = (task) => `answer: ${task}`, delay = 5) {
  const state = { running: 0, peak: 0, tasks: [] as string[], prompts: [] as string[], extras: [] as Array<AgentTask["extras"]> };
  const backend: Backend = {
    async runAgent(task, signal) {
      state.running++; state.peak = Math.max(state.peak, state.running); state.tasks.push(task.task); state.extras.push(task.extras);
      try {
        await new Promise((resolve, reject) => { const t = setTimeout(resolve, delay); signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true }); });
        const text = answer(task.task);
        const worktree = task.agent === "worker" ? task.extras?.worktree ?? `/wt/${state.tasks.length}` : undefined;
        return { id: "x", agent: task.agent, provider: "p", model: "m", status: text.startsWith("FAIL") ? "failed" : "done", text, transcript: "/t/events.jsonl", cwd: "/", elapsedMs: delay, usage: usage(100),
          ...(worktree ? { worktree } : {}), ...(task.extras?.session ? { session: { dir: "/s", id: task.extras.session } } : {}) };
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
    if (t.functions) new vm.Script(t.functions).runInContext(context);
    const value = await new vm.Script(wrapCell(t.body)).runInContext(context);
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
  const kernel = newKernel(new Jobs(fake().backend, { concurrency: 2, outputBytes: 4000 }));
  const out = await cell(kernel, "print('hi', { a: 1 }); console.log('there'); const x = 2\nx * 21");
  assert.equal(out.output, "hi { a: 1 }\nthere");
  assert.equal(out.value, "42");
  const failed = await kernel.run("await null\nnull.boom", { timeoutMs: 1000 });
  assert.match(failed.error!, /TypeError: .*boom/);
  assert.match(failed.error!, /cell-2\.js:2/);
  const syntax = await kernel.run("const = ;", { timeoutMs: 1000 });
  assert.match(syntax.error!, /SyntaxError/);
  assert.equal((await cell(kernel, "x")).value, "2");
  // Cells are given no such globals. That is a convention, not isolation: see "Safety" in docs/workflowz.md.
  assert.equal((await cell(kernel, "typeof require + typeof process")).value, "undefinedundefined");
});

test("loop and branch bodies on their own line without braces stay part of their statement", async () => {
  const kernel = newKernel(new Jobs(fake().backend, { concurrency: 1, outputBytes: 4000 }));
  // The body used to be split off and, as the last statement, turned into a return after one pass.
  assert.equal((await cell(kernel, "let n = 0\nfor (const x of [1, 2, 3])\n  n += x")).value, undefined);
  assert.equal((await cell(kernel, "n")).value, "6");
  assert.equal((await cell(kernel, "let i = 0\nwhile (i < 4)\n  i++\ni")).value, "4");
  assert.equal((await cell(kernel, "let which\nif (i > 9)\n  which = 'big'\nelse\n  which = 'small'\nwhich")).value, "small");
  assert.equal((await cell(kernel, "do { i-- } while (i > 1)\ni")).value, "1");
  assert.deepEqual(statements(tokenize("a.for (x)\nb").tokens).length, 2);
});

test("kernel functions cannot be replaced by a cell's own names", async () => {
  const { backend, state } = fake();
  const jobs = new Jobs(backend, { concurrency: 1, outputBytes: 4000 });
  const kernel = newKernel(jobs);
  // Declarations are refused before anything runs, so no half-created pool is left behind.
  for (const code of ["const pool = workpool({ name: 'r' })", "let agent", "var x = 1, log = []", "function wait() {}", "async function tools() {}", "class budget {}"]) {
    const refused = await kernel.run(code, { timeoutMs: 2000 });
    assert.match(refused.error!, /is a kernel function, and declaring it at the top level would replace it/, code);
  }
  assert.equal(jobs.pools.size, 0);
  // Destructuring and bare assignment are refused where they assign.
  assert.match((await kernel.run("const { handle } = { handle: 1 }", { timeoutMs: 2000 })).error!, /"handle" is a kernel function and cannot be assigned/);
  assert.match((await kernel.run("sleep = 5", { timeoutMs: 2000 })).error!, /"sleep" is a kernel function/);
  // Inside functions and blocks the names are ordinary locals, and the API is intact afterwards.
  assert.equal((await cell(kernel, "const count = (() => { const pool = [1, 2]; return pool.length })()\ncount")).value, "2");
  assert.equal((await cell(kernel, "for (const agent of ['a']) { print(agent) }\ntypeof pool + typeof agent + typeof wait")).value, "functionfunctionfunction");
  assert.equal(state.tasks.length, 0);
  // The list the transform checks is the kernel's own.
  const names = JSON.parse((await cell(kernel, "JSON.stringify(Object.keys(globalThis).filter((k) => !['count', 'x'].includes(k)).sort())")).value!);
  assert.deepEqual(names, [...KERNEL_NAMES].sort());
});

test("a redefined function replaces the old one for callers from earlier cells", async () => {
  const kernel = newKernel(new Jobs(fake().backend, { concurrency: 1, outputBytes: 4000 }));
  await cell(kernel, "function helper() { return 'old' }\nfunction caller() { return helper() }\nawait tool('ask', () => helper())");
  // The declaration used to be local to its cell, so caller() and the tool kept the first helper.
  assert.equal((await cell(kernel, "async function helper() { return 'new' }\nawait caller()")).value, "new");
  assert.equal((await kernel.invoke("ask", {})).value, "new");
  assert.equal((await cell(kernel, "helper = () => 'assigned'\ncaller()")).value, "assigned");
  // Declarations are still hoisted, with the brace on its own line too, and errors keep the cell's lines.
  assert.equal((await cell(kernel, "const got = main()\nfunction main()\n{\n  return 'hoisted'\n}\ngot")).value, "hoisted");
  const failed = await kernel.run("const one = 1\nfunction* bad(o = {}) {\n  yield o.x.y\n}\n[...bad()]", { timeoutMs: 1000 });
  assert.match(failed.error!, /TypeError[^\n]*\n\s+at bad \(cell-\d\.js:3:\d+\)\n\s+at cell-\d\.js:5:/);
});

test("line and paragraph separators survive the kernel protocol in both directions", async () => {
  const kernel = newKernel(new Jobs(fake().backend, { concurrency: 1, outputBytes: 4000 }));
  // JSON leaves U+2028 and U+2029 raw; a reader that treats them as newlines drops the message.
  const out = await cell(kernel, "const s = 'a\u2028b\u2029c'; print(s)\ns.length");
  assert.equal(out.output, "a\u2028b\u2029c");
  assert.equal(out.value, "5");
});

test("a cell that outlives its wait keeps running and reports in the next cell", async () => {
  const kernel = newKernel(new Jobs(fake().backend, { concurrency: 2, outputBytes: 4000 }));
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
  const kernel = newKernel(new Jobs(fake().backend, { concurrency: 1, outputBytes: 4000 }));
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
  const kernel = newKernel(jobs);
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
  const kernel = newKernel(jobs);
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
  const kernel = newKernel(jobs);
  await cell(kernel, "const c = workpool({ name: 'c' }); await c.push('a', 'b'); await sleep(10); await c.close(); await c.status()");
  await jobs.until(() => jobs.poolStatus("c").running === 0, 1000);
  assert.deepEqual(jobs.poolItems("c").map((i) => i.status), ["cancelled", "cancelled"]);
  assert.equal(jobs.ready().length, 0);
});

test("a hard budget refuses new work once spent; an advisory one only reports", async () => {
  const jobs = new Jobs(fake().backend, { concurrency: 2, outputBytes: 4000 });
  const kernel = newKernel(jobs);
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
  const kernel = newKernel(jobs);
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
  // A notice already in context is pointed at, with only the budget restated; a changed one is sent again.
  const first = noticeMessage(["workflowz", "orchestrate"], notices, state);
  assert.equal(first.content, `${workflowz}\n\n${orchestrate}`);
  const entry = (details: object) => ({ type: "custom_message", customType: NOTICE_TYPE, details });
  const seen = noticesInContext([{ type: "message" }, entry(first.details)]);
  const again = noticeMessage(["workflowz"], notices, { ...state, budget: undefined }, seen);
  assert.equal(again.content, "The `workflowz` notice earlier in this conversation still applies. No budget was set (the user can add `+500k`, or `+500k!` for a hard limit).");
  assert.deepEqual(again.details.sent, {});
  assert.equal(noticeMessage(["orchestrate"], notices, state, seen).content, "The `orchestrate` notice earlier in this conversation still applies.");
  assert.equal(noticeMessage(["orchestrate"], notices, { ...state, active: ["read", "rex_agent"] }, seen).content, renderNotice(notices.orchestrate, { ...state, active: ["read", "rex_agent"] }));
  // Compaction drops the notice from context, and notices from before this record count as unseen.
  assert.equal(noticeMessage(["workflowz"], notices, state, noticesInContext([entry({ keywords: ["workflowz"] })])).content, workflowz);
  // The researcher definition exists for the runner.
  assert.match(await readFile(join(root, "agent-definitions/researcher.md"), "utf8"), /primary/);
});

test("review fixes: timeouts keep results, waits hold delivery, reset stops everything", async () => {
  const jobs = new Jobs(fake(undefined, 60).backend, { concurrency: 2, outputBytes: 4000 });
  const kernel = newKernel(jobs, { syncTimeoutMs: 100 });
  // A timed-out handle wait leaves the result for delivery.
  const timedOut = await kernel.run("const slow = agent('slow'); await slow.wait({ timeout: 0.01 })", { timeoutMs: 1000 });
  assert.match(timedOut.error!, /Timed out waiting for agent-1/);
  await jobs.until(() => jobs.ready().length === 1, 1000);
  assert.equal(jobs.take(10_000).items[0]!.id, "agent-1");
  // While pool.wait() runs, finished items are held back from delivery.
  const waiting = kernel.run("const held = workpool({ name: 'held' }); await held.push('a'); await sleep(0); (await held.wait()).length", { timeoutMs: 2000 });
  await jobs.until(() => jobs.pools.get("held")?.items[0]?.status === "done", 1000);
  assert.equal(jobs.ready().length, 0);
  assert.equal((await waiting).value, "1");
  assert.equal(jobs.ready().length, 0);
  // A synchronous busy loop is stopped.
  assert.match((await kernel.run("while (true) {}", { timeoutMs: 5000 })).error!, /timed out/i);
  // Redeclaring a var without a value keeps it.
  assert.equal((await cell(kernel, "var kept = 1; var kept; kept")).value, "1");
  // Reset: the kernel process and its timers are gone, and the old Jobs refuses new work.
  await cell(kernel, "globalThis.fired = 0; setTimeout(() => { fired = 1 }, 30)");
  jobs.dispose("reset"); kernel.reset();
  await tick(60);
  assert.match((await kernel.run("fired", { timeoutMs: 1000 })).error!, /fired is not defined/);
  assert.match((await kernel.run("agent('more')", { timeoutMs: 1000 })).error!, /reset or closed/);
  await assert.rejects(jobs.until(() => false, 1000), /reset/);
});

test("a kernel stuck after an await is restarted while its jobs keep running", async () => {
  const jobs = new Jobs(fake(undefined, 300).backend, { concurrency: 2, outputBytes: 4000 });
  const kernel = newKernel(jobs, { syncTimeoutMs: 200, hangMs: 1000 });
  await cell(kernel, "const p = workpool({ name: 'survives' }); await p.push('a'); const kept = 1");
  const stuck = await kernel.run("await sleep(5); for (;;) {}", { timeoutMs: 10_000 });
  assert.match(stuck.error!, /stopped responding/);
  assert.match(stuck.note!, /^Variables from earlier cells are gone; jobs keep running/);
  assert.match((await kernel.run("kept", { timeoutMs: 1000 })).error!, /kept is not defined/);
  // Ids continue after the restart, and pool() reattaches.
  assert.equal((await cell(kernel, "agent('x').id")).value, "agent-1");
  assert.deepEqual(JSON.parse((await cell(kernel, "JSON.stringify((await pool('survives').wait()).map(r => r.text))")).value!), ["answer: a"]);
  assert.equal((await cell(kernel, "workpool().name")).value, "pool-1");
  assert.match((await kernel.run("workpool({ name: 'survives' })", { timeoutMs: 1000 })).error!, /taken/);
});

test("a wait whose kernel stops consumes nothing, so the results are delivered instead", async () => {
  let where = "host", readied = 0;
  const jobs = new Jobs(fake(undefined, 150).backend, { concurrency: 2, outputBytes: 4000 });
  jobs.onReady = () => { readied++; };
  const { localLaunch } = await import("../extensions/workflowz/kernel.ts");
  const kernel = newKernel(jobs, { placement: () => where, launch: (source) => ({ ...localLaunch(source), where }) });
  const waiting = await kernel.run("const p = workpool({ name: 'held' }); await p.push('a', 'b'); const h = agent('single'); await Promise.all([p.wait(), h.wait()])", { timeoutMs: 40 });
  assert.equal(waiting.detached, "timeout");
  assert.equal(jobs.pools.get("held")!.holds, 1);
  // The sandbox is toggled: the kernel holding those waits is stopped.
  where = "sandbox";
  assert.equal(kernel.relocate("the sandbox was turned on or off"), true);
  await tick(5);
  assert.equal(jobs.pools.get("held")!.holds, 0);
  assert.equal(jobs.items.get("agent-1")!.holds, 0);
  assert.ok(readied > 0, "delivery is rescheduled when the holds drop");
  await jobs.until(() => !jobs.busy(), 3000);
  assert.deepEqual(jobs.ready().map((i) => i.id).sort(), ["agent-1", "held#1", "held#2"]);
  assert.ok([...jobs.items.values()].every((i) => !i.consumed));
});

test("a reset keeps the budget spent and the usage not yet reported", async () => {
  const { backend } = fake(undefined, 30);
  const first = new Jobs(backend, { concurrency: 2, outputBytes: 4000 });
  first.setBudget({ total: 150, hard: true });
  first.agent("a"); first.agent("b");
  await first.until(() => !first.busy(), 2000);
  assert.equal(first.spent(), 200);
  // eval({ reset: true }): the old jobs are cancelled and a new Jobs takes over.
  first.dispose("Kernel reset");
  const next = new Jobs(backend, { concurrency: 2, outputBytes: 4000 });
  next.setBudget({ total: 150, hard: true });
  next.inherit(first);
  assert.equal(next.spent(), 200);
  assert.throws(() => next.agent("c"), /Hard budget of 150 tokens is spent/);
  assert.equal(next.takeUsage()?.totalTokens, 200, "unreported usage moves to the new Jobs");
  assert.equal(first.takeUsage(), undefined);
  // A cancelled child of the old Jobs that reports usage afterwards is still counted.
  (first as any).record(usage(7));
  assert.equal(next.takeUsage()?.totalTokens, 7);
  assert.equal(next.usage.totalTokens, 207);
});

test("completions and judgments share a cap on model calls in flight", async () => {
  let running = 0, peak = 0;
  const backend: Backend = { ...fake().backend, async complete() { running++; peak = Math.max(peak, running); await tick(15); running--; return { text: '{"ok":{"value":true,"probability":1}}', usage: usage(1), provider: "p", model: "m" }; } };
  const jobs = new Jobs(backend, { concurrency: 2, outputBytes: 4000 });
  const items = Array.from({ length: CALLS + 20 }, (_, i) => jobs.completion(`q${i}`));
  const question = { ok: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } };
  const batches = [jobs.judgeBatch(Array.from({ length: 40 }, (_, i) => ({ i })), question, { concurrency: 32 }), jobs.judgeBatch(Array.from({ length: 40 }, (_, i) => ({ i })), question, { concurrency: 32 })];
  await tick(5);
  assert.equal(items.filter((i) => i.status === "running").length, CALLS, "the rest queue");
  await jobs.until(() => !jobs.busy(), 10_000);
  assert.equal(peak, CALLS);
  assert.ok(items.every((i) => i.status === "done"));
  assert.ok(batches.every((b) => b.items.length === 40 && b.items.every((i) => i.ok)));
  // Queued completions are cancelled with the kernel rather than left waiting.
  const more = Array.from({ length: CALLS + 5 }, (_, i) => jobs.completion(`r${i}`));
  jobs.dispose();
  await tick(30);
  assert.ok(more.slice(CALLS).every((i) => i.status === "cancelled"));
});

test("a named wait is scoped to that work, and unknown names are told apart from finished ones", () => {
  const jobs = new Jobs(fake(undefined, 200).backend, { concurrency: 4, outputBytes: 4000 });
  jobs.createPool("scout", { name: "slow" }); jobs.push("slow", ["a"]);
  const named = (names: string[]) => (i: { job: string; id: string }) => names.some((n) => i.job === n || i.id === n);
  assert.equal(jobs.busy(), true);
  assert.equal(jobs.busy(named(["slow"])), true);
  assert.equal(jobs.busy(named(["slow#1"])), true);
  jobs.createPool("scout", { name: "idle" });
  assert.equal(jobs.busy(named(["idle"])), false, "another pool's work does not keep a named wait going");
  assert.deepEqual(["slow", "slow#1", "idle", "typo"].map((n) => jobs.known(n)), [true, true, true, false]);
  jobs.dispose();
});

test("kernel functions registered with tool() can be invoked from outside", async () => {
  const kernel = newKernel(new Jobs(fake().backend, { concurrency: 1, outputBytes: 4000 }));
  await cell(kernel, "const seen = []; await tool('record', (args) => { seen.push(args.finding); return `noted ${seen.length}`; }, { description: 'Record a finding', parameters: { type: 'object', properties: { finding: { type: 'string' } }, required: ['finding'] } })");
  assert.equal(kernel.tools.get("record")?.description, "Record a finding");
  assert.deepEqual(await kernel.invoke("record", { finding: "a" }), { t: "invoked", id: 1, ok: true, value: "noted 1" });
  assert.equal((await kernel.invoke("missing", {})).ok, false);
  assert.equal((await cell(kernel, "seen")).value, "[ 'a' ]");
});

test("failed completions still count toward the budget", async () => {
  const backend: Backend = {
    runAgent: async () => { throw new Error("unused"); },
    complete: async () => { throw Object.assign(new Error("tiny: length"), { usage: usage(70) }); },
  };
  const jobs = new Jobs(backend, { concurrency: 1, outputBytes: 4000 });
  const kernel = newKernel(jobs);
  assert.match((await kernel.run("await completion('x').wait()", { timeoutMs: 1000 })).error!, /tiny: length/);
  assert.equal(jobs.spent(), 70);
});

test("pools with workers keep one conversation per worker; agents continue with send()", async () => {
  const { backend, state } = fake(undefined, 20);
  const jobs = new Jobs(backend, { concurrency: 6, outputBytes: 4000 });
  const kernel = newKernel(jobs);
  await cell(kernel, "const team = workpool('worker', { name: 'team', workers: 2 }); await team.push('a', 'b', 'c', 'd'); await team.wait()");
  assert.equal(state.peak, 2);
  const sessions = state.extras.map((e) => e!.session!);
  assert.equal(new Set(sessions).size, 2);
  // Each worker's later items continue its conversation and its worktree.
  for (const session of new Set(sessions)) {
    const mine = state.extras.filter((e) => e!.session === session);
    assert.deepEqual(mine.map((e) => !!e!.followUp), [false, ...mine.slice(1).map(() => true)]);
    assert.equal(new Set(mine.slice(1).map((e) => e!.worktree)).size, 1);
  }
  assert.match((await kernel.run("workpool({ workers: 0 })", { timeoutMs: 1000 })).error!, /whole number/);
  // send() continues a finished agent's conversation as a new item.
  state.extras.length = 0;
  const first = await cell(kernel, "const a = agent('first'); await a.wait(); const b = await a.send('second'); [b.id, await b.wait()]");
  assert.equal(first.value, "[ 'agent-2', 'answer: second' ]");
  const [opening, followUp] = state.extras;
  assert.ok(opening!.session && !opening!.followUp);
  assert.equal(followUp!.session, opening!.session);
  assert.equal(followUp!.followUp, true);
  assert.match((await kernel.run("const busy = agent('slow'); await busy.send('too soon')", { timeoutMs: 1000 })).error!, /still running/);
});

test("watched pools run items on a few Rex children and close them when the pool settles", async () => {
  const events: string[] = [];
  const watch: WatchBackend = {
    limit: 2,
    open: async (agent, title) => { events.push(`open ${agent} ${title}`); return `child-${events.filter((e) => e.startsWith("open")).length}`; },
    run: async (child, task) => { events.push(`run ${child} ${task.task}`); await tick(10); return { id: child, agent: task.agent, provider: "p", model: "m", status: "done", text: `${child}: ${task.task}`, transcript: "/s.jsonl", cwd: "/", elapsedMs: 10, usage: usage(5) }; },
    close: async (child) => { events.push(`close ${child}`); },
  };
  const { backend } = fake();
  const jobs = new Jobs({ ...backend, watch: () => watch }, { concurrency: 6, outputBytes: 4000 });
  const kernel = newKernel(jobs);
  const texts = await cell(kernel, "const w = workpool('scout', { name: 'w', watch: true, workers: 5 }); await w.push('a', 'b', 'c'); (await w.wait()).map((r) => r.text)");
  assert.match(texts.value!, /child-1: a/);
  await tick(20);
  assert.equal(events.filter((e) => e.startsWith("open")).length, 2);
  assert.equal(events.filter((e) => e.startsWith("run")).length, 3);
  assert.deepEqual(events.filter((e) => e.startsWith("close")).sort(), ["close child-1", "close child-2"]);
  const headless = new Jobs(fake().backend, { concurrency: 1, outputBytes: 4000 });
  assert.throws(() => headless.createPool("scout", { watch: true }), /needs interactive Pi running in Rex/);
});

test("a watched worker whose Rex child became unusable gets a new one for the next item", async () => {
  const events: string[] = [];
  let opened = 0;
  const watch: WatchBackend = {
    limit: 1,
    open: async () => `child-${++opened}`,
    // The user took the first pane over: every task sent to it is refused at once.
    run: async (child, task) => {
      events.push(`run ${child} ${task.task}`);
      if (child === "child-1" && task.task !== "a") throw new Error("Child is not available for parent-directed work");
      await tick(5);
      return { id: child, agent: task.agent, provider: "p", model: "m", status: "done", text: `${child}: ${task.task}`, transcript: "/s.jsonl", cwd: "/", elapsedMs: 5, usage: usage(5) };
    },
    close: async (child) => { events.push(`close ${child}`); },
  };
  const jobs = new Jobs({ ...fake().backend, watch: () => watch }, { concurrency: 6, outputBytes: 4000 });
  jobs.createPool("scout", { name: "w", watch: true, workers: 1 });
  jobs.push("w", ["a", "b", "c", "d"]);
  await jobs.until(() => !jobs.busy(), 3000);
  const status = jobs.poolItems("w").map((i) => `${i.label} ${i.status}`);
  assert.deepEqual(status, ["a done", "b failed", "c done", "d done"], "one item is lost to the dead child, not the rest of the queue");
  assert.deepEqual(events.filter((e) => e.startsWith("run")), ["run child-1 a", "run child-1 b", "run child-2 c", "run child-2 d"]);
  assert.ok(events.includes("close child-1"));
});

test("a configured classifier judges instead of the smol tier", async () => {
  const { backend, state } = fake();
  const seen: unknown[] = [];
  const jobs = new Jobs({ ...backend, classify: (s, _q) => { seen.push(s); return Promise.resolve({ answers: { ok: { type: "bool", probability: 0.8 } }, usage: usage(3) }); } }, { concurrency: 1, outputBytes: 4000 });
  const answers = await jobs.judge("plain text", { ok: { type: "bool", instructions: "ok?", criteria: { true: "yes", false: "no" } } });
  assert.deepEqual(answers, { ok: { type: "bool", value: true, probability: 0.8 } });
  assert.deepEqual(seen, [{ value: "plain text" }]);
  assert.equal(state.prompts.length, 0);
  assert.equal(jobs.spent(), 3);
});

test("kernel tools reach the kernel through a private socket, and children get their schemas", async () => {
  const kernel = newKernel(new Jobs(fake().backend, { concurrency: 1, outputBytes: 4000 }));
  await cell(kernel, "const notes = []; await tool('note', ({ text }) => { notes.push(text); return notes.length; }, { description: 'Keep a note' })");
  const server = new ToolServer((name, args, signal) => kernel.invoke(name, args, signal));
  try {
    assert.deepEqual(await callKernel(server, "note", { text: "hi" }), { t: "invoked", id: 1, ok: true, value: "1" });
    assert.match((await callKernel({ socket: server.socket, token: "nope" }, "note", {})).error!, /token/);
    assert.equal((await cell(kernel, "notes")).value, "[ 'hi' ]");
  } finally { server.close(); }
  // Pools and agents pass only tools defined with tool().
  const jobs = new Jobs(fake().backend, { concurrency: 1, outputBytes: 4000 });
  jobs.kernelTools = { has: (n) => n === "note", extras: (names) => ({ tools: names, extensions: ["/x/child-tools.ts"], env: { PI_WORKFLOWZ_TOOLS: "{}" } }) };
  assert.throws(() => jobs.createPool("scout", { tools: ["other"] }), /Define these with tool\(\) first: other/);
  jobs.createPool("scout", { name: "p", tools: ["note"] });
  assert.deepEqual(childArgs("p", "m", "low", ["read"], [], "g.ts", "i.md", { dir: "/s", id: "wfz-12345678" }).slice(3, 8), ["-p", "--session-dir", "/s", "--session-id", "wfz-12345678"]);
});

test("second review: startup, placement, cell attribution and option checks", async () => {
  // A child that never says ready is stopped by the startup limit rather than leaked,
  // and not by the hang monitor, which would call a slow start a busy loop.
  const silent = newKernel(new Jobs(fake().backend, { concurrency: 1, outputBytes: 4000 }),
    { hangMs: 100, startupMs: 1500, launch: () => ({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], where: "host" }) });
  assert.match((await silent.run("1", { timeoutMs: 10_000 })).error!, /did not start within 1\.5s/);
  // A kernel running where it no longer may restarts before the next cell.
  let where = "host";
  const jobs = new Jobs(fake(undefined, 20).backend, { concurrency: 4, outputBytes: 4000 });
  const kernel = newKernel(jobs, { placement: () => where, launch: async (source) => ({ ...(await import("../extensions/workflowz/kernel.ts")).localLaunch(source), where }) });
  await cell(kernel, "const before = 1");
  where = "sandbox";
  const moved = await kernel.run("typeof before", { timeoutMs: 5000 });
  assert.equal(moved.value, "undefined");
  assert.match(moved.note!, /sandbox was turned on or off/);
  assert.equal(kernel.where, "sandbox");
  // Output and failures of a detached cell stay labelled with that cell.
  assert.equal((await kernel.run("await sleep(80); print('from one')", { timeoutMs: 10 })).detached, "timeout");
  assert.match((await cell(kernel, "await sleep(200); 'two'")).output, /\[cell 3\] from one/);
  // Bad options never leave an item behind.
  const count = jobs.items.size;
  assert.match((await kernel.run("agent('x', { tools: ['nope'] })", { timeoutMs: 2000 })).error!, /Define these with tool\(\) first/);
  assert.equal(jobs.items.size, count);
  // Worker pools keep one agent kind, and their items take follow-ups only once settled.
  assert.match((await kernel.run("const wp = workpool('scout', { name: 'wp', workers: 1 }); await wp.push({ task: 'a', agent: 'worker' })", { timeoutMs: 2000 })).error!, /cannot pick another agent/);
  assert.match((await kernel.run("const busy = workpool('scout', { name: 'busy', workers: 1 }); await busy.push('a', 'b'); await sleep(30); await handle('busy#1').send('more')", { timeoutMs: 2000 })).error!, /send\(\) once the pool has settled/);
  assert.equal((await cell(kernel, "await busy.wait(); await (await handle('busy#1').send('more')).wait()")).value, "answer: more");
});
