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

The devenv shell provides Node 26 and the `pm-*` commands; Git comes from the
host, and no npm installation is required. Run `direnv allow` once, or prefix
a command with `direnv exec .` where the environment is not loaded. Avoid
`devenv shell --`: it unsets `TMPDIR`, which moves the diff extension's IPC
directory away from the one its link handler uses. The commands run from the
checkout that contains the working directory, so a worktree tests itself.

```sh
pm-test
pm-computer-test
# Or directly, from the repository root:
node --test --import ./tests/git-env.ts tests/*.test.ts
node --test computer/tests/*.test.mjs
```

The suites make no model calls. `--offline` stops only background network
traffic, not prompts, so smoke runs add `noModel` from `tests/helpers.ts`: its
provider fails any request, and a smoke command that is not registered fails
the test instead of reaching the default model. `pm-profile` and `pm-faults` are
the offline [measuring](measuring.md) tools; the second runs the installed Pi
against a scripted provider, as does `pm-compaction-smoke` for
[compaction timing](context.md#compaction-summaries). `pm-sandbox-smoke` is a separate live
check of the [sandbox](sandbox.md) that needs Apple container services. Git hooks are isolated only in throwaway test
repositories; production hooks remain active. `tests/git-env.ts` clears
`GIT_DIR` and the other variables that would point those repositories at
the one running the tests, as they are set inside a hook. When Pi is installed, the
Anthropic integration test exercises its bundled SDK and stream parser with
intercepted HTTP requests. The computer suite includes an encrypted backup
round trip when age and qemu-img are installed; otherwise that test is skipped.
See the [computer checks](../computer/README.md#checks) for guest script checks
and explicit live acceptance tests. These offline suites do not start a guest.

## Check the user's configuration

These commands make no model requests, provided the command exists; a
mistyped one goes to the default model as a prompt. Add
`-e ./tests/fixtures/no-model.ts --provider no-model --model no-model/none`
to rule that out when the check does not depend on the main model.

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
pi --offline --no-extensions --no-skills --no-context-files \
  --no-prompt-templates --no-session \
  -e ./extensions/todo/index.ts -p '/todos list'
pi --offline --no-extensions --no-skills --no-context-files \
  --no-prompt-templates --no-session \
  -e ./extensions/goal/index.ts -p '/goal'
pi --offline --no-extensions --no-skills --no-context-files \
  --no-prompt-templates --no-session \
  -e ./extensions/intercom/index.ts -p '/intercom list'
```

To see what your installed extensions, instructions and skills add to every
request, run `pi --offline --no-session -p /prompt-size` once `pm-install`
has linked the extensions.

The opt-in [Rex prototype checks](rex.md#checks) include live terminal smoke
tests with a fixed-response provider; they make no external model requests.

## API references

Read the installed Pi documentation and shipped `session-name.ts`,
`summarize.ts`, and `subagent/` examples before changing extension APIs. Check
interactive TUI, print/JSON, and child-agent behavior when applicable. No upstream
extension code is auto-downloaded or updated by this implementation.
