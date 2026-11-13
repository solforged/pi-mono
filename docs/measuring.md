# Measuring

Two offline tools decide whether a feature is worth adding; neither makes model
calls. A third, paid one settles what they cannot: whether a change to the
model's behavior helps.

## Session profile

```sh
pm-profile
pm-profile --since 2026-11-01 --json
pm-profile --dir /path/to/sessions
```

`scripts/profile.ts` reads saved sessions (by default those of the active agent
directory) and reports, for the branch each session would resume:

- **Cost** by cache reads, output, cache writes and uncached input, with tool
  calls per turn and turns per prompt.
- **What the prompt spend carried.** Each tool result, tool-call argument,
  reply and prompt section is charged once at the price of sending it and then
  at the cache-read price on every later turn, until compaction drops it. The
  last row is what this cannot attribute: images, cache misses and estimate
  error.
- **Cache rewrites**: requests that read less than half of a prompt over 20,000
  tokens from cache, by cause, with what the miss cost beyond a hit. A prompt
  or tool change normally keeps the cache, so it is shown as context for an
  unexplained miss. Pi's own cache-warming refreshes are totalled beneath, to
  weigh against the idle rewrites they prevent.
- **Turn endings** Pi leaves to the user, the notes
  [recovery](recover.md) wrote, and argument validation failures by field.
- **Candidate sizing**: each candidate feature replayed against the recorded
  sessions, in dollars. A candidate that rewrites sent history is charged for
  re-sending what followed. "Ceiling" rows assume every case could be avoided.

Dollar figures use the prices recorded on each turn. Bytes are converted to
tokens at a rate measured per model from prompt growth, because tokenizers
differ by a factor of two; a model with fewer than 20 usable turns falls back
to four bytes per token. Delegated children count toward the total but are not
broken down.

To size a new candidate, add a row in `profile()` and a case to
`tests/profile.test.ts`.

## Fault injection

```sh
pm-faults
pm-faults empty-stop tool-loop
pm-faults --with extensions/recover/index.ts --json
```

`tests/fixtures/fault-smoke.ts` runs the installed Pi in JSON print mode
against `fault-provider.ts`, a provider that replays the scripted responses in
`fault-scenarios.ts`: retryable and fatal errors, streams dropped at each stage,
empty and cut-off replies, malformed and duplicated tool calls, a repeating
call, context overflow, and resuming a damaged session. Each run uses its own
agent directory, session directory and working directory, with `fetch`
disabled.

One row per scenario shows whether the run settled, how it ended, retries,
requests, which tool calls ran, whether the history sent on the last request
was well formed, and whether it ended needing the user. Findings never fail
the run. `--with` loads an extension so the same faults show what it changes;
`--keep` leaves the temporary directory for inspection.

A custom provider receives history before Pi's built-in converters repair it.
The "after built-in repair" column applies the two repairs read from Pi 1.5.0's
code (failed turns dropped, missing results added); it is not an observation.

## Paired runs

```sh
pm-paired --check
pm-paired --with path/to/extension/index.ts --runs 3 --budget 20
pm-paired --report /path/to/results
```

`scripts/paired.ts` costs money: every run is a real session on the default
model. Use it only for a feature that changes what the model does, after the
profile shows there is something to gain.

Each task in `scripts/paired-tasks.ts` is a past fix or feature in this
repository; the `api-` tasks add an extension and need Pi's API. The run
starts from the tree before the change with the tests the change added, in a
fresh repository with no later history, and the prompt states the intent. A
run passes when those tests pass and were not edited. `--check` builds every
task and confirms its tests fail before the fix and pass after, without model
calls.

Both arms load the same few extensions from this checkout (`BASE` in the
script) and no installed ones, so a run cannot message other sessions, start
children, ask a question, or find the original fix in past sessions. The
`on` arm adds the extensions named with `--with`; `--both` adds one to both
arms, for example the `subagent` tool when the `on` arm is a rule about using it. The two arms of a task run
at the same time, in whole rounds, until `--budget` dollars are spent;
rerunning with the same `--out` continues where it stopped.

The report averages each task over its runs, then gives the mean difference
across tasks with a 95% bootstrap interval. With ten tasks and three runs only
a large effect clears the noise: the first use, a system-prompt rule asking for
read-only calls to be batched, cost $17.67 and measured +$0.006 a run with an
interval of −$0.005 to +$0.016 on runs averaging $0.29, so the rule was dropped.

## Deferred tool discovery

`pm-deferred-tools-eval` is a separate paid check of whether each preset
model finds deferred tools on demand; see [Deferred tools](deferred-tools.md#measured).
