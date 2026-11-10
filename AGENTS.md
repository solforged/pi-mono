# pi-sol

Locally owned Pi coding-agent extensions. Use Pi's bundled APIs and Node
built-ins; do not add third-party extension packages or runtime dependencies.

Keep this file project-specific. Shared style and workflow rules belong in the
user's global agent instructions.

## Development

- Use Node 26 and Git. Run `mise run test` for the regression suite and
  `mise run computer:test` for the VM controller suite. Neither makes model calls.
  Offline Pi configuration checks are in `docs/development.md`.
- Read the installed Pi documentation and examples before changing extension
  APIs. Check TUI, print, and child-agent behavior when applicable.
- Deploy individual extension directories, each with an `index.ts` entry point;
  internal modules and test fixtures must not load as standalone extensions.
- Never copy credentials between harnesses. Only an explicit `/modelpreset`
  switch may change the main model; role edits and profile selection never do.
  Unconfigured roles must fail without a fallback.

`computer/` is an isolated, experimental VM controller. Host extension setup
must not provision, start, or grant credentials to a guest.
