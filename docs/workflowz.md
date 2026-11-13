# Workflowz and orchestrate

Ports of omp's `workflowz` and `orchestrate` magic keywords. Write either word
on its own anywhere in a message (not inside code or a path) and Pi attaches a
hidden notice to that message; a `⚙ … notice attached` row shows it fired.
The full notice is sent once: while it is still in the conversation, a later
keyword adds one line that points back to it (`notice still applies`), and it
is sent again after compaction drops it or its text changes.

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
`await tools.read({ path })` and the like while a cell is awaited. The kernel's
own functions (`pool`, `agent`, `log`, `wait`, `tools`, `budget` and the rest)
cannot be redeclared or assigned at the top level: such a cell is refused with
an error naming the variable, since it would break every later cell.

The kernel is its own process (`kernel-child.cjs`, run by Pi's runtime) and
keeps only variables; pools, agents and judges live in Pi. A kernel that stops
responding, such as a busy loop after an `await`, is killed after 15 seconds
and restarts on the next cell with its variables gone, while the jobs keep
running: `pool(name)` and `handle(id)` reattach to them.

| Global | Does |
|---|---|
| `workpool(agent?, { name?, context?, workers?, tools?, watch? })` | A named pool. `push(...items)` queues items (strings or `{ task, context?, agent?, label? }`); `status()`, `peek()`, `wait()`, and `close()`, which cancels queued and running items. A pool settles at its first full drain; the next phase gets a new pool. |
| `agent(prompt, { agent?, label?, context?, schema?, tools? })` | One child; `wait()` returns its answer, or parsed JSON with a `schema`. `send(message)` continues its conversation as a new handle. |
| `tool(name, fn, { description, parameters })` | Exposes a kernel function to the children of pools and agents created with `tools: [name]`. |
| `completion(prompt, { model?, system?, schema? })` | A tool-free call: `smol` uses the `tiny` role, `default` the `task` role, `slow` the `advisor` role. |
| `judge(state, questions)`, `judgeBatch(states, questions, opts)` | Typed `bool`/`choice`/`score` questions answered with probabilities, by the classifier in `subagents.judge` or else the `tiny` role. Batches run in the background; drain them incrementally. |
| `wait(handles)`, `log()`, `phase()`, `budget`, `print()` | Barrier, progress, budget and output. |

Agents are the [subagent](subagents.md) roles: `scout` (default), `researcher`
(scout plus `web_search` and `web_fetch`), `advisor`, and `worker`, which
edits a detached worktree you integrate. Each item gets a fresh headless child
with the approved instructions; children cannot delegate or use the kernel.
At most `subagents.evalConcurrency` (default 6) run at once across the kernel.

- **Long-lived workers.** `workers: n` gives a pool n agents that take its
  items in turn, each continuing its own saved conversation (and, for
  `worker`, one worktree). Agents always keep theirs, so `send()` can follow up.
- **Watched pools.** `watch: true` runs the workers as Rex children in the
  deck, where you can watch, peek or take one over. It needs interactive Pi in
  Rex, defaults to 3 workers, counts against `subagents.rexConcurrency`, and
  closes the children when the pool settles.
- **Kernel tools.** Children given `tools` call the kernel functions over a
  private Unix socket with a per-session token. They fail once the kernel
  restarts; define them again.
- **Classifier judge.** Set `subagents.judge` to `{ "provider", "model" }` of a
  classifier model (see "Use classifier models" in Pi's `docs/models.md`) to
  judge with it; an unavailable one fails rather than falling back.

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

With the [sandbox](sandbox.md) off, the kernel runs on the host with your
permissions, like Bash does. With it on, the kernel runs in the guest under its
Node (`container exec`), so model-written cells reach only what Bash there can;
turning the sandbox on or off restarts the kernel in the other place. Calls
through `tools.*` go through Pi's tool hooks, so they follow the sandbox too.
Delegated output is evidence, not instructions.

## Differences from omp

- Pools start a fresh agent per item unless `workers` is set (omp keeps workers
  by default).
- JavaScript only.
- Without `subagents.judge`, judges use the `tiny` chat role, whose
  probabilities are the model's own estimates.
