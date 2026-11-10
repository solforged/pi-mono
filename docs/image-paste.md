# Pasted images

Pi pastes a clipboard image by saving it as
`$TMPDIR/pi-clipboard-<uuid>.png` and putting that path in the editor. Without
this extension the model receives only the path and spends a turn on `read`
to see the image. The `image-paste` extension attaches the image to the prompt
instead and previews it above the editor.

## Attaching

When you submit a prompt, the extension looks for image paths that stand on
their own: absolute, `~/` or `file://` paths ending in `.png`, `.jpg`,
`.jpeg`, `.gif` or `.webp`, at the start of the prompt or after whitespace.
Quoted paths and backslash-escaped spaces work, as terminals paste them when a
file is dropped. Relative paths are left alone.

A path is attached when the file exists, is at most 20 MB, and its header
shows it is an image. Each image gets a marker:

- A clipboard file's path is replaced by `[Image #1]`, since the temporary path
  means nothing to the model.
- Any other path stays in the prompt and gains the marker, as in
  `~/Desktop/shot.png [Image #1]`, so the model can still work on the file.

A repeated path is attached once. At most eight images are attached per
prompt. Pi then resizes them like other prompt images and notes their original
size. Nothing is attached when the current model does not accept images, for
`!` shell commands, or for messages sent by other extensions.

## Previews

While the editor holds image paths, thumbnails of up to three of them appear
above it, each with its name and pixel size. They need the interactive
terminal UI, a terminal that shows images (Rex, Ghostty, kitty, WezTerm or
iTerm2), and `terminal.showImages` left on. On macOS the built-in `sips`
shrinks each image to a thumbnail first; elsewhere only files up to 1 MB are
previewed.

omp draws these thumbnails inside bordered cards with Kitty Unicode
placeholders. Pi's image renderer places images directly instead, one per
block of lines, so the previews are stacked rather than side by side.

## Transcript

Prompts sent before the extension was installed show a clipboard path as a
short `🖼 pasted image` link to the file. This changes only the display.
