# Pi extensions

Locally owned extensions for pi. No third-party extension
packages or additional npm dependencies. Uses pi's bundled APIs and Node
built-ins. The main conversation model is never switched by these extensions.

## Install

Sources live in this repository. Deployment is declared in
`~/src/dotfiles/cli/mise/mise.toml`. Apply only these targets:

```sh
mise bootstrap dotfiles apply --yes \
  ~/.pi/agent/extensions/workflows \
  ~/.pi/agent/extensions/web-search \
  ~/.pi/agent/extensions/snapcompact \
  ~/.pi/agent/roles.json
```

Then `/reload` in pi. Existing `settings.json`, credentials, AGENTS.md, and
Gondolin are not replaced. To try without deployment:

```sh
pi -e ./extensions/workflows/index.ts
pi -e ./extensions/web-search/index.ts
pi -e ./extensions/snapcompact/index.ts
```

## Model roles

`roles.json` supplies personal defaults:

| Role      | Provider/model              | Thinking |
| --------- | --------------------------- | -------- |
| `advisor` | `openai-codex/gpt-6-astra`  | high     |
| `task`    | `xai/grok-4.6`              | medium   |
| `tiny`    | `openai-codex/gpt-5.6-luna` | low      |
| `learn`   | `openai-codex/gpt-5.6-sol`  | medium   |

Pi's built-in Grok provider is `xai`. Any registered provider ID is accepted,
including `grok`, `nous-portal`, and work-internal ones when your
own provider extensions register them. This extension does not implement new
provider protocols or copy credentials. Models must match exact IDs; there are
no provider/model fallbacks.

Put local overrides in `~/.pi/agent/roles.local.json`, not this repository. Only
the selected profile is merged. For example, once registered:

```json
{
  "version": 1,
  "profiles": {
    "personal": {
      "roles": {
        "task": { "provider": "nous-portal", "model": "YOUR_MODEL_ID" }
      }
    }
  }
}
```

Overrides merge fields within the same role and profile. `null` disables a role.
`/roles check` checks catalog registration and configured authentication without
making a network request. Manual JSON edits still require `/reload`.

### Edit roles in pi

Run `/roles` in the TUI to open a framed editor for the active profile. Choose a
role, then search authenticated models by provider/model name. The thinking
menu shows only levels supported by the selected model. Output-token and timeout
limits live under **Advanced limits**.

Changes are drafts until you choose **Save** on the main panel. **Cancel** or
Escape from that panel discards them. Escape inside a submenu returns to the
panel, keeping pending edits. An asterisk marks edited roles.

- **Choose model** overrides the role in the active profile.
- **Disable** writes an explicit `null`.
- **Reset to default** removes that role's override. Work defaults remain unset;
  resetting a work role never selects a personal model.

Save writes only overrides to `roles.local.json`, preserves other profiles and
unrelated settings, and refuses to overwrite files changed while the panel was
open. New jobs use saved choices immediately, without `/reload`; running jobs
and already-dispatched batches keep their original configuration. Saving never
switches the main conversation model. Resource/global limit changes still need
`/reload`.

`/roles show` prints the effective mappings instead of opening the editor.
Outside the TUI, plain `/roles` remains read-only. Provider setup and login stay
separate; registering a provider makes its authenticated models available in the
picker without changing the role UI.

### Work profile

Set `PI_WORKFLOW_PROFILE=work`, or launch with `FNOX_PROFILE=work` (already set
by the Atlas mise profile). An explicit `PI_WORKFLOW_PROFILE` takes precedence.
**All four work roles start unset. They never inherit personal roles.** The main
conversation's `/model` remains your responsibility.

Replace the example path and IDs with those your provider extension actually
registers. Configure `tiny` and `learn` the same way when desired; leaving them
unset disables their calls rather than using personal providers. Provider
extensions must also load normally in the parent. `childExtensions` specifies
which local extensions to load explicitly in subprocesses; parent runtime
provider registrations do not cross a process boundary.

## Commands

