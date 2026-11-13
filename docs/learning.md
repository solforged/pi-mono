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
review model sees session evidence and the skill inventory as data: managed
skills in full, since only they can change, and other loaded skills by name and
description. A skill directory whose name is not a lowercase, hyphenated slug
counts as one of the others. Session/entry references accompany proposals. Treat transcripts as sensitive:
this sends selected evidence to the configured `learn` provider.

Review is bounded to six chunks per invocation. Large entries have fragment
checkpoints; rerunning continues unreviewed material. Managed skills must fit
`learning.maxInputChars`; the command reports an error rather than silently
omit one when they do not. Apart from autolearn, below, no model runs on exit
or in the background to learn skills.

## Autolearn

`/autolearn on` lets the `learn` role propose from repetition, for this project
only. It is off by default (`learning.auto.enabled`), adds no tools or prompt
text, and stages drafts like the commands above.

After each finished task (the work since the previous one ended), a local
check with no model call reduces it to its distinctive steps. Read-only commands,
edits, delegation, and basic Git are ignored, and so are steps found in over
half the project's sessions. The review runs only when:

- the same steps, at least one in order, recur in `minSessions` sessions (3)
  and are not all named in the loaded project instructions;
- the task ended cleanly and was not handled without errors by a skill;
- the pattern was not already reviewed, or has since recurred in twice as many
  sessions; no proposal is pending; and no other review is running.

The review sees one run per session and the skill inventory. If managed skills
exceed the input budget, it warns and leaves the pattern unreviewed, so raising
the limit lets it run. A provider outage (5xx, rate limit, timeout) also leaves
it unreviewed, for up to three tries a session. It is asked to prefer nothing, then `automate`
(deterministic tooling such as a script or task), then a skill update, and only
then a new skill. New skills are refused once `maxSkills`
(12) managed skills exist. A proposal raises one notification. In
`/learn-review`, an `automate` proposal can be handed to the agent to build
instead of being published. Selected transcripts go to the `learn` provider
without a command, so enable it only where that is acceptable.

`/autolearn dry-run` lists the patterns recurring now, with whether each would
be reviewed or why not. It makes no model call and saves nothing.

New skills from any learning path use gerund names, such as `processing-pdfs`,
following Anthropic's [skill authoring guidance](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).

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
