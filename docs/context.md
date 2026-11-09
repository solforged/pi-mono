# Context management

## Snapcompact

Pi's default compaction asks the current model to summarize discarded history.
For vision-capable models this extension instead archives that history as dense
PNG frames of 8x13 pixel text, the same idea as oh-my-pi's snapcompact,
implemented with Node built-ins and a vendored public-domain font. Text-only
models keep the default LLM summary. `/compact` with extra instructions also
keeps the default summarizer.

`/snapcompact` shows whether this model will use it and the size of the last
archive on this branch. Frames are stored on the compaction entry and
re-attached on every LLM request.

## Output artifacts

Successful top-level `bash`, `powershell`, `grep`, `find`, `ls`, `web_search`,
and `codemode` results exceeding 8 KiB of text or 160 lines are saved under
`<agent-dir>/tool-artifacts/`. The result entering history contains an artifact
UUID and bounded, verbatim start/end excerpts plus selected diagnostic lines.
These are explicitly incomplete, not a generated summary. There are no model
calls or edits to older history, so existing cached prefixes are not deliberately
rewritten.

Use the model-callable `artifact_read` tool to retrieve omitted evidence:

```json
{ "id": "UUID_FROM_RECEIPT", "query": "timeout", "limit": 20 }
```

Queries are case-sensitive literal substrings, not regexes. `offset` selects a
1-based starting line; `limit` defaults to 40 and cannot exceed 80. Each response
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

This repository's tools keep their declarations small. Each description says
when to use the tool; parameter limits are enforced in code, with errors that
explain them, rather than in the schema. Tools add no rule or tool-list lines,
except the ask tool's two deliberate guidelines. `tests/fixtures/prompt-size-smoke.ts`
holds a size budget for every repo tool and fails when one grows past it.
