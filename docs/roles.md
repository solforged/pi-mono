# Model roles

[roles.json](../roles.json) owns the default profile mappings, model IDs,
thinking levels, and limits. Use `/roles show` to inspect effective choices
instead of keeping another configuration snapshot in documentation.

| Role | Purpose |
| --- | --- |
| `advisor` | Design advice and review. |
| `task` | Scout and worker tasks. |
| `commit` | Commit planning. |
| `tiny` | Session titles. |
| `learn` | Session mining and skill review; corresponds to OMP's memory role. |

Pi calls its built-in OpenAI provider `openai`, not OMP's `openai-codex`.
OMP's `auto` effort has no direct Pi equivalent; the checked-in mappings choose
explicit levels.

## Model presets

The `personal` profile has three presets, each a full lineup of the main model
plus the five roles: `openai`, `anthropic`, and `mixed`, which keeps the OpenAI
roles under a Claude Fable main model. They pair models by price tier: GPT-6
Astra with Fable, GPT-6.1 Sol with Sonnet, and Luna with Haiku.

`/modelpreset <name>` checks that every model is registered, authenticated,
and supports its thinking level, then switches the main model, its thinking
level, and the roles for new jobs. Nothing changes if a check fails. Running
jobs keep their models. Without a name it opens a picker, or lists the presets
outside the TUI.

The session records its preset, so resume, fork, and Rex children follow it.
The last choice also starts each new session, unless `--model` or `--provider`
names the main model. Sessions that never chose a preset use the profile's
default (`openai`) roles and Pi's own default main model. The choice is kept in
`<agent-dir>/workflow-state/<profile>/preset.json`.

Add or adjust presets in `roles.local.json` under
`profiles.<profile>.presets.<name>`, with an optional `main`
(`provider`, `model`, `thinking`) and `roles`. `profiles.<profile>.preset` names
the default. Preset roles override the profile's own `roles`, field by field.

## Profiles and local overrides

Profiles separate whole setups, such as `personal` and `work`, including their
workflow state. Select one with `PI_WORKFLOW_PROFILE=work pi`; the default is
`personal`. Sign in through Pi's own `/login`; no credentials are copied or
logins started by this package. Selecting a profile never changes the main
conversation model or falls back to another provider when authentication is
missing.

Pi's built-in Grok provider is `xai`. Any registered provider ID is accepted,
including `grok`, `nous-portal`, and work-internal ones when your own provider
extensions register them. The workflows extension does not implement new
provider protocols or copy credentials. Models must match exact IDs; there are
no provider/model fallbacks.

Put local overrides in `<agent-dir>/roles.local.json`, not this repository.
Only the selected profile is merged. For example, once registered:

```json
{
  "version": 1,
  "profiles": {
    "personal": {
      "presets": {
        "mixed": {
          "roles": {
            "task": { "provider": "nous-portal", "model": "YOUR_MODEL_ID" }
          }
        }
      }
    }
  }
}
```

Overrides merge fields within the same role, preset, and profile. A new preset
needs complete roles (`provider`, `model`, `thinking`, `maxTokens`, `timeoutMs`);
copy one from `roles.json`. `null` disables a role.
`/roles check` checks catalog registration and configured authentication without
making a network request. Manual JSON edits require `/reload`.

## Edit roles in Pi

Run `/roles` in the TUI to open a framed editor for the active profile and
preset. Choose a
role, then search authenticated models by provider/model name. The thinking
menu shows only levels supported by the selected model. Output-token and timeout
limits live under **Advanced limits**.

Changes are drafts until you choose **Save** on the main panel. **Cancel** or
Escape from that panel discards them. Escape inside a submenu returns to the
panel, keeping pending edits. An asterisk marks edited roles.

- **Choose model** overrides the role in the active preset, or the profile
  when it has none.
- **Disable** writes an explicit `null`.
- **Reset to default** removes that role's override. Work defaults remain unset;
  resetting a work role never selects a personal model.

Save writes only overrides to `roles.local.json`, preserves other profiles,
presets, and unrelated settings, and refuses to overwrite files changed while the panel was
open. New jobs use saved choices immediately, without `/reload`; running jobs
and already-dispatched batches keep their original configuration. Saving never
switches the main conversation model. Resource/global limit changes still need
`/reload`.

`/roles show` prints the effective mappings instead of opening the editor.
Outside the TUI, plain `/roles` remains read-only. Provider setup and login stay
separate; registering a provider makes its authenticated models available in the
picker without changing the role UI.

## Work profile

Set `PI_WORKFLOW_PROFILE=work` explicitly. **All five work roles start unset.
They never inherit personal roles.** The main conversation's `/model` remains
your responsibility. Secret-manager or shell profiles do not implicitly choose
a workflow profile.

Use the paths and IDs your provider extension actually registers. Configure
`tiny` and `learn` when desired; leaving them unset disables their calls rather
than using personal providers. Provider extensions must also load normally in
the parent. `subagents.childExtensions` specifies which local extensions to load
explicitly in subprocesses; parent runtime provider registrations do not cross
a process boundary. See [Anthropic subprocess setup](providers.md#anthropic-subprocesses)
for an example.
