# Recovery

Pi retries provider errors, discards partial replies before retrying, and gives
every unrun tool call an error result. `extensions/recover` handles three turn
endings Pi leaves to you. Each adds a short note for the model and one line in
the transcript; nothing already sent is rewritten, so the prompt cache is kept.

- **Empty reply.** A turn that stops with no text and no tool call, including
  one that only reasoned, is left out of the context and the model is asked for
  the answer or the next tool call.
- **Reply cut at the output limit.** Text that was cut is kept and the model is
  asked to continue where it stopped. If only reasoning was produced, the turn
  is left out and the model is asked for the next step alone.
- **Repeated tool call.** When the same calls return the same results three
  turns in a row, the model is told that repeating will not change the outcome.
  The fifth identical call is refused instead of run. A call whose result
  changes, such as polling `rex_result`, never counts.

Empty and cut-off replies are continued at most twice per prompt. Failed and
aborted turns are left to Pi's retries and to [`/retry`](retry.md). A tool call
cut at the output limit is already handled by Pi.

`/recover` shows how often each case occurred since the extension loaded;
`/recover off` and `on` switch it for this runtime. Notes are stored as
`recover` custom messages, so `mise run profile` counts them across sessions.

The behavior is checked against real Pi with scripted faults:

```sh
mise run faults                                        # what Pi does alone
mise run faults -- --with extensions/recover/index.ts  # with recovery loaded
```

See [measuring](measuring.md#fault-injection) for the scenarios.
