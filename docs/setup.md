# Setup

Use an existing Pi installation and keep this checkout in a stable location,
usually `~/src/pi-mono`. Pi and Node can be managed with mise; this repository
needs no npm installation. Run the [checks](development.md#checks) before
loading the extensions.

## Link the extensions

Pi discovers each extension directory through its `index.ts` entry point. From
the repository root, link every extension directory that has one, plus the
role defaults:

```sh
mise run install              # or: node scripts/install.ts
mise run install -- --dry-run # preview only
mise run install -- --with herdr-title # include an opt-in extension
```

The [Herdr TUI title bridge](herdr.md#tui-agent-titles) is opt-in; every other
extension is linked by default.

Rerun it after pulling a new release; new extensions are picked up without
documentation changes. Correct links are kept. Dangling links into this
checkout, such as a renamed extension, are removed. An extension link that
points to another extension directory with an `index.ts`, such as a
machine-specific variant kept in a separate checkout, is reported as
`external` and kept without failing the task. Any other existing
destination is reported as `review` and left untouched, and the task exits
nonzero until you resolve it. Then `/reload` in Pi or start a new session. Do
not link the whole repository into the extensions directory or load internal
modules and test fixtures separately.

## Agent directory and instructions

Pi defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it. The install
task honors that override.
Existing settings, credentials, global instructions, and unrelated extensions
are not replaced. Host extension setup never provisions or starts a guest.

Automatic naming prefers the agent directory's `TITLE_SYSTEM.md`, with the
repository's prompt as a fallback. An existing `roles.json` in the agent
directory overrides repository defaults; put personal changes in
`roles.local.json`. See [model roles](roles.md) for local overrides.

## Try or remove

To try one extension for a single run without installing links:

```sh
pi --no-extensions -e ./extensions/workflows/index.ts
```

Choose another extension's `index.ts` to test it instead. Do not combine
installed links with duplicate `-e` paths or a local package installation. If
migrating from the package setup, remove its settings entry with
`pi remove /absolute/path/to/pi-mono` before enabling the links.

To remove an extension, remove only its symlink and any corresponding mise
mapping, then reload Pi. Remove the `roles.json` link separately if no longer
needed. Preserve credentials, settings, `roles.local.json`, and private state.
