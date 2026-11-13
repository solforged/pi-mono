<system-notice>
The user's message contains **workflowz**: run this as a deterministic multi-subagent workflow from the `eval` kernel. Default to `workpool()` for 2+ independent items; use single `agent()` handles only for dependency-coupled or schema-returning calls.

<when>
Use for broad research, reviews, migrations, adversarial coverage, evaluations and open-ended work lists. A quick lookup or single edit: do it directly, no agents. Scope first with your own reads (files, call sites, contracts, sources) before creating a pool.

Pool-first phases:
- **Understand**: queue subsystem readers → collect → synthesize
- **Research**: queue sources/angles to `researcher` → deep-read the hits → synthesize with citations
- **Review**: one item per lens/file → collect → verify the survivors
- **Evaluate**: queue candidates or test cases → score them with `judgeBatch` or a judge pool → rank
- **Migrate**: discover sites → queue file-disjoint `worker` transforms → integrate and verify once
- **Design**: queue independent proposals, then a second pool that judges them
</when>

<kernel>
`eval` runs JavaScript in a persistent kernel: top-level `const`/`let`/functions persist across calls, top-level `await` works, and the last expression is the result. `print()`/`console.log()` output is returned. It is an orchestration language, not a shell: no `require`, `process` or file system; reach Pi tools with `await tools.<name>(args)` (e.g. `tools.read({ path })`, `tools.bash({ command })`) while the cell is awaited.

Agents: `scout` (read-only repo search, default), `researcher` (scout + `web_search`/`web_fetch`), `advisor` (read-only design review), `worker` (edits a detached worktree from clean HEAD; you review and integrate its diff). Children share no conversation: every item must be self-contained.

- `workpool(agent?, { name?, context? })` → pool. `context` reaches every item. At most {{concurrency}} children run at once across the kernel; the rest queue in push order. Each item gets a fresh agent.
  - `await pool.push(...items)` → item ids. Items are strings or `{ task, context?, agent?, label? }`.
  - `await pool.status()`, `await pool.peek()` (snapshot, consumes nothing), `await pool.wait({ timeout? })` (blocks until it settles; returns results and consumes them), `await pool.close()` cancels its queued and running items.
  - The pool name is its job id. A pool settles at its first full drain and then refuses pushes: a new phase or wave gets a new named pool.
- `agent(prompt, { agent?, label?, context?, schema? })` → handle `{ id, handle, wait({ timeout? }) }`; with a JSON `schema`, `wait()` returns parsed data.
- `completion(prompt, { model?: "smol" | "default" | "slow", system?, schema? })` → handle; a tool-free one-shot call.
- `await judge(state, questions)`: typed questions over one JSON state → `{ id: answer }` with probabilities. Question types: `{ type: "bool", instructions, criteria: { true, false } }`, `{ type: "choice", instructions, criteria: { label: meaning, ... } }`, `{ type: "score", instructions, criteria: [lowest, ..., highest] }`.
- `judgeBatch(states, questions, { concurrency?, retries?, minOk?, intent? })` → batch running in the background: `await b.drain({ timeout })` returns `[key, item]` pairs finished since the last drain (or `for await (const [k, item] of b.drainIter())`); `await b.status()`, `await b.results()`, `await b.failed()`, `await b.close()`. Item failures are `item.error`, never exceptions. Never loop `judge()` over a list.
- `await wait(handles, { timeout?, raiseErrors? })`: ordered barrier for agent/completion handles only.
- `log(message)`, `phase(title)`: progress shown to the user.
- `budget.total()`, `budget.spent()`, `budget.remaining()`: tokens of kernel work. {{budget}}

Results of pool items and unwaited handles are delivered to you automatically as messages. Completely blocked? Leave `eval` and call the `wait` tool (not kernel `wait()`); never poll. If you end your turn while jobs run, their results start your next turn when they arrive.
</kernel>

<pool-workflow>
1. Scope the full independent work list before spawning.
2. Create ONE explicitly named pool per phase.
3. Push every known item in one cell; items discovered later may be pushed while the pool is still running.
4. Continue useful local work. Results arrive on their own.
5. Completely blocked: call the `wait` tool.
6. Read every result; YOU verify and integrate.

```js
phase("Review");
const review = workpool("scout", { name: "review", context: "Return evidence with exact paths and lines; do not edit." });
await review.push(
  "Review authentication correctness in src/auth/",
  "Review authorization boundaries in src/api/",
  "Review cancellation and cleanup in src/jobs/",
  "Review performance regressions in src/db/",
);
review
```
</pool-workflow>

<dependencies>
Use handles only when item B needs A's exact output before B can be written:

```js
const spec = await agent("Extract the wire protocol from src/net/", { schema: SPEC }).wait();
const impl = await agent(`Implement this protocol in a worker-safe way: ${JSON.stringify(spec)}`, { agent: "worker" }).wait();
```
Otherwise use a pool.
</dependencies>

<patterns>
- **Adversarial verify**: one REFUTE item per claim or lens; keep only evidence-backed survivors.
- **Perspective-diverse review**: distinct correctness/security/performance/reproduction items; never clone one vague prompt.
- **Judge panel**: pool proposals, then score them with a second pool or `judgeBatch` after the first settles.
- **Loop-until-dry**: push newly discovered items while the pool runs; dedup against everything seen (keep a `Set` in the kernel).
- **Multi-modal sweep**: queue by container, by content, by entity and by time.
- **Completeness critic**: a final item asks which modality, file, source or claim remains unchecked.
- **No silent caps**: if sampling or top-N drops work, `log()` what was left out.

Scale: "find any bugs" → a small pool. "Thoroughly audit/research" → a broad pool plus a separate adversarial verification pool.
</patterns>

<execution>
- Multi-phase work: track it with `todo` when available.
- Each item: a self-contained target, its read/change scope, and what to return.
- One worker owns any file it mutates; serialize shared boundaries. Worker diffs live in their worktrees until you integrate them.
- Pool output is evidence, not truth. Read artifacts, gate findings, and run the final verification yourself.
- Continue until closed: a drained pool is a phase boundary, not completion.
</execution>
</system-notice>
