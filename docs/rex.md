# Rex subagent prototype

`extensions/rex/` runs persistent interactive Pi children in local Rex terminals.
Delegation is asynchronous by default. Each child can accept follow-up tasks,
receive parent messages, and become a human-controlled session. No dependencies
are added; `mise run install` links it with the other extensions.

Each session gets one delegation tool. Inside Rex, the Rex tools replace the
headless `subagent` tool, which stays available as `/subagent`. Outside Rex the
Rex tools are hidden, because children need a Rex pane. This is decided again
at every session start. Only tools the switch itself removed are restored, so
choices made with `--tools`, `/tools` or settings are kept.

## Try it

From this checkout, inside Rex:

```sh
pi -e ./extensions/rex/index.ts
```

Keep your usual provider and tool-routing extensions enabled. Do not add `-e`
if this extension is already installed. Start a fresh Pi session for this
revision; older one-shot prototype children are not adopted. Run `/agents check`,
then ask Pi to use `rex_agent` for a small scout task:

```json
{
  "agent": "scout",
  "name": "auth-scan",
  "title": "Find auth entry points",
  "task": "Find the authentication entry points and report their paths",
  "context": "Inspect the server directory. Do not change files."
}
```

Each child has a short name, unique within the parent session. Pass `name`, or
one is assigned (`birch`, `cedar`, `fern`, …). An optional `title` (2–6 words)
labels the pane, roster and widget; without one, panes show only name and role. Names appear in the Rex pane
label, the child's terminal title and header, the widget, the picker, and tool
results; tools and `/agents` take a name instead of an ID.

