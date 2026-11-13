# Subagents

For inspectable interactive children, see the opt-in [Rex prototype](rex.md).
Inside Rex, its tools replace the `subagent` tool; `/subagent` still works there.

The model-callable `subagent` tool accepts `tasks`, an array of objects with
`agent`, `task`, and optional selected `context`:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find the authentication entry points" },
    { "agent": "advisor", "task": "Review the retry design", "context": "..." }
  ]
}
```

Advisor/scout have `read`, `grep`, `find`, and `ls`, not Bash. The researcher
adds `web_search` and `web_fetch`, so it needs the web-search extension loaded.
Workers also get Bash, edit, and write. Each child gets approved context-file instructions and
its authored definition from [agent-definitions/](../agent-definitions/); it
does not inherit the whole conversation or discover project resources.
Headless children cannot [ask you questions](ask.md#subagents); they list them
under "Open questions". Recursive delegation is not allowed. For pools larger
than one batch, see [workflowz](workflowz.md). Concurrency, batch, turn, and per-role
output/time limits are configured in [roles.json](../roles.json), with
[local role overrides](roles.md#profiles-and-local-overrides).

The `/advisor` and `/subagent` commands include a bounded recent-conversation
excerpt. The tool requires the caller to select context explicitly.

## Worker worktrees

A worker always gets a detached worktree from a clean repository's HEAD. Dirty
inputs are rejected rather than silently omitted. Worktrees and results remain
for review, including on failure; nothing is committed or integrated
automatically. Inspect and integrate deliberately, for example:

```sh
git -C /path/to/retained/worktree diff
# Inspect untracked files too; git diff alone does not include them.
git -C /path/to/retained/worktree status --short
# After integration and preserving anything you need:
git worktree remove /path/to/retained/worktree
```

Git administration belongs to the parent. The [sandbox](sandbox.md) mounts a
worktree and its shared Git directory at their host paths, so Git works inside
it; commits still belong to the parent.

## Sandbox and cancellation

The runner inherits explicit extension paths that override the requested parent
tools. With the [sandbox](sandbox.md) loaded, each child loads it too and follows
the parent's on/off state through `PI_SANDBOX`. The runner never silently drops
those wrappers because extension discovery is disabled. Inline/SDK tool overrides that cannot be reproduced from
a file cause dispatch to fail.

`subagents.sandbox: "required"` refuses dispatch unless the parent has a
file-backed tool-routing extension. This checks routing, not the security
properties of arbitrary extensions. An unwrapped parent with the default
`"inherit"` policy produces unwrapped children. Worktrees, read-only tool
allowlists, and separate processes are not security sandboxes.

Press Escape to cancel a command's loader or the active tool run. Children get
SIGTERM, followed by process-group SIGKILL if needed. Reload/session replacement
also cancels child work. Provider requests and review commands have deadlines.
No automatic cross-provider retry or fallback is permitted.

See [private state and usage](workflows.md#private-state-and-usage) for retained
results, and [Herdr Desktop](herdr.md#desktop) for the distinction between these
headless children and core-managed interactive terminals.
