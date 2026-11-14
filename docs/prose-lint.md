# Prose lint

When the agent writes or edits a Markdown file (`.md`, `.mdx`, `.markdown`)
or a React component (`.tsx`, `.jsx`), `extensions/prose-lint` runs
[Vale](https://vale.sh) on the file as it was before the call and as it is
after. In components, the house style reads only the interface text, through
its `UiCopy` view. If the change introduced alerts, a short
note is added to the end of that tool's result:

```text
Vale: this edit added 2 style alerts to docs/sync.md. Revise the prose, or keep a passage that is right as written.
- line 14, Voice.BoldLabels: Bold labels open these lines. Write the point as a plain sentence, or use plain list items.
- line 31, Voice.ChangeNarration: 'now holds' narrates a change. Describe the current behavior; the history belongs in the commit message.
```

Alerts are compared by rule and matched text, not by line, so problems the
file already had are not repeated, and moving text adds nothing. The note
lists at most six alerts.

The note is part of the tool result the model reads next. The system prompt,
the tools and earlier messages stay as they were, so the prompt cache is
unaffected. A clean edit adds nothing, and the extension never adds a turn.

Vale runs from the file's directory with `--path`, so the user's global
configuration and the project's `.vale.ini` apply as they would on the command
line, including path sections such as `[**/README.md]`. The extension reports
warnings and errors whatever the project's `MinAlertLevel`, and leaves out
spelling rules, which report every unknown project name; a project that gates
on spelling runs Vale itself. Without `vale` on `PATH` the extension does
nothing, and a Vale failure, timeout or configuration error adds no note.

The house style and its rules live in the system repository under
`config/vale`; `styles/Voice/Brief.md` there is the written standard.
