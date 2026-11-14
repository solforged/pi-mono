# Workflows

## Commands

| Command | Behavior |
| --- | --- |
| `/roles [show\|check]` | Edit model roles, print mappings and the state directory, or check registration/auth. |
| `/autoname` | Generate another title; confirm before replacing an existing name. |
| `/commit [replan\|apply\|show\|clear]` | Split the working tree into commits, down to hunks; cache the plan. |
| `/advisor <task>` | Ask the advisor with a bounded recent-conversation excerpt. |
| `/subagent <advisor\|scout\|researcher\|worker> <task>` | Run a named agent with bounded context. |
| `/workflowz [reset]` | Show or reset the [workflowz](workflowz.md) kernel's jobs. |
| `/learn [flow]` | Have the current model author a managed skill. |
| `/learn-sessions` | Pick sessions to mine; the current session starts checked. |
| `/learn-review` | Inspect, approve, or dismiss a queued proposal. |
| `/curate-skills` | Audit changed, workflow-managed skills. |
| `/autolearn [on\|off\|dry-run]` | Show, toggle, or preview automatic learning for this project. |
| `/web-search [query\|check]` | Inspect search routing or run a query. |
| `/snapcompact` | Show whether this model archives compacted history as images. |
| `/artifacts [on\|off\|check]` | Inspect or toggle deterministic output archival. |

See [model roles](roles.md), [subagents](subagents.md), [learning](learning.md),
[providers and search](providers.md), and [context management](context.md) for
their detailed behavior.

## Session naming

Automatic naming runs as soon as the first substantive user message is sent in
the TUI.
It uses the shared or fallback `TITLE_SYSTEM.md`, never overwrites a manual
title, and makes at most one automatic attempt per session. Transient provider
errors (5xx, rate limits, timeouts) retry on your next message, up to three
tries; other failures leave the session unnamed until `/autoname` retries. Naming does not run automatically
inside subprocesses. See [setup](setup.md#agent-directory-and-shared-instructions)
for shared title instructions and [Herdr](herdr.md) for terminal integration.

## Continue shorthand

In the interactive TUI, submit `.` on its own to continue the session. The
model receives `continue` as a hidden message, so the transcript shows only
the resumed response; while a response is streaming, the dot steers or queues
like any other input. When idle after a failed or aborted turn, the dot runs
[`/retry`](retry.md) instead. Surrounding whitespace is ignored. Other input,
dots with image attachments, extension-injected messages, and noninteractive
sessions are unchanged.

## Commits

`/commit` asks the dedicated `commit` role to group the working tree into
commits, then creates them on the host so configured hooks still run. Modified
text files are offered as separate `-U0` hunks, so one file can be split across
features. A file stays whole if applying all of its hunks to the base blob does
not reproduce it exactly: new, deleted, renamed, binary, mode-changed, filtered
or non-UTF-8 files. Partial content is staged with `hash-object` and
`update-index`, so the working tree is never touched. Any existing staging is
reset first, including before a repository's first commit.

The planner sees the start of each change: up to 6 KB of a whole-file diff and
80 lines of a hunk. When everything together passes 120 KB, the longest units
are cut further, and every unit keeps its ID, path and opening lines.

The message format comes from `~/.config/git/commit-style.md` (or
`$XDG_CONFIG_HOME/git/`), plus a repository's `.commit-style.md`. The
repository file wins where they conflict. Proposed messages are checked with
`git hook run commit-msg` before anything is committed; failures go back to the
model, which gets up to three attempts.

The TUI confirms the plan. Print mode only prints it; `/commit apply` creates
the commits without asking. The plan is stored under `commits/plan.json` and
reused while the working tree, `HEAD` and the style files are unchanged. A hook
failure can therefore be fixed and retried without another model call. If a
hook edits the working tree mid-run, `/commit` stops and needs `replan`. A
background job that a hook leaves in Git's process group is killed when Git
exits.
`/commit replan` discards the cache, `/commit show` prints it, and
`/commit clear` deletes it.

## Private state and usage

State lives under `<agent-dir>/workflow-state/<profile>/<cwd-hash>/`;
`/roles show` prints the directory for the current one:

- `drafts/`: pending, applied, and dismissed learning proposals.
- `commits/plan.json`: cached commit groups for this working tree.
- `skills/`: approved skills, discovered only for this exact profile and working
  directory, including after `/reload`.
- `reviewed.json`: reviewed entry/fragment IDs and curated skill hashes.
- `autolearn.json`: the project toggle, indexed task steps, and reviewed patterns.
- `runs/`: child instructions, metadata, and JSONL transcripts; text returned to
  the parent is capped, full results remain here (32 MiB per run maximum).
- `worktrees/`: retained worker checkouts.

Directories/files created here are private (0700/0600). State is not committed
or automatically pruned. A crashed review, publisher, or commit can leave a
`.lock` directory; the next run takes it over once the process named in its
`owner.json` has exited. Do not remove active worktree directories by hand;
use the [worktree review procedure](subagents.md#worker-worktrees).

Subagent tool usage is reported in Pi's normal totals. Titles, commits,
learning calls, command-invoked subagents and workflowz evals are not; they are
recorded as `workflow-usage` session entries, which the
[statusline](statusline.md) adds to its session cost. Costs use provider
catalog prices and are zero when none are available.
