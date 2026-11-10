# Diff pane

`extensions/diff` adds `/diff`, which opens a live Git diff in a Rex pane to
the right of Pi. The pane takes 40% of the width, and Pi reflows into the rest.
Run `/diff` again, or press `q` in the pane, to close it. The pane also closes
when Pi exits.

## Opening automatically

In each session, the pane opens the first time Pi changes the working tree:
when an `edit`, `write` or `bash` call leaves `git status` (paths, sizes and
modification times) different from how it was when you sent the prompt. Your
own edits between prompts do not count. It opens on the file Pi just wrote.

It opens at most once per session, so closing it keeps it closed until the next
session. Running `/diff` yourself also turns it off for the session. It never
opens in child agents, outside the interactive TUI, or while Pi's terminal is
narrower than `minColumns`; in that last case it waits until the window is wide
enough.

Each check runs `git status` without optional locks after a tool that can
change files, and stops once the pane is open. Configure it in
`~/.pi/agent/settings.json`:

```json
{ "diff": { "autoOpen": true, "minColumns": 150 } }
```

`/diff staged` and `/diff branch` open the pane on another source. Press `s` in
the pane to cycle through the sources:

| Source | Compared |
|---|---|
| `uncommitted` (default) | Working tree and index against `HEAD`, with untracked files |
| `staged` | Index against `HEAD` |
| `branch` | Working tree against the merge base with `origin/HEAD`, `main` or `master` |

## Following Pi

The pane refreshes whenever files in the repository change. When Pi's `edit`
or `write` tool finishes, the pane jumps to that file and scrolls to the first
hunk that changed. Scrolling or switching files yourself pauses following, and
the header's dot turns hollow. Press `f`, or send Pi another prompt, to turn it
back on.

## Keys

| Keys | Action |
|---|---|
| `j` `k`, arrows, mouse wheel | Scroll |
| `d` `u`, `space` `b` | Half page, page |
| `g` `G` | Top, bottom |
| `]` `[`, `tab`, click a file | Next or previous file |
| `n` `p` | Next or previous hunk |
| `s`, click the source | Switch source |
| `w` | Toggle wrapping |
| `f` | Follow Pi's edits |
| `r` | Refresh |
| `?` | Help |
| `q` | Close |

## How it works

`/diff` runs `rex split` next to `$REX_BLOCK` and starts `viewer.ts` with the
`node` found on `PATH` (22.18 or later). The viewer is a standalone terminal
program with no Pi imports. It takes its colors from the Pi theme and asks the
terminal for its background, so the added and removed tints blend in.

Syntax highlighting uses the highlight.js build that Pi ships for HTML export
(`export-html/vendor/highlight.min.js` beside the `pi` binary), mapped onto the
theme's `syntax*` colors. Unchanged context lines are toned down so the changes
stand out. Each side of a file is highlighted as one block, so strings and
comments that span lines in a hunk color correctly. Without that file, or for
languages it does not include, lines are uncolored.

The viewer watches the repository and refreshes every 10 seconds as a fallback.
The extension sends edit hints through a private directory,
`$TMPDIR/pi-diff-<uid>/`, keyed by Pi's process ID.

Outside Rex, `/diff` reports that it needs a Rex pane and does nothing else.
