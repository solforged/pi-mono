# Figures

The `figure` extension lets the agent show SVG mockups, layouts, diagrams and
charts inline in the terminal. It needs macOS, the interactive terminal UI, and a
terminal that shows images (Rex, Ghostty, kitty, WezTerm or iTerm2). On other
platforms the tool is not registered. In print mode, or in a terminal without
images, the tool returns an error, so the agent describes the figure in text.

## How it works

The agent calls `figure` with an SVG and an optional title. The extension:

1. Checks the SVG. Scripts, animation, `<foreignObject>`, `<style>`, event
   handlers, DOCTYPEs and links outside the figure are rejected with a message
   the agent can act on. Attributes are checked in tags and comments only, so
   a label may read `online = 42` or `var(--gap)`; markup that cannot be read
   as tags, such as a bare `<` in a label, is rejected too.
   Markup CoreSVG reads but draws wrongly is rejected as well: attributes on
   `<tspan>`, whose runs all take their `<text>`'s fill, weight and position,
   and markers, which it does not draw. Figures already in a session are drawn
   anyway, so `/resume` still shows them.
2. Replaces `var(--token)` colors with the current theme's colors. The tokens
   are `--fg`, `--muted`, `--dim`, `--border`, `--surface`, `--accent`,
   `--success`, `--warning`, `--error`, and the series colors `--c1` to `--c6`.
   Unless the root sets its own, text and shapes without a fill use `--fg`
   rather than black, which a dark theme hides.
3. Rewrites the font settings CoreSVG ignores: keyword weights become numeric,
   and font lists and generic families become a single installed family. Text
   without a family is Helvetica Neue rather than Times.
4. Rasterizes the SVG to a transparent PNG with the built-in `sips`, which uses
   CoreSVG. Drawing a figure takes about 20 ms.

The agent receives only a one-line confirmation, not the image. Figures are
drawn again from the tool call's arguments, so they follow theme changes and
come back on `/resume`.

## Size

One terminal column spans 8 SVG units, so `font-size="14"` reads at about the
terminal's text size. A figure is shown at that natural width. It is reduced to
fit the pane and 60% of the terminal's height. When it has been reduced, the
expand key (`ctrl+o` by default) shows it at full width, up to 90% of the
height.

The PNG fills whole terminal cells exactly, and the drawing is fitted inside it
without being stretched. Rex answers Pi's startup cell-size query with
placeholder 8×16 cells until a client lays the pane out. The extension asks
again at session start and on every resize, so all inline images, including
those from `read`, use the real cell shape.

## Limits

SVGs are limited to 200,000 characters and a viewBox of at most 4000 units per
side. Canvases are capped at 4096 pixels. Recent rasters are cached in memory,
and temporary files are removed when the session ends.
