# Memory

The memory extension puts the small, always-on part of the memory wiki
(`~/.local/share/wiki`, or `$LLM_WIKI_DIR`) in front of the model. The rest
of the wiki stays on demand through the `memory` skill and the `wiki` CLI. The
extension writes nothing to the wiki.

Before each run it calls `wiki context` from the session's directory. The
wiki's scope rules choose the bundles, as they do for every other `wiki`
command, and on the work machine `LLM_WIKI_SCOPE=work` covers every directory.

- **Current context.** Each bundle's `now.md` (the stack and the current
  focus, at most 2,000 bytes) goes into a `memory_wiki` system prompt section.
  The section also names the CLI with its scope, so the model can search,
  read and define on demand, and asks it to offer to record corrections
  rather than write unasked. Pi patches the section only when it changes, so
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

`/memory` shows the scope and why it applies, the `now.md` size and refresh
date, and the terms defined in context so far.

The wiki's own README covers `now.md`, `wiki init` and the limits.
