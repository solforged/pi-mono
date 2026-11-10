# Measuring

Fault injection shows what Pi does when a provider misbehaves, and what an
extension changes. It makes no model calls.

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
