# Rex subagent prototype

`extensions/rex/` runs persistent interactive Pi children in local Rex terminals.
Delegation is asynchronous by default. Each child can accept follow-up tasks,
receive parent messages, and become a human-controlled session. No dependencies
are added; `pm-install` links it with the other extensions.

Each session gets one delegation tool. Inside Rex, the Rex tools replace the
headless `subagent` tool, which stays available as `/subagent`. Outside Rex,
and in print, JSON or RPC runs started from a Rex pane, the Rex tools are
hidden, because children need a pane and an interactive parent. This is decided again
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
labels the pane and widget; without one, panes show only name and role. Names
appear in the Rex pane label, the child's terminal title and header, the
widget, and tool results; tools and `/agents` take a name instead of an ID.

Children appear in the [Agents tab](#agents-tab);
`"view": "background"` keeps one detached instead. The tool returns immediately
so the parent can keep working; `"wait": true` blocks instead.

Rex starts terminals with its server's environment, whose PATH is usually the
system default. Children get the parent's PATH so they find the same `fd`, `rg`,
and project tools.

The model has three tools. `rex_send` and `rex_result` are declared from the
session's first child on, so a session that never delegates does not carry
them in every request:

- `rex_agent`: start an advisor, scout, researcher, or worker and its first task.
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

Task IDs are shown as their first eight characters, and the tools accept any
unambiguous prefix. A result names its files only when they are the way
forward: `result.json` and the session file when the text was cut or the task
did not succeed, and a worker's worktree always. A launch that fails before
its pane exists (a worker on a dirty repository, say) leaves no child behind.
Tasks that a workflowz pool runs on Rex children are read by the pool and are
never offered through `rex_result`.

While the parent waits, its tool row shows who it is waiting on and how far
along they are (`waiting on 3 · alpha 3/5 2m10s · …`). Any wait, including `wait: true` on
`rex_agent` or `rex_send`, ends early when you type a message during it:
nothing is cancelled, the parent answers you, then waits again. A follow-up
already queued when the wait began does not end it.

Tool rows render compactly, e.g. `✓ birch scout · succeeded · 18s · 2.5k tok`,
one line per result in a batch; expand a row to read the answer as Markdown
with its file paths. The widget is a single heading rule in the editor's style,
grouping names by state with children needing you first and each working
child's progress, and the total cost and `←` key at the right; a tight width
drops those first:

```text
─ Agents  ! oak needs you  ● birch 3/5 cedar fern 1/4  ✓ elm pine  ✗ ash ──── $1.62 · ← open ─
```

Children report their current tool and its main argument, with paths relative
to their directory (`read docs/x.md`, `bash npm test`), their running cost
(settled usage replaces the estimate) and their [progress](#progress). No
transcript content is sent. Glyphs and number formats come from
`extensions/shared/status.ts`, which workflowz pools use too.

Background completions that finish together become one status receipt for the
parent's next turn; they never start a model call. Receipts identify sender and
task and are not treated as new human instructions.

In the child terminal, a compact header replaces Pi's banner, a one-line
footer (status, tokens, cost, context and model) replaces Pi's three, and delegated
tasks display as `▸ Task for birch` with selected context quoted and shortened
(`▸ Task from you` for [one you typed](#typing-into-a-child)).
This is display-only: the model receives the exact delegated framing. Parent
messages display as `↳ Parent`, and the terminal title follows the current task.
Inside Rex, Pi's terminal title is just the session name (or the directory
when unnamed), since the tab already shows a Pi icon. Pi's own title writes are
rewritten on their way to the terminal, so the change can't lose a race with Pi.

## Agents tab

Each parent puts its children in one Rex tab of their own, beside the parent's
tab, as an even grid: one child fills it, then columns are added while it is a
single row, up to 3×3, since smaller cells are no longer readable TUIs. The
parent's own window is never split, so whatever else it holds (a
[diff](diff.md), a shell) keeps its space. The tab opens in the background and
never takes focus; it closes when its last child does, and opens again with
the next.

Beyond nine, children stay detached and keep running. A cell frees when a
child closes, and the most important detached child takes it: one that needs
you, then one that is working. A detached child that needs you or is working
also takes the cell of an idle one, which is detached in turn, not stopped.
`"view": "background"` keeps a child out of the tab entirely.

Rex has no tab groups, so the tab sits right after the parent's with a compact
label: `Agents · 4`, or `Agents · 4 · !1` when one needs you. It follows the
parent's tab when that moves; once you drag the Agents tab elsewhere or rename
it, it is left as you set it. At its first child a parent picks a coloured
square (🟦🟩🟧…), preferring one no other parent in the Rex session uses, and
keeps it with the session. It leads the parent's title while it has children,
and each child's pane label, title and header, so panes match their parent
wherever you drag them. Tab bars take no colours from programs; emoji are the
one colour they draw.

The layout manager re-reads Rex's view before every step and leaves your
choices alone: a child you float, or move beside the parent or into another
tab, is not moved; the active window and focus never change. A grid that needs
another column is re-laid out once; otherwise only the affected pane moves. If
a mutation fails or the layout does not settle, automation pauses (with a
notice) instead of retrying; arrange panes as you like, then `/agents layout`
resumes it. `/new`, `/resume` and `/fork` leave the children's panes where
they are, as retired children; resuming the session finds its tab again.

## Seeing and reaching children

Rex shows every child natively. Pi reports its state to the terminal with the
[Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status)
(working, needs you, done, failed), and each child's report carries its name,
task and progress. Rex's **Activity** sidebar (`cmd+.`, or the eye button)
lists every child and every other Pi session by priority or by session; the
tab bar shows a spinner or progress pie for unfocused tabs. The parent adds
only the one-line widget above.

`←` on the parent's empty prompt (or `ctrl+shift+a`, or `/agents open`) jumps
to the child that most needs a look: one waiting for you, then one with a
result the parent has not read, then one at work. It focuses the child's pane,
which switches to the Agents tab; a detached child is floated over the parent
first. In the child, `←` on an empty prompt focuses the parent again and puts a
float the parent made back where it was; a float you made yourself is left
alone. So `←` `←` is a round trip. `/agents open NAME` opens a particular
child.

`←` on a prompt you just emptied (by deleting text or leaving history) needs a
second press, so a held backspace cannot jump away. Its hint appears briefly
in the editor border, not in the transcript. The key is a feature of the
[shared editor](statusline.md#editor-border), which adds nothing else to Pi's;
if another extension has replaced the editor, `←` is left alone and
`ctrl+shift+a` still works.

Clicking an Activity row selects the child's tab but, in a tab with several
panes, Rex currently restores the tab's last focused pane rather than the one
you clicked (a known Rex issue); `←` focuses the exact pane.

## Progress

When the parent has the [todo](todo.md) tool, children get it too, and their
instructions ask them to list the steps of any task with more than one and
mark each done. Each task starts with an empty list, and its progress is the
items done out of all of them: `3/5` in the widget, the wait row and `rex_result`
listings, a todo widget in the child's own pane, and `progress=60` in the
child's program status, which Rex draws as a progress pie. Without a list,
progress is indeterminate, never estimated from turns or time. The child adds
the value to Pi's own status reports as they are written to the terminal, and
writes the last report again when the value changes.

## Typing into a child

Type into a managed child's pane as you would into any Pi:

- **While it works**, your message steers the running task, as in any Pi run.
  The task, its budget and its result stay the parent's.
- **When it is idle**, your message becomes a follow-up task. The child asks
  the parent to start it, so it runs like any other task: it gets a task ID,
  limits and accounting, displays as `▸ Task from you`, and its result reaches
  the parent as a status receipt marked as typed by you. If the parent has
  just started a task of its own there, yours is declined with a notice and
  you can type it again. Images cannot travel through the parent; describe
  them, or take the child over.

Approvals and questions are answered in the child's pane as usual. Manual
shell commands and session navigation stay blocked while the parent manages
the child.

## Controls and human takeover

```text
/agents                   List children by name with recent task IDs (also /agents list)
/agents check             Check local Rex and configured workflow roles
/agents layout            Resume paused automatic layout
/agents open [NAME]       Open the child that most needs a look, or NAME (as ← does)
/agents send NAME MESSAGE Steer active work, or start a follow-up when idle
/agents result NAME|TASK  Show the latest (or a specific) result and file paths
/agents cancel NAME       Cancel the current task; keep a responsive child reusable
/agents take NAME         Confirm transfer of an idle child to human control
/agents close NAME        Stop and close a parent-owned terminal; retain its files
```

Unambiguous child ID prefixes are also accepted; children from before names
existed show a short ID as their name. All views show the actual child
terminal, with Pi's normal TUI and program status. Layout and delegation are
separate: moving or detaching a child never cancels its work. Manual commands
check the current layout and report, rather than retry, uncertain mutations.

To keep a child, use `/agents take NAME` in the parent or `/take` in the idle
child. Transfer is explicit and irreversible for this coordinator: parent
dispatch and automatic cleanup stop, your input goes straight to its Pi, and
its results no longer reach the parent. The child retains its role tool
allowlist and routing extensions; human takeover does not turn a scout into a
worker. An exclusive durable claim arbitrates takeover against terminal
closure, including lost receipts.

## Policy and lifetime

The existing [workflow roles](roles.md) apply: advisor uses `advisor`; scout,
researcher and worker use `task`. A child retains its original model, tools, instructions, and
working directory across tasks. Each task receives fresh turn/time limits and
separate usage accounting. Parent model selection never changes. Missing models,
authentication, Rex identity, or required routing fail without fallback.

When `ask_user_question` or `todo` is active in the parent, every child also
gets it and loads the [ask](ask.md) or [todo](todo.md) extension; neither is
tool routing for `subagents.sandbox`. Time a child spends waiting for you, in any dialog, does
not count against its task deadline.

`subagents.rexConcurrency` (default 6, at most 16) limits live managed
children, including idle ones; it is separate from the headless runner's
`subagents.concurrency`. Raise it in `roles.local.json` for larger batches. Each
child runs one task at a time, with at most 64 tasks and 64 parent steering messages
per task. Follow-ups retain conversation context and the worker's existing worktree.
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

`pm-test` covers Agents tab planning and a layout simulator at 12 children,
names, `next` ordering, widget and listing formatting, the `←` gate and
target, protocol framing, persistent tasks, steering boundaries, typed
follow-ups, todo progress and its program status rewriting, cancellation
races, ownership arbitration, durable results, native layout checks, and
cleanup with fake Rex and local sockets. It makes no model calls or live Rex
mutations.

Explicit live checks create and remove their own test terminals:

```sh
node tests/fixtures/rex-smoke.ts
node tests/fixtures/rex-smoke.ts --dispatch
node tests/fixtures/rex-smoke.ts --ask        # --dispatch plus a question answered in the child
node tests/fixtures/rex-grid-smoke.ts 12
node tests/fixtures/rex-grid-smoke.ts 6 --show   # needs Rex.app Remote Control
node tests/fixtures/rex-parent-smoke.ts
node tests/fixtures/rex-parent-smoke.ts --open   # also ← to a child and back
```

The first checks native peek and detach, preserved focus, and takeover. With
`--dispatch` it also checks conversation-preserving follow-ups, steering,
cancellation, a follow-up typed into the child's pane, todo progress reaching
both the parent and Rex's program status, and immutable results through real
Pi, and captures the child's screen to check its named header and compact task
display. It uses an isolated fixed-response provider with `fetch` disabled,
never credentials or external model requests.

The grid check arranges placeholder terminals beside a stand-in parent window
that already holds a second pane, and checks that window is untouched, the
placeholder replaced, even sizes, the 3×3 cap with detached overflow,
promotion of a child that needs you, tab order and label, the tab closing with
its last child, and unchanged focus. `--show` briefly displays the Agents tab
in Rex.app, then switches back.

The parent check starts a real parent Pi with a pane beside it and two real
children, from an isolated agent directory whose roles point at a
fixed-response provider. It checks the Agents tab, the untouched parent
window and the widget, then types into the working child (a steer) and the
idle one (a follow-up the parent records as yours). `--open` also presses `←`
in the parent, which must focus the child with an unread result, and `←` in
that child to come back; it switches Rex.app to the test tabs briefly and then
back to the window that was active.

Capabilities are checked against the running server's schemas through the
[Rex CLI/server API](https://www.superlogical.com/rex/docs/automate/server-api).
Terminal keystrokes and screen scraping are not the control protocol.