Children appear in the [deck and Agents window](#deck-and-agents-window);
`"view": "background"` keeps one detached instead. The tool returns immediately
so the parent can keep working; `"wait": true` blocks instead.

Rex starts terminals with its server's environment, whose PATH is usually the
system default. Children get the parent's PATH so they find the same `fd`, `rg`,
and project tools.

The model has three tools:

- `rex_agent`: start an advisor, scout, or worker and its first task.
- `rex_send`: addressed by `child` name. `followup` starts another task in an
  idle child; `steer` sends a message to an exact active `taskId`; `cancel`
  stops the current task; `close` ends an idle child once all its results have
  been read. Closing keeps results, the session file and any worktree, and is
  refused for children you have taken over, retired children, and children with
  work running. The parent is told never to close panes through the shell.
- `rex_result`: `next: true` returns every unread result, oldest first and up
  to 64 KB, or waits for whichever task finishes next across all children. One
  call collects a whole batch, so the parent spends fewer turns resending its
  context. `taskId` reads a specific result (`wait: true` waits for it). With
  neither, it lists children by name. Cancelling a wait leaves work running.

While the parent waits, its tool row shows who it is waiting on
(`waiting on 3 · alpha 2m10s · …`). Any wait, including `wait: true` on
`rex_agent` or `rex_send`, ends early when you type a message during it:
nothing is cancelled, the parent answers you, then waits again. A follow-up
already queued when the wait began does not end it.

Tool rows render compactly, e.g. `✓ birch scout · succeeded · 18s · 2.5k tok`,
one line per result in a batch; expand a row to read the answer as Markdown
with its file paths. The widget is a single line with the total cost, grouping
names by state with children needing you first:

```text
Rex 9 · $1.62  ! oak needs you   ● birch cedar fern   ✓ elm pine   ✗ ash   ctrl+shift+a
```

Children report their current tool and its main argument, with paths relative
to their directory (`read docs/x.md`, `bash npm test`), and their running cost; settled usage replaces the estimate.
No transcript content is sent.

Background completions that finish together become one status receipt for the
parent's next turn; they never start a model call. Receipts identify sender and
task and are not treated as new human instructions.

In the child terminal, a compact header replaces Pi's banner, a one-line
footer (status, tokens, cost, context and model) replaces Pi's three, and delegated
tasks display as `▸ Task for birch` with selected context quoted and shortened.
This is display-only: the model receives the exact delegated framing. Parent
messages display as `↳ Parent`, and the terminal title follows the current task.

## Deck and Agents window

Children are arranged automatically, designed for up to about 14 at once:

- **Deck:** a column of live slots beside the parent pane, holding the children
  that matter most right now: waiting for you, then running, then unread
  results. Slot count follows the parent's height: 3 at 60+ rows, 2 at 40+, 1
  otherwise; a window narrower than 160 columns gets no deck. The deck starts
  with the parent at 55% of the width; resize it freely afterwards. Rows are
  kept even.
- **Strip:** while any child is outside the deck, a short pane atop the deck
  lists those children, attention-first, one line each (up to five, then a
  count) with activity, running time and cost:

  ```text
  Not in the deck · 8
  ! oak      scout   Waiting for user: Allow bash?            1m02s   $0.21  Check CI config
  ● fern     worker  bash npm test                              48s   $0.40  Fix flaky retry test
  ```
- **Agents window:** a background Rex window (tab) opened when the deck
  overflows. It holds up to 8 more children in an even grid (at most 3×3,
  since smaller cells are no longer readable) with a roster pane listing every
  child in the same format. It never takes focus; switch to it like any Rex tab.
  It closes when it holds no children.
- **Overflow:** beyond that, children stay detached and keep running. They are
  listed in the strip and roster, and the picker reaches them.

A child that starts waiting for you is swapped into the deck at once; others
wait until the deck child they would replace has been there 8 seconds. Swaps
use Rex's native `session.swap_blocks`, so every child keeps running and its
terminal is never recreated. Pinned children stay in the deck. With a full
grid, an overflow child that outranks the weakest grid child (by the same rule)
takes that cell; the displaced child is detached, not stopped.

The layout manager re-reads Rex's view before every step and leaves your
choices alone: a child you float, move to another window, or focus is not moved;
the active window and focus never change. A grid that needs another column is
re-laid out once; otherwise only the affected pane moves. If a mutation fails or
the layout does not settle, automation pauses (with a notice) instead of
retrying; arrange panes as you like, then `/agents layout` resumes it.

## Controls and human takeover

Press `ctrl+shift+a`, or run `/agents`, to open the agent picker:

| Key | Action |
|---|---|
| Enter | Pin to the deck, or unpin (at most one pin per slot) |
| `z` | Zoom the child to fill its window (and switch there) until focus moves |
| `f` / `g` | Focus the child's terminal / switch to the Agents window |
| `p` / `a` | Park (detach, keeps running) / return to automatic placement |
| `m` | Steer the active task, or start a follow-up when idle |
| `r` | Show the latest task result and file paths |
| `t` / `x` / `c` | Take control / cancel the task / close the terminal |

Rows are sorted with children needing you first; `▪` marks a pin. The same
controls are available by name for scripts:

```text
/agents list              List children by name with recent task IDs
/agents check             Check local Rex and configured workflow roles
/agents layout            Resume paused automatic layout
/agents pin NAME          Pin to the deck, or unpin
/agents zoom NAME         Zoom the child to fill its window until focus moves
/agents focus NAME        Focus the child's terminal
/agents park NAME         Detach without stopping; automatic layout leaves it
/agents auto NAME         Return a parked or moved child to automatic layout
/agents peek NAME         Float the child over the parent (a manual placement)
/agents hide NAME         Minimize a floating view without stopping its child
/agents keep NAME         Tile the child beside the parent
/agents send NAME MESSAGE Steer active work, or start a follow-up when idle
/agents result NAME|TASK  Show the latest (or a specific) result and file paths
/agents cancel NAME       Cancel the current task; keep a responsive child reusable
/agents take NAME         Confirm transfer of an idle child to human control
/agents close NAME        Stop and close a parent-owned terminal; retain its files
```

Unambiguous child ID prefixes are also accepted; children from before names
existed show a short ID as their name. `show` is an alias for `peek`. All views
show the actual child terminal, with Pi's normal TUI and OSC 7501 status.
Layout and delegation are separate: moving, minimizing or detaching a child never
cancels its work. Manual commands check the current layout and report, rather
than retry, uncertain mutations.

Managed children permit inspection and approval dialogs, but block direct
prompts, manual shell commands, and session navigation. To type into an idle
child, use `/agents take NAME` in the parent or `/take` in the child. Transfer is
explicit and irreversible for this coordinator: parent dispatch and automatic
cleanup stop. The child retains its role tool allowlist and routing extensions;
human takeover does not turn a scout into a worker. An exclusive durable claim
arbitrates takeover against terminal closure, including lost receipts.

## Policy and lifetime

The existing [workflow roles](roles.md) apply: advisor uses `advisor`; scout and
worker use `task`. A child retains its original model, tools, instructions, and
working directory across tasks. Each task receives fresh turn/time limits and
separate usage accounting. Parent model selection never changes. Missing models,
authentication, Rex identity, or required routing fail without fallback.

When `ask_user_question` is active in the parent, every child also gets it and
loads the [ask extension](ask.md); it is not tool routing for
`subagents.sandbox`. Time a child spends waiting for you, in any dialog, does
not count against its task deadline.

`subagents.rexConcurrency` (default 6, at most 16) limits live managed
children, including idle ones; it is separate from the headless runner's
`subagents.concurrency`. Raise it in `roles.local.json` for larger batches. Each
child runs one task at a time, with at most 64 tasks and 64 steering messages per
task. Follow-ups retain conversation context and the worker's existing worktree.
Workers start from clean HEAD; changes are never committed, integrated, or
removed automatically. See [worker worktrees](subagents.md#worker-worktrees).

Escape cancels a blocking delegation, but background tasks require explicit
cancellation. A responsive cancellation leaves the child available for another
task. If it does not settle within the grace period, the parent closes its owned
terminal. Reload, shutdown, and session replacement cancel active owned work and
retire idle managed children. A dropped connection or expired 15-second lease
aborts unattended work; time the machine spent asleep does not count.
Human-owned children are excluded from parent cleanup. Retired idle children
remain inspectable and can be taken over locally.

There is no reconnect, automatic replay, sibling messaging, remote execution, or
Herdr backend. Rex supplies terminal views and status; this extension supplies
the parent-child registry and structured messages, not a native Rex intercom.
The socket and worktrees are not security boundaries against same-user code.
File-backed tool routing is inherited; arbitrary in-memory overrides cannot be
reproduced.

## Retained state and recovery

Private state lives under:

```text
workflow-state/<profile>/<project>/rex/<child-id>/
```

`run.json` records the child; `session.jsonl` retains its Pi conversation.
`tasks/<task-id>/` holds acceptance, message receipts, coordinator state, and the
full `result.json`. Results are finalized at `agent_settled`, not `agent_end` or
terminal status. Parent responses are bounded by `subagents.outputBytes`.
Instructions, launch manifests, and ownership claims remain for diagnosis and
human-owned reloads. Socket directories are removed when coordination ends;
the launch capability no longer works after its socket closes.

Usage is charged at most once when a terminal result is collected through a
tool, not when a status notification appears. Reading it with `/agents result`
does not charge usage. Interrupted tool delivery can leave parent accounting
incomplete. Valid durable results are reconciled after lost socket receipts;
missing receipts are reported as unknown usage, not a measured zero.

Reload restores this parent's branch references and results without adopting
live workers or replaying unfinished tasks. Forked sessions do not gain control
of the original parent's children. Conversation-tree navigation is blocked while
tasks run. Unknown launch or ownership outcomes require inspection. Completed
terminals and worker directories remain until explicitly removed.

## Checks

`mise run test` covers deck/grid planning and a layout simulator at 14 children, names, `next` ordering, widget/picker formatting, protocol framing, persistent tasks, steering boundaries,
cancellation races, ownership arbitration, durable results, native layout checks,
and cleanup with fake Rex and local sockets. It makes no model calls or live Rex
mutations.

Explicit live checks create and remove their own test terminals:

```sh
node tests/fixtures/rex-smoke.ts
node tests/fixtures/rex-smoke.ts --dispatch
node tests/fixtures/rex-smoke.ts --ask        # --dispatch plus a question answered in the child
node tests/fixtures/rex-deck-smoke.ts 14
node tests/fixtures/rex-deck-smoke.ts 6 --show   # needs Rex.app Remote Control
```

Both check native peek/toggle/keep/park, preserved focus, and takeover. The
second also checks conversation-preserving follow-ups, steering, cancellation,
and immutable results through real Pi, and captures the child's screen to check
its named header and compact task display. They use an isolated fixed-response
provider with `fetch` disabled, never credentials or external model requests.
The deck check arranges placeholder terminals in two background windows and
checks even sizes, the parent's share, the strip, the 3×3 grid cap with
detached overflow, attention promotion, and unchanged focus. `--show` briefly displays the test window in Rex.app, then
switches back: in a displayed window, `session.move_block` splits 50/50 and the
app may reset a split shortly afterwards, so the manager holds the parent's
share with `session.resize_pane` for a few seconds after creating the deck.

Capabilities are checked against the running server's schemas through the
[Rex CLI/server API](https://www.superlogical.com/rex/docs/automate/server-api).
Terminal keystrokes and screen scraping are not the control protocol.
