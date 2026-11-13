# Deferred tools

Situational tools are registered with `exposure: "deferred"`. Their
declarations stay out of requests until Pi's built-in `tool_search` loads them;
after that they stay declared on that branch. This keeps the base prompt small
as tools are added.

Deferred now: `session_search` and `session_read` (group `sessions`),
`intercom`, and `eval` and `wait` (group `workflowz`, also declared by the
[workflowz keyword](workflowz.md)). An arriving intercom note declares `intercom` straight away, since
it asks for any answer to go through that tool. `figure` stays direct: models
draw diagrams with bash rather than search for a tool to do it (see below).

## The deferred-tools extension

- Turns `tool_search` on when deferred extension tools are registered. It does
  this once per branch, so turning it off with `/tools` sticks. A tool selection
  on the command line (`--tools`, `--no-tools`, `--no-builtin-tools`) is left
  as it is, which also covers Rex and workflow children.
- Lists the deferred groups in a `deferred_tools` prompt section while
  `tool_search` is active, one line per namespace. The list does not change as
  groups are loaded, so the section changes only when the deferred tools do.
  MCP tools are left out because Pi lists their servers itself.

## Defer a new tool

```ts
pi.registerTool({
  name: "jira_issue_get",
  exposure: "deferred",
  namespace: { name: "jira", description: "Jira issue tracker: read, search, create and comment on tickets" },
  // ...
});
```

The namespace description is the line in the prompt section and is also
searched, so it should use the words a model would search with. `tool_search`
ranks with BM25 over names, descriptions and namespaces, and loads about four
tools per search. Promote a tool to direct if most sessions end up loading it,
or if models should use it without being asked to, as with `figure`.

## Measured

`mise run deferred-tools:eval` runs 13 one-turn tasks against 29 mock tools in
12 groups (Jira, Slack, calendar, Datadog, staging DB, PagerDuty, email,
diagrams, past sessions, ...). Some tasks name the system ("Jira ticket
PLAT-4821"), some don't ("who's on the hook for production pages tonight?"),
some need a tool partway through a coding task, and two need no extra tool. A
run passes when the expected mock tool ran and the reply or files use what it
returned. There are three arms: `deferred` (only `tool_search`), `index` (the
same, plus this extension) and `direct` (all 29 tools declared up front).

Results from 2026-11-10, three runs per task. Each cell is how often the
expected tool was found, over the 33 runs that needed one:

| Model | deferred | index | direct |
|---|---|---|---|
| claude-opus-5-5 | 33/33 | 33/33 | 33/33 |
| claude-sonnet-5-5 | 32/33 | 33/33 | 33/33 |
| claude-haiku-5-5 | 18/33 | 30/33 | 33/33 |
| gpt-6.1-sol | 33/33 | 33/33 | 33/33 |
| gpt-6-astra | 33/33 | 33/33 | 33/33 |
| gpt-6-luna | 21/33 | 33/33 | 33/33 |

- Searching works: 3 of 433 searches found nothing, and the first search held
  the needed tool in 95% of runs.
- Small models miss tools by not searching. When a prompt doesn't name the
  system, they grep the repository and give up. The prompt list fixes most of
  this.
- The remaining misses are the diagram task, where haiku (and sometimes
  sonnet) drew the PNG with Python or Swift instead of looking for a tool.
- No control run searched.
- Compared with declaring everything, a run cost about 20% more and took 3–5 s
  longer, because of the extra search step. Deferring pays when a session
  needs few of the catalog's tools.

claude-fable-5-2 could not be measured: Anthropic rejected it with
`claude_code_version_too_old`. The runs were single turns in fresh sessions
without context files. They don't show behavior deep into long sessions or the
effect on the prompt cache.

## Rerun

```sh
mise run deferred-tools:eval -- --budget 5
mise run deferred-tools:eval -- --models openai/gpt-6-luna:medium --arms deferred,index --runs 3
mise run deferred-tools:eval -- --report /path/to/results
```

It costs money: every run is a real session. Models default to every main and
role model of the presets in `roles.json`, at their thinking levels. A full
pass of 7 models × 3 arms × 13 tasks costs about $4. Runs load only the mock
catalog, `tool_search` and, in the index arm, this extension. Bash and file
tools are confined to a scratch directory: no installs, network or home
directory. Rerunning with the same `--out` continues where it stopped.
Models whose provider refuses every turn are reported separately and not
scored. Scenario and tasks are in `scripts/deferred-tools-tasks.ts`.
