# Tool frames

`extensions/tool-frames` redraws Pi's built-in tool rows according to what
each call did, and drops the full-width coloured blocks. Only the renderers
change. Execution, results and what the model sees stay the same. Rows from
other tools (MCP, extension tools) keep their own look.

```text
● read src/app.ts:1-30                                               27 lines

● grep /startServer/ in src                                  3 hits · 2 files

╭─ ✎ edit ×2 src/app.ts ─────────────────────────────────────────── +3 −2 ─╮
│ - 4 const PORT = 8080;                                                   │
│ + 4 const PORT = Number(process.env.PORT ?? 8080);                       │
│    ⋯                                                                     │
│ -16     await sleep(100);                                                │
│ +16     await sleep(100 * 2 ** attempt);                                 │
╰──────────────────────────────────────────────────────────────────────────╯

╭─ $ npm test ───────────────────────────────────────────── exit 1 · 6.8s ─╮
│ not ok - retries stop after RETRIES                                      │
╰──────────────────────────────────────────────────────────────────────────╯
```

- **Lookups** (`read`, `grep`, `find`, `ls`) take one line, with the outcome
  on the right: lines read, hits and files, or entries. Their output appears
  under the line when expanded, and errors always do.
- **Edits** are framed with the path in the top rule and `+/−` counts on the
  right. A collapsed edit shows its changed lines with one line of context
  each. Expanding shows Pi's full diff.
- **Writes** show the first lines of the file and say whether it is `new` or
  `rewrote` an existing one.
- **Commands** show the first line of the command in the top rule, with a
  leading `cd` into the working directory dropped. Further command lines
  (heredocs and the like) are cut to two, the output to its last five lines.
  The rule shows `running` with the elapsed time, then `✓`, `exit N`,
  `timed out` or `aborted`. A failed command gets an error-coloured frame.

Ctrl+O (`app.tools.expand`) expands every row, as before. Paths are shown
relative to the working directory and are clickable where the terminal
supports hyperlinks. Each row keeps Pi's blank line above it.

To find out whether a write created its file, the extension checks before
the call and stores `created` in the result's `details`. The model never
sees `details`.

In HTML exports Pi draws `read`, `edit`, `write`, `bash` and `ls` with its own
templates; `grep` and `find` use these rows.

## Trying it without a model

`tests/fixtures/tool-frames-provider.ts` is a scripted model that calls each
tool. Run it from an empty scratch directory, where it creates a small `src/`
to work on:

```sh
cd "$(mktemp -d)"
pi --offline --no-session --tools read,bash,edit,write,grep,find,ls \
  -e ~/src/pi-mono/extensions/tool-frames/index.ts \
  -e ~/src/pi-mono/tests/fixtures/tool-frames-provider.ts \
  --provider tool-frames-demo --model tool-frames-demo/fixture "Go"
```

Set `TOOL_FRAMES_STEPS=1,4` to play only some of its steps.
