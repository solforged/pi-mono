# Pi extensions

Locally owned Pi coding-agent extensions, using Pi's bundled APIs and Node
built-ins. No third-party extension packages or runtime dependencies. Auxiliary
roles never switch the main conversation model or copy credentials.

## Install

The extensions load by symlink from this checkout, using an existing Pi
installation. No npm installation is required. Run `mise run install` to link
or refresh them; see the [setup guide](docs/setup.md) for agent-directory
overrides and removal.

To try one extension without deployment:

```sh
pi --no-extensions -e ./extensions/workflows/index.ts
```

## Develop

Run `mise run test` with Node 26 and Git available; it makes no model calls.
See the [development guide](docs/development.md) for the computer suite, offline
configuration checks, and API references.

`computer/` is an isolated, experimental VM controller. Host extension setup
does not provision or start a guest; see its [setup and safety notes](computer/README.md).

## Docs

- [Sandbox](docs/sandbox.md): tools run in a per-worktree Linux container when enabled (off by default for now), with a browser beside Pi that reaches it.
- [Model roles](docs/roles.md): profiles, `/modelpreset` lineups, local overrides, and the role editor.
- [Workflows](docs/workflows.md): commands, naming, commits, and private state.
- [Subagents](docs/subagents.md): delegation, retained worktrees, sandboxing, and cancellation.
- [Worktree sessions](docs/worktree.md): non-trivial work moves the session to its own worktree and branch; `/wt` lands, returns and resumes.
- [Ask](docs/ask.md): multiple-choice questions for the user, kept through compaction.
- [Rex prototype](docs/rex.md): named asynchronous children in a live deck and Agents window.
- [Learning](docs/learning.md): session mining, skill drafts, and approval.
- [Session search](docs/sessions.md): local historical search and original-entry retrieval.
- [Deferred tools](docs/deferred-tools.md): situational tools load through `tool_search`, with their groups listed in the prompt.
- [Retry](docs/retry.md): `/retry` and F5 rerun a failed or aborted turn.
- [Recovery](docs/recover.md): empty, cut-off and repeating turns continue without you.
- [Todo list](docs/todo.md): a per-session list with stop reminders and delegated context.
- [Goal](docs/goal.md): `/goal` keeps the agent working toward one objective until it is done, blocked or out of budget.
- [Figures](docs/figure.md): themed SVG mockups and diagrams shown inline on macOS.
- [Pasted images](docs/image-paste.md): pasted and dropped image paths are attached to the prompt and previewed above the editor.
- [Intercom](docs/intercom.md): notes between separate Pi sessions for coordinating work.
- [Herdr](docs/herdr.md): Desktop support and the separate TUI title bridge.
- [Status line](docs/statusline.md): a one-line footer with Git, context, and cache use.
- [Diff pane](docs/diff.md): a live, highlighted Git diff beside Pi in Rex that opens once Pi edits, and Markdown files, ⌘-clicked or opened with `/md`, in its place.
- [Providers and search](docs/providers.md): Anthropic compatibility and nested web search.
- [Context management](docs/context.md): background compaction summaries, snapcompact, compaction ratios, output artifacts, and `/prompt-size`.
- [Measuring](docs/measuring.md): the session profile and fault injection that size a feature.
