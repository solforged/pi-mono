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

- [Model roles](docs/roles.md): profiles, local overrides, and the role editor.
- [Workflows](docs/workflows.md): commands, naming, commits, and private state.
- [Subagents](docs/subagents.md): delegation, retained worktrees, sandboxing, and cancellation.
- [Ask](docs/ask.md): multiple-choice questions for the user, kept through compaction.
- [Rex prototype](docs/rex.md): named asynchronous children in a live deck and Agents window.
- [Learning](docs/learning.md): session mining, skill drafts, and approval.
- [Retry](docs/retry.md): `/retry` and F5 rerun a failed or aborted turn.
- [Herdr](docs/herdr.md): Desktop support and the separate TUI title bridge.
- [Status line](docs/statusline.md): a one-line footer with Git, context, and cache use.
- [Providers and search](docs/providers.md): Anthropic compatibility and nested web search.
- [Context management](docs/context.md): Snapcompact and output artifacts.
