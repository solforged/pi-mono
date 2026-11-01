# Learning and approval

`/learn` is a normal turn of the conversation model: describe a flow, a path, or
a URL, and it writes a managed `SKILL.md`. `/reload` afterwards so it is
discovered. That path does not use drafts.

`/learn-sessions` and `/curate-skills` use the configured `learn` role with no
tools. They only stage drafts. `/learn-review` is the publication gate: inspect
the exact diff, then approve or dismiss. Nothing those two commands propose is
active until that happens.

## Evidence and review limits

Session mining uses original messages and tool results on the selected branch,
not just compaction summaries. Images and private thinking are excluded. The
review model sees session evidence and full loaded skill contents as data.
Session/entry references accompany proposals. Treat transcripts as sensitive:
this sends selected evidence to the configured `learn` provider.

Review is bounded to six chunks per invocation. Large entries have fragment
checkpoints; rerunning continues unreviewed material. Fully read skill inventory
must also fit the configured input budget; the command reports an error rather
than silently omit skills when it does not. No model runs on exit or in the
background to learn skills.

## Approval and ownership

Drafts live outside discovery paths. `/learn-review` shows the complete proposed
patch in the editor. Submit it unchanged to continue, then approve the exact
change in a separate confirmation. Escape keeps it pending. Preview edits are
not applied; to revise a proposal, edit its private draft JSON and review again.
Publication rejects stale snapshots, path traversal and symlink destinations.
Non-interactive calls cannot activate skills.

Only skills owned by this workflow can be updated/deleted. Authored/project
skills are comparison material, never mutation targets. Facts destined for the
wiki remain note suggestions; record them in their existing owning notes, then
dismiss the proposal. Automatic wiki mutation is deliberately not implemented.

See [model roles](roles.md) for provider selection and
[private state and usage](workflows.md#private-state-and-usage) for drafts,
review checkpoints, and published skills.
