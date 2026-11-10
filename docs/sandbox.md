# Sandbox

`extensions/sandbox` runs Pi's file and shell tools (`read`, `write`, `edit`,
`bash`, `grep`, `find`, `ls`) and your `!` commands in a Debian arm64 container
using Apple's `container` CLI. It is on by default. Pi itself, other extension
tools, and provider credentials stay on the host.

While the sandbox is on, a green cube follows the cost on the status line, with
`…` while it starts and a red `!` when it is unavailable. With the sandbox off,
there is no marker.

## Requirements

- Apple `container` on `PATH`, with services started (`container system start`).
  Keep the service version matching the CLI; `container system status` shows both.
- The first use builds the image from [extensions/sandbox/image](../extensions/sandbox/image)
  (about a minute). Editing those files triggers a rebuild on the next start.

## Turning it off

| How | Scope |
|---|---|
| Ctrl+Shift+S, or `/sandbox off`, `/sandbox on`, `/sandbox toggle` | This project, remembered across launches |
| `pi --sandbox off` | This process |
| `"enabled": false` in settings | Globally or per project |

The flag wins, then a parent Pi's state for child agents, then the project's
last toggle, then settings. Toggles are kept per project root in
`~/.pi/agent/sandbox-toggles.json`, outside the guest's reach; toggling back to
the settings value removes the entry.

`/sandbox` shows the container, mounts, and guarded paths; `/sandbox restart`
recreates the container or retries a failed start. When the sandbox is on and
cannot start, tools fail; they never fall back to the host.

## What the guest sees

Everything keeps its host path, so paths in sessions and tool output stay valid.

| Path | Access |
|---|---|
| The project (Git top level of the working directory) | read-write |
| A linked worktree's shared Git directory | read-write |
| `$LLM_WIKI_DIR` | read-write (setting `wiki`) |
| Shared folders from settings | read-only unless set otherwise |
| `~/.agents/skills`, Pi's installation and docs, `~/.config/git` | read-only |
| `/cache` (`~/.cache/pi-sandbox/shared`) | mise, Cargo, Go, npm, and uv caches |

Inside writable mounts, Git `config` and `hooks`, a worktree's `.git` file, and
the project's `.pi/` are read-only: host Git and Pi act on those without you
running anything. `node_modules`, `target`, and `.venv` are replaced by
Linux-only directories per worktree when `package.json`, `Cargo.toml`, or
`pyproject.toml` exists, so host and guest builds never mix. The wiki's `bin/`
gets a Linux build of its CLI.

The guest has no SSH agent, keys, or host environment variables, and runs as
root on files owned by you on the host. It has ordinary outbound network access.

## Toolchains and commits

Project tools come from mise inside the guest (`mise install`); installs persist
in `/cache`. Commits are made on the host so signing and hooks run: the guest
stages with `git add`, and the model calls `git_commit`, which runs
`git commit` on the host. Guest commits fail unless forced with
`--no-gpg-sign`.

With the sandbox off, host bash in a linked Git worktree whose root has a
`Cargo.toml` sets `CARGO_TARGET_DIR` to the main checkout's `target/`, so
throwaway lanes share one build instead of each copying every dependency. An
existing `CARGO_TARGET_DIR` wins, and a command can export its own to build in
isolation. In the guest, `target/` is the Linux build overlay instead.

## Settings

Settings are read only from `~/.pi/agent/settings.json`, never from a project's
`.pi/settings.json`, which the guest could edit. Project entries apply to the
named directory and everything below it.

```json
{
  "sandbox": {
    "enabled": true,
    "cpus": 6,
    "memory": "8G",
    "wiki": "rw",
    "mounts": ["~/src/shared-notes", { "path": "~/src/fixtures", "readonly": false }],
    "projects": {
      "~/src/work-app": { "enabled": false },
      "~/src/big-rust": { "memory": "16G" }
    }
  }
}
```

`wiki` is `"rw"`, `"ro"`, or `"off"`. `image` replaces the built image with your
own, which must provide `/usr/local/libexec/pi-sandbox/pi-run`, `rg`, and `fd`;
building `FROM` the default image is simplest.

## Sessions and children

Pi processes in the same worktree share one container. Each holds a lease, and
the last to exit deletes it; containers left by crashed sessions are removed on
the next start. `/new`, `/resume`, `/fork`, and `/reload` keep the container and
whatever is running in it, unless the new session resolves to different
sandbox settings or another project. Subagent and Rex children follow the
parent's on/off state and load the same extension, so scouts share the parent's
container and workers get their own.

## Limits

This keeps generated commands away from your home directory, credentials, and
host processes. It does not make untrusted code safe to run later: the guest
can still edit project files that you or your tools execute on the host
(package scripts, Makefiles, `mise.toml`, hooks configured from the work tree),
and it can reach the network. Submodule Git directories are not guarded.

Locks do not work across containers. Concurrent Cargo or mise installs from two
worktrees into the shared `/cache` can conflict; rerun the install if one fails.

## Checks and troubleshooting

`mise run sandbox:smoke` exercises every routed tool against a live container
in a throwaway repository, without model calls. Start and build failures are
logged under `~/.cache/pi-sandbox/state/` (`sandbox.log`, `build.log`).
Containers are named `pi-sbx-<project>-<hash>`; `container list` shows them.
