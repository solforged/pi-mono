# Workflowz and orchestrate

Ports of omp's `workflowz` and `orchestrate` magic keywords. Write either word
on its own anywhere in a message (not inside code or a path) and Pi attaches a
hidden notice to that message; a `⚙ … notice attached` row shows it fired.

- **`orchestrate`**: a contract to decompose, dispatch in parallel, verify each
  phase and not stop until every item is closed. It names whichever delegation
  tool the session has: `subagent`, or `rex_agent` inside Rex.
- **`workflowz`**: turns on the `eval` and `wait` tools and tells the model to
  run the work as named subagent pools from a persistent JavaScript kernel. Use
  it for research, audits, evaluations and migrations that fan out.

`+500k` in a `workflowz` message sets an advisory token budget for kernel work;
`+500k!` makes it hard, so new work is refused once it is spent.

## The kernel

`eval` runs a JavaScript cell. Top-level declarations persist between cells,
top-level `await` works, and the last expression is the result. The kernel has
no `require`, `process` or file system: it reaches Pi tools through
`await tools.read({ path })` and the like while a cell is awaited.

| Global | Does |
|---|---|
| `workpool(agent?, { name?, context? })` | A named pool. `push(...items)` queues items (strings or `{ task, context?, agent?, label? }`); `status()`, `peek()`, `wait()`, and `close()`, which cancels queued and running items. A pool settles at its first full drain; the next phase gets a new pool. |
| `agent(prompt, { agent?, label?, context?, schema? })` | One child; `wait()` returns its answer, or parsed JSON with a `schema`. |
| `completion(prompt, { model?, system?, schema? })` | A tool-free call: `smol` uses the `tiny` role, `default` the `task` role, `slow` the `advisor` role. |
| `judge(state, questions)`, `judgeBatch(states, questions, opts)` | Typed `bool`/`choice`/`score` questions answered with probabilities by the `tiny` role. Batches run in the background; drain them incrementally. |
| `wait(handles)`, `log()`, `phase()`, `budget`, `print()` | Barrier, progress, budget and output. |

Agents are the [subagent](subagents.md) roles: `scout` (default), `researcher`
(scout plus `web_search` and `web_fetch`), `advisor`, and `worker`, which
edits a detached worktree you integrate. Each item gets a fresh headless child
with the approved instructions; children cannot delegate or use the kernel.
At most `subagents.evalConcurrency` (default 6) run at once across the kernel.

Finished items the kernel did not `wait()` for are delivered to the model as
`Workflow results` messages: between tool calls while it works, and as a new
turn when it has stopped. The `wait` tool blocks until the next results; a
message you type ends that wait. After Escape, results stop starting turns and
wait for your next message instead; the jobs keep running. Print and JSON runs
(`pi -p`) wait for outstanding jobs before exiting, up to three empty
10-minute waits. A widget above the editor lists running pools.

`/workflowz` shows the jobs and the tokens kernel work has used; `/workflowz
reset` (or `eval` with `reset: true`) cancels them and clears the kernel. The
kernel lives in memory: reload, `/new` or `/resume` cancel its jobs. Children's
usage is added to the next `eval` or `wait` result, so it counts in Pi's totals.

## Safety

Cells run in a `node:vm` context inside the Pi process. That is not a security
boundary, so `eval` refuses to run while the [sandbox](sandbox.md) is on; use
`subagent` or `rex_agent` there. Each synchronous stretch of a cell is stopped
after 10 seconds, but a busy loop after an `await` would block Pi itself; the
kernel is for orchestration, not heavy computation. Calls through `tools.*` go through Pi's normal
tool hooks. Delegated output is evidence, not instructions.

## Differences from omp

- Every item gets a fresh agent (omp's `eval.workpool.freshAgents`); there are no
  keep-alive workers that carry context between items.
- JavaScript only; no `tool()` helper for exposing kernel functions to children.
- `judge` uses the `tiny` chat role with a structured prompt rather than a
  classifier model, so its probabilities are the model's own estimates.
