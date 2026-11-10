# Todo list

The `todo` extension keeps a todo list for the current session. The list is
stored in the session itself, so it survives restarts and `/resume`, follows
`/tree` navigation and forks, and is unaffected by compaction. A new session
starts with an empty list. Agents the session delegates to see its open items.

## Agent use

The `todo` tool accepts these actions:

| Action | Arguments | Effect |
|---|---|---|
| `list` | none | Return the full list. |
| `add` | `items`: one or more texts | Append pending items. |
| `update` | `id`, plus `status`, `text` or `note` | Change one item. |
| `remove` | `id` | Delete one item. |

Statuses are `pending`, `in_progress`, `blocked`, and `done`. A blocked item
keeps open and carries its reason in its note. Changes return a one-line
summary with the open and finished counts; `list` returns every item.

The tool's declaration is sent with every request, so it is kept under 450
characters of JSON, with no prompt snippet or guidelines; a regression check
enforces the budget. Clearing finished items is available only through
`/todos`. Notes appear in the agent's listings.

While the tool is active, each run adds a `<todos>` section to the system
prompt listing open items, at most 20 items or 2,000 characters, so the list
remains in view after compaction. Pi updates the section only when it changes.

## Reminders

When the agent stops with open items, the extension adds a reminder listing
them and asks the agent to continue, mark them done, remove them, or say that
it is waiting for the user. The terminal shows a one-line notice. A reminder is
sent only if a tool has run since the user's prompt or the previous reminder,
and at most three times per prompt. Aborted runs, print and JSON modes, and
sessions with the tool disabled receive none.

## Delegated agents

When the session calls `rex_agent`, `rex_send` with a follow-up, or `subagent`,
the extension appends the open items to the task's context as read-only data,
unless that would exceed the 16,000-character context limit. Children cannot
change the parent's list.

## Commands and display

A widget above the editor shows a progress bar and three open items beside it:
items in progress and blocked items first, with their reasons, then the pending
items that follow the one in progress. A count of the rest points to
`/todos`. On narrow terminals the items stack under the progress bar. The
widget hides when nothing is open.

`/todos` in the terminal UI opens a framed panel with a progress bar and the
items grouped by status. Finished items are struck through. The selected item
shows its note, and blocked items always show their reason. Use the arrow keys
to move, space to mark an item done or reopen it, Enter for further actions
including marking it blocked, `n` to edit its note, `a` to add, and `c` to
clear finished items. Below 50 columns the frame is dropped.

In any mode, `/todos` also accepts subcommands: `list`, `add <text>`,
`start <id>`, `block <id> [reason]`, `done <id>`, `reopen <id>`, `rm <id>`,
and `clear`. In print mode they write to standard output.

The list holds at most 200 items. Item text is limited to 500 characters and
notes to 2,000. Whitespace, including line breaks, is collapsed to single
spaces.
