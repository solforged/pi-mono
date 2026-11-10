# Goal

`/goal <objective>` gives the session one objective and keeps the agent
working on it across turns until it is achieved, blocked, out of budget, paused
or cleared. It is modelled on Codex's `/goal`. Use it when you would otherwise
keep typing "keep going": a migration, a flaky test, a benchmark target. A good
objective names the end state, the evidence that proves it and what must not
regress:

```text
/goal Make `mise run test` pass on this branch without skipping tests or changing public behavior
```

The goal is stored in the session, so it survives restarts and `/resume`,
follows `/tree` navigation and forks, and outlasts compaction. Only you set,
pause, resume or clear it; the agent can only close it.

## Commands

| Command | Effect |
|---|---|
| `/goal <objective>` | Set the goal, replacing any other after confirmation, and start working on it. |
| `/goal` | Show the goal, its status, and what this run has used. |
| `/goal pause` | Stop the loop; the current turn finishes. |
| `/goal resume` | Continue a paused, blocked or out-of-budget goal with a fresh budget. |
| `/goal clear` | Remove the goal. |
| `/goal continuations <n\|off>` | Cap the automatic continuations of each run. The default is 25. |
| `/goal tokens <n\|off>` | Cap the fresh tokens of each run, as in `500k` or `2m`. Off by default. |

The single words `pause`, `resume` and `clear`, and `continuations` or `tokens`
followed by one value, are commands; anything else is an objective. A run starts
at `/goal <objective>` or `/goal resume`. Fresh tokens are uncached input, cache
writes and output of the session's model requests and of tools that report
their own model use; cache reads are left out so a long context does not
consume the budget by being reread.

## The loop

While the goal is active, a `<goal>` section in the system prompt holds the
objective and the completion rules, and the `goal` tool is declared. Both
appear and disappear only when the goal changes, so the cached prompt is kept.

When the agent stops, Pi asks it to continue with a short note, shown as one
line in the transcript, if it ran a tool since the run started or the previous
note. A stop with no tool call, such as a question for you, ends the loop until
your next message; the footer then shows `waiting`. If an extension that runs
earlier has already asked the agent to continue at that stop, no note is added.

The loop also ends when:

- the agent calls `goal` with `complete` and the evidence, or with `blocked`,
  the blocker and what would clear it, after the same blocker stopped it three
  turns in a row;
- a budget is reached: the goal becomes out of budget and the agent gets one
  request to summarize progress, evidence and the next step. A token budget is
  checked after every model request, not only when the agent stops;
- you press Escape, which pauses the goal;
- you pause or clear it.

A goal set or resumed while the agent is busy starts once the current run
settles, so its prompt section is in place.

## Display

The footer shows `goal 3/25` (continuations used of the cap) while active, or
the status otherwise. Setting, pausing, resuming, budget changes and clearing
appear as one-line entries in the transcript; they are not sent to the model.

## Print mode

`pi -p "/goal <objective>"` runs the loop headlessly and returns when it
stops. The goal's summary is written to standard error, and the exit status is
1 unless the goal is complete.
