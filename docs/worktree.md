# Worktree sessions

Non-trivial work moves the session into its own Git worktree and branch, like
Claude Code's EnterWorktree. The conversation carries over and Pi's tools,
context files and extensions rebind to the new directory. `/wt` lands the
branch, returns, or resumes sessions from other worktrees.

## When a session moves

In a main checkout the model has an `enter_worktree` tool and a rule to call
it before the first edit of non-trivial work, unless you asked to work in
place. In the TUI the first edits inside the checkout are turned back once
with that hint, including any others in the same batch; the hint says when the
checkout has uncommitted changes a worktree would leave behind. A retry goes
through, so trivial fixes stay put.

The tool ends the current response; once Pi is idle the session moves and
continues the task. Any call batched with the move is blocked so nothing lands
in the main checkout. Expect one prompt-cache miss, since the prompt names the
working directory.

Nothing happens in linked worktrees, outside Git, with `--no-session`, or in
Rex and workflow children, which already have worker worktrees.

## Layout

The worktree is `$PI_WORKTREE_DIR/<repo>--<slug>` (default `~/.pi/wt`), the
same layout as `ga`, on branch `pi/<slug>` from the current `HEAD`. The slug
is the first three words of the session title, without filler such as "a" or
"the" and at most 28 characters ("Assess a fullscreen diff extension" becomes
`assess-fullscreen-diff`). Without a title it uses the name the model passed,
only as a fallback, else the session ID; taken names get `-2`, `-3`. Uncommitted changes in the main checkout are
not copied; you get a warning instead. `mise trust` runs on the new directory.

The branch follows the session title: setting or generating a title renames
it, as long as this session created it and it has no upstream. The directory
keeps its first name.

## Local setup files

A fresh worktree has no ignored files such as `.env` or local config. List
them in `.worktreeinclude` at the checkout root, in `.gitignore` syntax, as
Claude Code and Codex do:

```gitignore
.env
.env.local
config/local.json
```

Files that match and are also ignored by Git are copied, cloned where the
filesystem supports it; symlinks stay symlinks. Tracked files and existing
files in the worktree are never touched.

## The session file

The session keeps its ID and file. Only its header `cwd` changes; the file
stays in the main checkout's session folder. From the main checkout,
`pi --resume`, `/resume` and `pi --session <id>` open it in the worktree,
and `/wt resume` finds it from any checkout. `pi -c` runs the newest session
in the current directory, so from the main checkout it would run a worktree
session there; Pi warns, and `/resume` reopens it in its worktree. Files an
earlier version moved into a worktree's folder are still found by
`/wt resume`, and return when the session leaves. The sandbox remembers its
toggle per directory, so a worktree starts from your settings, except that a
session moving with the sandbox on keeps it on.

## Commands

| Command | Behavior |
| --- | --- |
| `/wt` | Show the checkout, branch, and worktree root. |
| `/wt enter [name]` | Move now, without asking the model. |
| `/wt exit [keep\|remove]` | Return to the main checkout. |
| `/wt land [keep\|remove\|stay]` | Land the branch on the main checkout's branch. |
| `/wt resume` | Pick a session from the repository's other worktrees. |

`land` needs a clean worktree. It rebases the branch when the main
checkout's branch has moved on, then fast-forwards that branch, so no merge
commit is created. A conflicting rebase is aborted with both branches
unchanged; resolve it with `git rebase` in the worktree and land again. A
branch with an upstream is not rebased. In the TUI it then asks whether to
return; elsewhere it stays unless you pass `keep` or `remove`.

`exit` asks in the TUI. `remove` only removes a clean worktree, and deletes
the branch only if this session created it and it is merged into the main
checkout's `HEAD`; otherwise both stay. Each move is reported in the session,
so the model knows where it is.
