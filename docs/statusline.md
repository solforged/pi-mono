# Status line

`extensions/statusline` replaces Pi's two-line footer with one line in the
style of OMP's status line, and puts the session name in the editor's top
border. It needs a Nerd Font and is active only in the interactive TUI.

```text
───────────────────────────────────────────────────── Audit Nushell implementation ─

────────────────────────────────────────────────────────────────────────────────────
 ~/src/system (wt) ·  audit-nushell *4 ?1        󰪣 Opus 5.5 · 󰊚 28%/1M 󰁨 · 󰙺 11.00
```

The left side says where the session works:

- Working directory, shortened from the left past 40 columns. In a linked Git
  worktree it shows the matching directory of the main checkout, marked
  `(wt)`; the branch names the task, without the `pi/` prefix of Pi's own
  worktree branches.
- Git branch (or short commit when detached) with conflicted `!`, staged `+`,
  unstaged `*`, and untracked `?` counts, then commits ahead `⇡` and behind `⇣`
  of upstream. Counts refresh after tool calls and runs. A poll catches
  changes made outside Pi: every 10 seconds, slowing to once a minute while
  it finds nothing new, and not at all outside a repository.

The right side says what it runs and spends:

- Model name without a leading "Claude". When the model reasons, its icon is
  the thinking level in that level's editor border color: a circle that fills
  with the level, a flame at max.
- Context use of the window, rounded to a percent, with 󰁨 when automatic
  compaction is enabled. It turns yellow past 70% and red past 90%.
- Cache hit rate of the latest request (cache reads over all prompt tokens),
  only below 80%; below 50% is yellow. Failed requests keep the previous rate.
- Session cost from every billed entry, as in Pi's footer, plus the
  [workflows](workflows.md) model calls Pi does not bill. On a subscription,
  a crossed-out dollar replaces `$`: the amount is what API billing would have
  charged.
- Segments other extensions contribute, ordered by key, such as the
  [sandbox](sandbox.md) marker.

An extension adds or replaces a segment with

```ts
pi.events.emit("statusline:segment", { key: "my-ext", text: "label", color: "warning", priority: 1 });
```

and removes it by emitting the same key with no text. `color` names a theme
color (default `muted`); `priority` ranks the segment against the built-in ones
when the line is too narrow (default 1, the same as cost); `position: "start"`
puts it on the left, before the path, instead of on the right after the cost. A segment replaces the
extension status (`ctx.ui.setStatus`) with the same key. An extension can
therefore publish both, so its state still shows in Pi's built-in footer
without appearing twice here.

Extension statuses go before the right side when they fit, and on a second
line when they don't. Narrow terminals shorten the path, Git segment, and
context (dropping the window size) first, then drop cost, cache, path, Git,
context, and the model in that order.

## Editor border

The session name sits at the right end of the editor's top border, after
Pi's working status, which the editor draws in that border instead of on a
line of its own. The name is shortened to fit and left out when fewer than 12
columns are free; the footer then shows it, as it does when another
extension has replaced the editor.

Pi takes one editor, so extensions that need it share one from
`extensions/shared/editor.ts`: each calls `useEditorFeature(ctx, key, factory)`
to rewrite the top border or see keys first. The [Rex](rex.md) `←` key is the
other feature.

Per-direction token totals are left out; `/session` still reports them.
