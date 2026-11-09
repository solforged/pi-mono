# Development

## Conventions

Use Pi's bundled APIs and Node built-ins; do not add third-party extension
packages or runtime dependencies. Deploy individual extension directories with
`index.ts` entry points, so internal modules and test fixtures never load as
standalone extensions.

Keep the root README as an entry point: what the extensions do, how to enable
and develop them, and links to topic guides. Put setup, operations, option
reference, and troubleshooting under `docs/`. Keep model selections and other
configuration snapshots in their source files.

The [computer prototype](../computer/README.md) is isolated from host extensions.
Host setup must not provision, start, or grant credentials to a guest.

## Checks

Use Node 26 and Git on `PATH`; no npm installation is required. Run from the
repository root:

```sh
mise run test
mise run computer:test
# Or directly:
node --test tests/*.test.ts
node --test computer/tests/*.test.mjs
```

The suites make no model calls. Git hooks are isolated only in throwaway test
repositories; production hooks remain active. When Pi is installed, the
Anthropic integration test exercises its bundled SDK and stream parser with
intercepted HTTP requests. The computer suite includes an encrypted backup
round trip when age and qemu-img are installed; otherwise that test is skipped.
See the [computer checks](../computer/README.md#checks) for guest script checks
and explicit live acceptance tests. These offline suites do not start a guest.

## Check the user's configuration

These commands make no model requests:

```sh
pi --offline --no-extensions --no-skills --no-context-files \
  --no-prompt-templates --no-session \
  -e ./extensions/workflows/index.ts -p '/roles check'
pi --offline --no-extensions --no-skills --no-context-files \
  --no-prompt-templates --no-session \
  -e ./extensions/web-search/index.ts -p '/web-search check'
pi --offline --no-extensions --no-skills --no-context-files \
  --no-prompt-templates --no-session \
  -e ./extensions/snapcompact/index.ts -p '/snapcompact'
pi --offline --no-extensions --no-skills --no-context-files \
  --no-prompt-templates --no-session \
  -e ./tests/fixtures/anthropic-smoke.ts -p '/anthropic-smoke'
pi --offline --no-extensions --no-skills --no-context-files \
  --no-prompt-templates --no-session \
  -e ./extensions/artifacts/index.ts -p '/artifacts check'
pi --offline --no-extensions --no-skills --no-context-files \
  --no-prompt-templates --no-session \
  -e ./extensions/sessions/index.ts -p '/sessions check'
```

The opt-in [Rex prototype checks](rex.md#checks) include live terminal smoke
tests with a fixed-response provider; they make no external model requests.

## API references

Read the installed Pi documentation and shipped `session-name.ts`,
`summarize.ts`, and `subagent/` examples before changing extension APIs. Check
interactive TUI, print/JSON, and child-agent behavior when applicable. No upstream
extension code is auto-downloaded or updated by this implementation.
