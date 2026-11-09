# Status line

`extensions/statusline` replaces Pi's two-line footer with one line in the
style of OMP's status line. It needs a Nerd Font and is active only in the
interactive TUI.

```text
 Opus 5.5 · 󰪡 med ·  ~/src/pi-sol ·  main +2 *4 ?16 ⇡1 · 󰊚 2.5%/1M 󰁨 ·  96% · 󰙺 2.74
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
- Session cost from every billed entry, as in Pi's footer. On a subscription,
  a crossed-out dollar replaces `$`: the amount is what API billing would have
  charged.

Extension statuses and the session name are right-aligned when they fit. When
they don't, the session name moves to a second line, followed by statuses if
they don't fit either. Narrow terminals shorten the path and Git segment first, then drop cost,
cache, path, Git, context, and thinking in that order.

Per-direction token totals are left out; `/session` still reports them.
