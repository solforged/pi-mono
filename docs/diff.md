# Diff pane

`extensions/diff` adds `/diff`, which opens a live Git diff in a Rex pane to
the right of Pi. The pane takes a third of the width, and Pi reflows into the rest.
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

If the pane was still open when you quit Pi, the next Pi started in the same
worktree reopens it straight away, provided there are still uncommitted
changes. This covers `pi`, `pi -c` and `pi -r`, but not `/new`, `/resume` or
`/reload`, which keep the pane they had. Closing the pane before quitting
forgets it. Open panes are remembered by worktree in
`~/.pi/agent/diff-panes.json` for up to 30 days.

Each check runs `git status` without optional locks after a tool that can
change files, and stops once the pane is open. Configure it in
`~/.pi/agent/settings.json`:

```json
{ "diff": { "autoOpen": true, "reopen": true, "minColumns": 150 } }
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

The pane belongs to the Pi process, so it stays open across `/new`, `/resume`
and session moves. When the session lands in another working tree, such as a
move into a worktree with `/wt enter` or back with `/wt exit`, the pane switches
to that tree, and Pi remembers it there for the next start.

## Keys

A bar along the bottom shows the main keys, and you can click them. Files,
the source label and the scrollbar highlight under the pointer.

| Keys | Action |
|---|---|
| `↑` `↓`, `j` `k`, mouse wheel | Scroll |
| `d` `u`, `space` `b` | Half page, page |
| `g` `G` | Top, bottom |
| `←` `→`, `]` `[`, `tab`, click a file | Previous or next file |
| `shift+↑` `shift+↓`, `p` `n` | Previous or next change, on into the next file |
| Click or drag the scrollbar | Jump through a long diff |
| `s`, click the source | Switch source |
| `w` | Toggle wrapping |
| `f` | Follow Pi's edits |
| `r` | Refresh |
| `?` | Help |
| `q` | Close |

The title shows which change you are on (`change 2/5`), or how many there are
when they all fit. A file you come back to keeps its scroll position.

## How it works

`/diff` splits `$REX_BLOCK` with Rex's `session.new_split` and starts
`viewer.ts` with the `node` found on `PATH` (22.18 or later). The new terminal
starts at the size it will end up with, and the border is then moved to give it
a third, because Rex ignores the split's ratio. The viewer redraws only once
resizes settle. The viewer is a standalone terminal
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
`$TMPDIR/pi-diff-<uid>/`, keyed by Pi's process ID. When Pi quits it tells the
viewer to close straight away; the viewer also checks every 250 ms that Pi is
still running, to close after a crash or a kill.

Outside Rex, `/diff` reports that it needs a Rex pane and does nothing else.
