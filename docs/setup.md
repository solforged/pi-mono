# Setup

Use an existing Pi installation and keep this checkout in a stable location,
usually `~/src/pi-sol`. Pi and Node can be managed with mise; this repository
needs no npm installation. Run the [checks](development.md#checks) before
loading the extensions.

## Link the extensions

Pi discovers each extension directory through its `index.ts` entry point. From
the repository root, link the seven public extensions and the role defaults:

```sh
repo="$PWD"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent_dir/extensions"
for resource in \
  extensions/workflows \
  extensions/web-search \
  extensions/snapcompact \
  extensions/continue \
  extensions/anthropic \
  extensions/herdr-title \
  extensions/artifacts \
  roles.json; do
  target="$agent_dir/$resource"
  if [ -e "$target" ] || [ -L "$target" ]; then
    printf 'Review existing path: %s\n' "$target"
  else
    ln -s "$repo/$resource" "$target"
  fi
done
```

Existing destinations are left untouched; review them rather than
force-replacing them. Then `/reload` in Pi or start a new session. Do not link
the whole repository into the extensions directory or load internal modules
and test fixtures separately.

On Hyperion, some links are declared in
`~/src/dotfiles/cli/mise/mise.hyperion.toml`. If mise manages a destination,
use `mise dot apply --yes <destination>` for that declared target. Add missing
mappings there before using mise to deploy the remaining extensions.

## Agent directory and instructions

Pi defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it. The loop above
honors that override, but fixed destinations in mise configuration do not.
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
`pi remove /absolute/path/to/pi-sol` before enabling the links.

To remove an extension, remove only its symlink and any corresponding mise
mapping, then reload Pi. Remove the `roles.json` link separately if no longer
needed. Preserve credentials, settings, `roles.local.json`, and private state.
