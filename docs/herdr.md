# Herdr

Herdr Desktop and Herdr TUI use different runtimes. Their integration APIs are
not interchangeable.

## Desktop

Herdr Desktop uses `herdr-core` (`hc`), separate from Herdr TUI's daemon, CLI,
and metadata API. Pi 1.4.0 already reports agent status through OSC 7501 when
the terminal confirms support; no Herdr integration extension is needed for
Desktop. TUI metadata tokens and sidebar TOML do not apply.

Use the installed `~/.config/herdr-app/AGENTS.md` and `hc --skill` for
version-matched guidance. The upstream [Desktop guide](https://herdr.dev/guide/)
and [core documentation](https://herdr.dev/core/) describe the two programs.

The current workflow children are headless JSON processes, not `hc` terminals,
so they do not appear as Desktop subagents. Desktop can show interactive agents
started with `hc run` under their parent, without a pane, and expose them through
peek or keep. That requires a separate interactive execution backend; wrapping
the existing `pi -p --mode json` invocation is not that integration. The core's
delegation manual requires interactive agents. Recovery of kept terminals opens
a shell after terminal loss; it does not resume or replay tasks.

## TUI agent titles

`herdr-title` targets Herdr TUI, not Desktop. It follows the active Pi session
name through the TUI's pane metadata. It syncs on startup, reload, resume, fork,
and name changes, including `/name` and `/autoname`. An unnamed or newly cleared
session clears the metadata title instead of inventing a directory-based name.
Workspace, worktree, tab, and manual pane labels are never changed.

Reports use `pane report-metadata` with source `user:pi-title` and an
`agent=pi` presentation guard. They do not take over agent lifecycle state or
session restore. To display these titles in Herdr's agent sidebar, configure
its Pi rows to include the `pane` token; without metadata that token falls back
to any manual pane label.

Titles have a 90-second TTL, renewed every 30 seconds even while Pi is idle.
The timer starts only at interactive session startup, is unreferenced, and stops
on shutdown. Quit, reload, and session replacement abort pending writes and
clear only this source's title. Cleanup is bounded and best-effort; a crash or
unavailable server leaves at most the last report's TTL. A new runtime uses the
same source to immediately replace or clear stale metadata. Unchanged event
updates are skipped, but heartbeat always renews a live title. Command failures
are quiet and retry on heartbeat or subsequent events.

Only interactive TUI sessions inside Herdr write or clear metadata. Commands
target the inherited `HERDR_PANE_ID`, never focus. Print, JSON, and RPC child
agents do nothing, including on shutdown. Each Pi pane has its own title, so
multiple agents in a tab need no ownership wiring. Legacy `HERDR_TITLE_OWNER`
values are ignored. No model calls or state polling.

The separate state/session hook installed by `herdr integration install pi` is
also TUI-only. `~/src/system` manages that hook through
`modules.agents.pi.herdrTuiIntegration.enable`; see its `docs/agents.md` for
activation and migration. This package does not install or replace that hook.
