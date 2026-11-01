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

## Profiles and local overrides

Select a profile with `PI_WORKFLOW_PROFILE=anthropic pi`. Sign in through Pi's
own `/login`; no credentials are copied or logins started by this package.
Selecting a profile never changes the main conversation model or falls back to
another provider when authentication is missing.

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
      "roles": {
        "task": { "provider": "nous-portal", "model": "YOUR_MODEL_ID" }
      }
    }
  }
}
```

Overrides merge fields within the same role and profile. `null` disables a role.
`/roles check` checks catalog registration and configured authentication without
making a network request. Manual JSON edits require `/reload`.

## Edit roles in Pi

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
