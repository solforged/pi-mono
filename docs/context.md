# Context management

## Compaction summaries

Pi's default compaction asks the current model to summarize discarded history
at the session's thinking level, and the run waits for it. The `compaction`
extension writes that summary instead:

- **At low thinking.** Summaries extract rather than reason, so they use `low`,
  or the session's level when that is lower (`SUMMARY_THINKING` in
  `extensions/compaction/plan.ts`).
- **In the background.** Once a completed turn brings the context within
  `clamp(threshold × 12.5%, 8,192, 32,000)` tokens of the threshold, it starts
  summarizing a snapshot of the branch while the run continues, as oh-my-pi's
  async compaction does. When Pi compacts, the prepared summary commits at
  once, or Pi waits for the one under way. Turns added since the snapshot stay
  verbatim after it. The status line shows `summarizing`, then `summary ready`.

The threshold is Pi's window minus reserve, or compact-ratio's share when that
is lower. A prepared summary is discarded when another compaction ran, its
history left the branch, summarized entries were edited, or the context would
stay above 80% of the threshold; inside the band, a finished summary that has
gone stale this way is written again. One failed
attempt is not retried before the next compaction. Every other case, including
`/compact` with instructions, summarizes Pi's own preparation at low thinking;
if that fails, Pi's default runs with a warning. Virtual models stay with Pi.
A background summary is paid for when it starts, so a replanned one, or one
from a session abandoned inside the band, is wasted.

`pm-compaction-smoke` runs the installed Pi against a scripted slow agent
and summarizer, with and without the extension, and reports how long each
compaction blocked the run.

## Snapcompact

For vision-capable models this extension instead archives discarded history as
dense PNG frames of 8x13 pixel text, the same idea as oh-my-pi's snapcompact,
implemented with Node built-ins and a vendored public-domain font. OpenAI
models (`TEXT_SUMMARY_PROVIDERS`) and text-only models get a text summary from
the compaction extension, which builds on an earlier archive's transcript.
`/compact` with extra instructions also uses a text summary.

`/snapcompact` shows whether this model will use it and the size of the last
archive on this branch, and what it adds to each request. Frames are stored on
the compaction entry and re-attached on every LLM request. Only the newest
pages are rendered: as many as fit 3 MB of image data and, in estimated tokens
(pixels / 750), 25% of the compaction threshold (`FRAME_TOKEN_SHARE`), so a
small window is not mostly archive again right after compacting. Older pages
stay in the archive as text.

The transcript is stored as one dense line: runs of whitespace collapse,
indentation included, and typography and accented Latin letters fold to ASCII.
Text in other scripts is kept as written. The frame font is ASCII only, so a
frame shows `?` for it, while the text sections at both ends and any later
text summary still read it. Such a summary carries the opening and the newest
part of the transcript, up to 10% of the threshold (`ARCHIVE_CARRY`).

## Compaction ratio

Pi's `compaction.modelOverrides` takes exact model keys and absolute reserves.
`compact-ratio` adds a per-provider share of the context window, set in
`PROVIDER_RATIOS` (Anthropic: 40%), so new models need no settings entry. A model
with its own `reserveTokens` override, or compaction disabled, is left to Pi.

It checks before each prompt you send while Pi is idle, and that prompt waits
for the compaction. It cannot act mid-run: compacting from `turn_end` or a
steering message aborts the running turn. Within one long run, only Pi's own
reserve applies, so give models you use heavily an exact override as well.

## Output artifacts

Successful top-level `bash`, `powershell`, `grep`, `find`, `ls`, `web_search`,
and `codemode` results exceeding 8 KiB of text are saved under
`<agent-dir>/tool-artifacts/`. Line count alone never archives a result: a long
listing of short lines costs less inline than its receipt and the reads that
recover it. The result entering history contains an artifact
UUID and bounded, verbatim start/end excerpts plus selected diagnostic lines.
These are explicitly incomplete, not a generated summary. There are no model
calls or edits to older history, so existing cached prefixes are not deliberately
rewritten.

Use the model-callable `artifact_read` tool to retrieve omitted evidence:

```json
{ "id": "UUID_FROM_RECEIPT", "query": "timeout", "limit": 20 }
```

Queries are case-sensitive literal substrings, not regexes. `offset` selects a
1-based starting line; `limit` defaults to 40; a larger request returns 80 lines. Each response
is also bounded to 6,000 bytes and supplies a continuation offset. Long lines
supply a `column` cursor so their entire text can be recovered without splitting
Unicode characters. Retrieval accepts only artifact UUIDs, never arbitrary host
paths; this also works when ordinary `read` is sandboxed.

Failed results, explicit `read`, `edit` and `write`, other unlisted tools, and
nested calls are unchanged. In particular, codemode scripts still receive the
original structured data and can filter it themselves; only their final large
text result is eligible. Images and existing tool details are retained. Raw
structured output is not retained alongside a replaced top-level text result.
A storage failure leaves the original result intact and reports a warning.

Artifacts contain the text delivered by the upstream tool; this cannot recover
anything that tool had already truncated. Receipts and tool details retain
upstream full-output paths when available. Multiple text blocks are joined with
blank lines; images stay in the result rather than being archived as text.

Files/directories are private (0600/0700), with no network transmission by this
extension. UUIDs survive reload, resume, and forks in the same agent directory.
Artifacts are retained until manually removed; deleting them breaks receipts in
old sessions. Treat them as sensitive as session logs. Inputs above 16 MiB fall
back to the original result rather than silently losing output.

`/artifacts` reports archived-result counts, text bytes omitted, and storage
failures since this extension loaded. These are byte counts, not tokenizer or
billing estimates. `/artifacts off` disables new archival until `on` or reload;
previous artifacts remain retrievable. This deliberately starts with preventing
large output from entering history, not semantic eviction of consumed evidence.

## Prompt size

Every request carries the system prompt and the active tools' declarations
before any conversation. `/prompt-size` shows both: the prompt by section
(tools list, rules, project instructions, skills and so on) and the
declarations grouped by the extension that registered them. Sizes are
characters of text or JSON, with tokens estimated at four characters each.
Repo tools that are registered but inactive, such as ask in print mode, are
listed separately and not counted. Extensions add some sections only when a
prompt starts (memory, the sandbox note, the deferred tool list), so the report
uses the prompt the last run sent, and says so when nothing has run yet.

The extension also drops Pi rules that only repeat their tool's description
(currently edit's `oldText` rule). It matches Pi's exact wording, and the smoke
test fails if Pi rewords a rule, so the trim cannot silently stop working.

This repository's tools keep their declarations small. Each description says
when to use the tool; parameter limits are enforced in code, with errors that
explain them, rather than in the schema. Tools add no rule or tool-list lines,
except where a model must act unasked: the ask tool's two guidelines, and one
each for `enter_worktree` and the sandbox's `browser`.
`tests/fixtures/prompt-size-smoke.ts` holds a size budget for every repo tool
except the sandbox's and fails when one grows past it.
