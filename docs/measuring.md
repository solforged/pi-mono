# Measuring

Two offline tools decide whether a feature is worth adding. Neither makes model
calls.

## Session profile

```sh
mise run profile
mise run profile -- --since 2026-11-01 --json
mise run profile -- --dir /path/to/sessions
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
  unexplained miss.
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
mise run faults
mise run faults -- empty-stop tool-loop
mise run faults -- --with extensions/recover/index.ts --json
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