| Command                                     | Behavior                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `/roles [show\|check]`                      | Edit roles in the TUI, print mappings, or check registration/auth         |
| `/autoname`                                 | Generate another title; confirm before replacing an existing name        |
| `/commit [replan\|show\|clear]`              | Split the working tree into logical commits; cache the plan on failure   |
| `/advisor <task>`                           | Ask the advisor, including a bounded recent-conversation excerpt         |
| `/subagent <advisor\|scout\|worker> <task>` | Run a named agent with a bounded context excerpt                         |
| `/learn [flow]`                             | Current model authors a managed skill from a described flow              |
| `/learn-sessions`                           | Pick sessions to mine; current session starts checked                    |
| `/learn-review`                             | Inspect, approve, or dismiss a queued proposal                           |
| `/curate-skills`                            | Audit changed, workflow-managed skills; repeat to process the next batch |
| `/workflows`                                | Show private state location and auxiliary usage                          |
| `/snapcompact`                              | Show whether this model archives compacted history as images             |

Automatic naming runs after the first substantive exchange settles in the TUI.
It uses `TITLE_SYSTEM.md`, never overwrites a manual title, and makes at most
one automatic attempt per session. Failures leave the session usable;
`/autoname` retries explicitly. Naming does not run automatically inside
subprocesses.

## Commits

`/commit` asks the `task` role to group the current working tree into file-level
commits, then creates them on the host so gitleaks and the commit-message policy
still run. It does not split hunks inside a file. The TUI confirms the plan;
print mode applies it. The plan is stored under `commits/plan.json` and reused
when the remaining files are unchanged, so a hook failure can be fixed and
retried without another model call. `/commit replan` discards the cache,
`/commit show` prints it, and `/commit clear` deletes it.

## Subagents

The model-callable `subagent` tool accepts `tasks`, an array of objects with
`agent`, `task`, and optional selected `context`:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find the authentication entry points" },
    { "agent": "advisor", "task": "Review the retry design", "context": "..." }
  ]
}
```

Advisor/scout have `read`, `grep`, `find`, and `ls`, not Bash. Workers also get
Bash, edit, and write. Each child gets approved context-file instructions and
its authored definition from `agent-definitions/`; it does not inherit the whole
conversation or discover project resources. Recursive delegation is not allowed.
Three children may run concurrently across tool calls; six tasks per batch,
sixteen turns per child, and per-role output/time limits are defaults.

A worker always gets a detached worktree from a clean repository's HEAD. Dirty
inputs are rejected rather than silently omitted. Worktrees and results remain
for review, including on failure; nothing is committed or integrated
automatically. Inspect and integrate deliberately, for example:

```sh
git -C /path/to/retained/worktree diff
# Inspect untracked files too; git diff alone does not include them.
git -C /path/to/retained/worktree status --short
# After integration and preserving anything you need:
git worktree remove /path/to/retained/worktree
```

Git administration belongs to the parent. Gondolin mounts the worktree at
`/workspace`; its external Git administrative files may not be accessible in the
VM. Ordinary code editing/testing still works, but Git-dependent builds may need
additional sandbox configuration.

### Sandbox and cancellation

The runner inherits explicit extension paths that override the requested parent
tools. With the existing Gondolin extension loaded, each child loads that same
extension. Gondolin is opt-in (`/gondolin on` or `pi --gondolin`); an idle
parent produces idle children. It never silently drops those wrappers because
extension discovery is disabled. Inline/SDK tool overrides that cannot be
reproduced from a file cause dispatch to fail.

`subagents.sandbox: "required"` refuses dispatch unless the parent has a
file-backed tool-routing extension. This checks routing, not the security
properties of arbitrary extensions. An unwrapped parent with the default
`"inherit"` policy produces unwrapped children. Worktrees, read-only tool
allowlists, and separate processes are not security sandboxes.

Press Escape to cancel a command's loader or the active tool run. Children get
SIGTERM, followed by process-group SIGKILL if needed. Reload/session replacement
also cancels child work. Provider requests and review commands have deadlines.
No automatic cross-provider retry or fallback is permitted.

## Learning and approval

`/learn` is a normal turn of the conversation model: describe a flow, a path, or
a URL, and it writes a managed `SKILL.md`. `/reload` afterwards so it is
discovered. That path does not use drafts.

`/learn-sessions` and `/curate-skills` use the configured `learn` role with no
tools. They only stage drafts. `/learn-review` is the publication gate: inspect
the exact diff, then approve or dismiss. Nothing those two commands propose is
active until that happens.

Session mining uses original messages and tool results on the selected
branch, not just compaction summaries. Images and private thinking are
excluded. The review model sees session evidence and full loaded skill
contents as data. Session/entry references accompany proposals. Treat
transcripts as sensitive: this sends selected evidence to the configured
`learn` provider.

Review is bounded to six chunks per invocation. Large entries have fragment
checkpoints; rerunning continues unreviewed material. Fully read skill inventory
must also fit the configured input budget; the command reports an error rather
than silently omit skills when it does not. No model runs on exit or in the
background to learn skills.

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

State lives under `~/.pi/agent/workflow-state/<profile>/<cwd-hash>/`:

- `drafts/`: pending, applied, and dismissed proposals.
- `commits/plan.json`: cached `/commit` groups for this working tree.
- `skills/`: approved skills, discovered only for this exact profile and working
  directory, including after `/reload`.
- `reviewed.json`: reviewed entry/fragment IDs and curated skill hashes.
- `runs/`: child instructions, metadata, and JSONL transcripts; text returned to
  the parent is capped, full results remain here (32 MiB per run maximum).
- `worktrees/`: retained worker checkouts.

Directories/files created here are private (0700/0600). State is not committed
or automatically pruned. A crashed review, publisher, or commit can leave a
`.lock` directory: inspect its `owner.json`, confirm that process is gone, then
remove only that stale lock. Do not remove active worktree directories by hand.

Subagent tool usage is reported in pi's normal totals. Titles, learning calls,
and command-invoked subagents are tracked separately by `/workflows`. Costs use
provider catalog prices and may be zero when prices are unavailable.

## Web search

Pi has no built-in web search. This extension registers a `web_search` tool
that copies OMP's nested-backend approach rather than injecting hosted search
into the live turn. The current model calls the tool; the extension prefers
the live Grok or Codex backend, then walks the rest of the chain.

| Backend | Auth | Nested call |
| ------- | ---- | ----------- |
| Codex   | `openai-codex` OAuth | ChatGPT `/codex/responses` with hosted `web_search` |
| xAI     | `xai` OAuth or API key | `https://api.x.ai/v1/responses` as `grok-4.6` (then `grok-4.5`) |
| Exa     | `EXA_API_KEY` | `https://api.exa.ai/search` |

