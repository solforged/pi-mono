# Ask

`extensions/ask/` gives the model `ask_user_question`: one to four
multiple-choice questions in one dialog, with two to four options each. The
model is told to ask only when plausible readings of a request lead to
materially different work, and to otherwise decide and state its assumption.

```json
{
  "questions": [{
    "question": "Which database should the service use?",
    "header": "Database",
    "options": [
      { "label": "SQLite", "description": "Single file, no server" },
      { "label": "Postgres", "description": "Concurrent writers", "preview": "```yaml\nurl: postgres://localhost/app\n```" }
    ],
    "recommended": 1
  }]
}
```

`multi: true` allows several options. A `preview` is Markdown shown under the
options while that option is focused. Labels ending in `(Recommended)` and
questions sent as a JSON string are repaired before validation.

## Answering

The cursor starts on the recommended option. Enter or a number chooses; Space
toggles in multi-select. Every question has a last row for typing your own
answer, which multi-select keeps alongside checked options. With several
questions, Tab and the arrow keys switch between them, and a Review tab submits.

There are three outcomes:

- **Answered.** Unanswered questions, or a blank typed answer, go back as
  "decide yourself and state your assumption". That is how you skip.
- **Discuss in chat.** Esc, or the Review tab's second row, ends the turn
  without answers. Tool calls after the ask in the same response are blocked;
  ones before it have already run. Reply in your own words.
- **Interrupted.** Aborting the run closes the dialog.

Dialogs run one at a time. Print and JSON runs remove the tool at startup;
nothing re-enables it, so a `/tools` choice stands. RPC hosts get Pi's own
select and input dialogs, one question at a time; multi-select takes numbers
such as `1,3`, optionally followed by `; your own text`. Cancelling the
own-answer input returns to the options.

## Decisions after compaction

Answers stay in the tool result's details. Once compaction removes an answered
result from context, the extension adds one hidden message after the
compaction summary listing those decisions. It is derived from the current
branch on each request, works with both Pi's summary and snapcompact, and
changes only when a compaction does, so cached prefixes are unaffected.

## Subagents

[Rex children](rex.md) inherit the tool when it is active in the parent,
including advisors and scouts. The question appears in the child's pane, the
deck shows `! name needs you` with the first question, and time spent waiting
for you does not count against the role's deadline. Since you cannot chat with
a managed child, Esc there hands the questions back: the child stops and lists
them for the parent. Headless
[subagents](subagents.md) cannot ask; their definitions tell them to state the
assumption and list the question under "Open questions" instead, so the parent
can ask them all at once.
