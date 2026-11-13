# Memory

The memory extension puts the small, always-on part of the memory wiki
(`~/.local/share/wiki`, or `$LLM_WIKI_DIR`) in front of the model, and gives
it a `memory` tool for the rest. The tool writes only what the user confirms;
concepts with sources stay with `/skill:memory remember`.

Before each run it calls `wiki context` from the session's directory. The
wiki's scope rules choose the bundles, as they do for every other `wiki`
command, and on the work machine `LLM_WIKI_SCOPE=work` covers every directory.

- **Current context.** Each bundle's `now.md` (the stack and the current
  focus, at most 2,000 bytes) goes into a `memory_wiki` system prompt section.
  The section also points the model at the `memory` tool for lookups and asks
  it to offer to record corrections rather than write unasked. When the tool
  is not active, for example under `--tools`, it names the `wiki` CLI instead. Pi patches the section only when it changes, so
  it stays in the prompt cache.
- **Glossary.** The first time a prompt uses a glossary term or alias as a
  whole word, its definition is added to the conversation as a message shown
  as `◇ Glossary: PRR`, which expands to the full text. Acronyms and keys of
  one or two characters must match their case. Once compaction drops a
  definition, the next mention brings it back. Runs started by extensions,
  such as goal continuations, are not matched.
- **Warnings.** A stale or oversized `now.md` and a broken wiki each raise one
  notice per session. A machine with no built `wiki` stays quiet unless
  `LLM_WIKI_SCOPE` is set.

## The memory tool

| Action | Does | Runs |
|---|---|---|
| `search` | Finds concepts by words | `wiki search` |
| `read` | Opens wiki paths and counts the recall | `wiki read` |
| `define` | Looks up a term, or lists them | `wiki define` |
| `recent` | Lists unexpired journal lines | `wiki recent` |
| `jot` | Adds one line to this week's journal | `wiki jot` |
| `term` | Adds a glossary entry, or changes one with `replace` | `wiki term` |
| `now` | Replaces the text of `now.md` and sets the next refresh | `wiki now -set` |

The last three are writes. Each one first shows the user the exact line or
text, with the bundle it goes to, and runs only if they confirm; a session
that cannot ask, such as print mode, gets an error instead. The CLI picks the
bundle from the scope and enforces the limits, so the tool cannot write
outside the scope or past a limit. Where `bin/wiki` is not built, the tool is
withdrawn at session start.

`/memory` shows the scope and why it applies, the `now.md` size and refresh
date, and the terms defined in context so far.

The wiki's own README covers `now.md`, `wiki init` and the limits.
