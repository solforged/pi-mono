# Retry

`/retry`, or F5 or a lone `.` in the TUI, reruns the last agent turn when it ended in an
error or was aborted with Esc, including after Pi's automatic retries give up. It
works like OMP's `/retry`: switch models or fix credentials first, then retry
with the current model.

The failed attempt is left on an abandoned branch, which `/tree` can still
show; it is not deleted.

- A turn that failed on its first response resends the prompt that started it
  on a new branch. The same applies to a turn started by an extension message.
- A turn that failed after tool calls keeps their results and continues with a
  short note to the model, hidden from the transcript. If Esc
  interrupted a tool, the note tells the model to run it again if still needed.
  Unlike OMP, Pi cannot rerun the tools without a model request.
- Earlier failed attempts and metadata entries at the tail are dropped with
  the turn. A model switched after the failure is recorded on the new branch.

Retry refuses while a response, automatic retry, or compaction is running, and
when the branch does not end in a failed turn, including after later prompts or
`!` commands. In print mode, `pi -c -p /retry` waits for the retried turn.
