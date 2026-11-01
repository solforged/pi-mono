# Workflows

## Commands

| Command | Behavior |
| --- | --- |
| `/roles [show\|check]` | Edit model roles, print mappings, or check registration/auth. |
| `/autoname` | Generate another title; confirm before replacing an existing name. |
| `/commit [replan\|show\|clear]` | Split the working tree into file-level commits; cache the plan on failure. |
| `/advisor <task>` | Ask the advisor with a bounded recent-conversation excerpt. |
| `/subagent <advisor\|scout\|worker> <task>` | Run a named agent with bounded context. |
| `/learn [flow]` | Have the current model author a managed skill. |
| `/learn-sessions` | Pick sessions to mine; the current session starts checked. |
| `/learn-review` | Inspect, approve, or dismiss a queued proposal. |
| `/curate-skills` | Audit changed, workflow-managed skills. |
| `/workflows` | Show private state location and auxiliary usage. |
| `/web-search [query\|check]` | Inspect search routing or run a query. |
| `/snapcompact` | Show whether this model archives compacted history as images. |
| `/artifacts [on\|off\|check]` | Inspect or toggle deterministic output archival. |

See [model roles](roles.md), [subagents](subagents.md), [learning](learning.md),
[providers and search](providers.md), and [context management](context.md) for
their detailed behavior.

## Session naming

Automatic naming runs after the first substantive exchange settles in the TUI.
It uses the shared or fallback `TITLE_SYSTEM.md`, never overwrites a manual
title, and makes at most one automatic attempt per session. Failures leave the
session usable; `/autoname` retries explicitly. Naming does not run automatically
inside subprocesses. See [setup](setup.md#agent-directory-and-shared-instructions)
for shared title instructions and [Herdr](herdr.md) for terminal integration.

## Continue shorthand

In the interactive TUI, submit `.` on its own to send a normal `Continue.`
user message. Surrounding whitespace is ignored. Other input, dots with image
attachments, extension-injected messages, and noninteractive sessions are
unchanged. This does not rewind history or retry failed turns; no retry shortcut
is registered.

## Commits

`/commit` asks the dedicated `commit` role to group the current working tree
into file-level commits, then creates them on the host so configured hooks still
run. Messages use the OMP commit style: a lowercase past-tense summary in a
Conventional Commit header, at most 72 characters; an optional body of up to six
sentence bullets, wrapped at 72 columns with two-space continuations. It does
not split hunks inside a file. The TUI confirms the plan; print mode applies it.

The plan is stored under `commits/plan.json` and reused when the remaining files
are unchanged, so a hook failure can be fixed and retried without another model
call. Cached messages using the old policy are replanned. `/commit replan`
discards the cache, `/commit show` prints it, and `/commit clear` deletes it.

## Private state and usage

State lives under `<agent-dir>/workflow-state/<profile>/<cwd-hash>/`:

- `drafts/`: pending, applied, and dismissed learning proposals.
- `commits/plan.json`: cached commit groups for this working tree.
- `skills/`: approved skills, discovered only for this exact profile and working
  directory, including after `/reload`.
- `reviewed.json`: reviewed entry/fragment IDs and curated skill hashes.
- `runs/`: child instructions, metadata, and JSONL transcripts; text returned to
  the parent is capped, full results remain here (32 MiB per run maximum).
- `worktrees/`: retained worker checkouts.

Directories/files created here are private (0700/0600). State is not committed
or automatically pruned. A crashed review, publisher, or commit can leave a
`.lock` directory: inspect its `owner.json`, confirm that process is gone, then
remove only that stale lock. Do not remove active worktree directories by hand;
use the [worktree review procedure](subagents.md#worker-worktrees).

Subagent tool usage is reported in Pi's normal totals. Titles, learning calls,
and command-invoked subagents are tracked separately by `/workflows`. Costs use
provider catalog prices and may be zero when prices are unavailable.