A Grok session tries xAI first (current model, then `grok-4.6` / `grok-4.5`).
A Codex session tries Codex first (current model, then Luna/Terra/Sol/Astra).
Other parents keep Codex then xAI then Exa. Unavailable backends are skipped.
`/web-search` prints the session-aware order; `/web-search <query>` runs it.
`PI_CODEX_WEB_SEARCH_MODEL` and `PI_XAI_WEB_SEARCH_MODEL` pin a nested model.

This is not in-session search. Pi's Responses parser ignores `web_search_call`
items, so injecting hosted search into the live payload would drop citations
and replay. Nested calls reuse the existing logins and work for any parent
model, including later Nous Portal sessions.

## Snapcompact

Pi's default compaction asks the current model to summarize discarded
history. For vision-capable models this extension instead archives that
history as dense PNG frames of 8x13 pixel text, the same idea as
oh-my-pi's snapcompact, implemented with Node built-ins and a vendored
public-domain font. Text-only models keep the default LLM summary.
`/compact` with extra instructions also keeps the default summarizer.

`/snapcompact` shows whether the current model will use it and the size
of the last archive on this branch. Frames are stored on the compaction
entry and re-attached on every LLM request.

## Checks

```sh
mise run test
# Or from dotfiles: mise run pi:test
# Or directly, with Node 26:
node --test tests/*.test.ts
```

The small regression suite makes no model calls and requires Git for the
worktree check. For a loader/auth-configuration smoke check without starting
Gondolin or making model requests:

```sh
pi --offline --no-extensions --no-skills --no-context-files \
  --no-prompt-templates --no-session \
  -e ./extensions/workflows/index.ts -p '/roles check'
pi --offline --no-extensions --no-skills --no-context-files \
  --no-prompt-templates --no-session \
  -e ./extensions/web-search/index.ts -p '/web-search check'
pi --offline --no-extensions --no-skills --no-context-files \
  --no-prompt-templates --no-session \
  -e ./extensions/snapcompact/index.ts -p '/snapcompact'
```

The installed pi documentation and shipped `session-name.ts`, `summarize.ts`,
and `subagent/` examples are the API references. No upstream extension code is
auto-downloaded or updated by this implementation.
