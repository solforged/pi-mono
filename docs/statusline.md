# Status line

`extensions/statusline` replaces Pi's two-line footer with one line in the
style of OMP's status line. It needs a Nerd Font and is active only in the
interactive TUI.

```text
 Opus 4.5 · 󰪡 med ·  ~/src/pi-sol ·  main +2 *4 ?16 ⇡1 ·  2.5%/1M 󰁨 ·  96% · 󰙺 $0.340
```

From left to right:

- Model name without a leading "Claude", then the thinking level when the
  model reasons: a circle that fills with the level (a flame at max), in the
  editor border's color.
- Working directory, shortened from the left past 40 columns.
- Git branch (or short commit when detached) with conflicted `!`, staged `+`,
  unstaged `*`, and untracked `?` counts, then commits ahead `⇡` and behind `⇣`
  of upstream. Counts refresh after tool calls and runs and every 10 seconds.
- Context use of the window, with 󰁨 when automatic compaction is enabled.
  It turns yellow past 70% and red past 90%.
- Cache hit rate of the latest request: cache reads over all prompt tokens.
  Failed requests keep the previous rate; below 50% is yellow.
- Session cost from every billed entry, as in Pi's footer, with 󰙺 for
  subscription providers.

Extension statuses and the session name are right-aligned when they fit. When
they don't, statuses move to a second line and the name is shortened or left
out. Narrow terminals shorten the path and Git segment first, then drop cost,
cache, path, Git, context, and thinking in that order.

Per-direction token totals are left out; `/session` still reports them.
