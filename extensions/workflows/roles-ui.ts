import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";
import { previewRoles, type RoleDraft, type RoleStore } from "./role-store.ts";
import { roleNames, supportedThinking, type Role, type RoleName, type ThinkingModel } from "./roles.ts";

type Item = { value: string; label: string; description?: string };
type CatalogModel = ThinkingModel & {
  provider: string; id: string; name?: string; maxTokens: number;
};

// One small framed picker, reused for the panel, model search, submenus and /modelpreset.
export async function pick(
  ctx: ExtensionCommandContext,
  title: string,
  items: Item[],
  signal: AbortSignal,
  searchable = false,
): Promise<string | undefined> {
  signal.throwIfAborted();
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    const input = searchable ? new Input() : undefined;
    let query = "";
    let finished = false;
    const finish = (value?: string) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      done(value);
    };
    const abort = () => finish();
    const listTheme = {
      selectedPrefix: (s: string) => theme.fg("accent", s),
      selectedText: (s: string) => theme.fg("accent", s),
      description: (s: string) => theme.fg("muted", s),
      scrollInfo: (s: string) => theme.fg("dim", s),
      noMatch: (s: string) => theme.fg("warning", s),
    };
    const makeList = () => {
      const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const filtered = items.filter((item) => terms.every((term) =>
        `${item.label} ${item.description ?? ""}`.toLowerCase().includes(term),
      ));
      const list = new SelectList(filtered, 12, listTheme);
      list.onSelect = (item) => finish(item.value);
      list.onCancel = () => finish();
      return list;
    };
    let list = makeList();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) queueMicrotask(abort);
    return {
      get focused() { return input?.focused ?? false; },
      set focused(value: boolean) { if (input) input.focused = value; },
      render(width: number) {
        const frame = new Container();
        frame.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        frame.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
        if (input) {
          frame.addChild(new Text(theme.fg("dim", "Search provider or model:"), 1, 0));
          frame.addChild(input);
        }
        frame.addChild(list);
        frame.addChild(new Text(theme.fg("dim", "↑↓ choose · Enter select · Esc back/cancel"), 1, 0));
        frame.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return frame.render(width);
      },
      handleInput(data: string) {
        if (matchesKey(data, "escape")) { finish(); return; }
        if (!input || (["up", "down", "enter"] as const).some((key) => matchesKey(data, key))) {
          list.handleInput(data);
        } else {
          input.handleInput(data);
          if (input.getValue() !== query) { query = input.getValue(); list = makeList(); }
        }
        tui.requestRender();
      },
      invalidate() { input?.invalidate(); list.invalidate(); },
      dispose() { finished = true; signal.removeEventListener("abort", abort); },
    };
  });
}

function describe(role: Role | null): string {
  return role ? `${role.provider}/${role.model} · ${role.thinking}` : "Disabled / not configured";
}

function chooseRole(name: RoleName, model: CatalogModel, previous: Role | null): Role {
  const levels = supportedThinking(model);
  if (!levels.length) throw new Error("This model advertises no supported thinking level");
  const preferred = previous?.thinking ?? (name === "tiny" ? "low" : "medium");
  return {
    provider: model.provider,
    model: model.id,
    thinking: levels.includes(preferred) ? preferred : levels[0],
    maxTokens: Math.min(previous?.maxTokens ?? (name === "tiny" ? 2048 : 8192), model.maxTokens),
    timeoutMs: previous?.timeoutMs ?? (name === "tiny" ? 20000 : name === "task" ? 600000 : 180000),
  };
}

async function editRole(
  ctx: ExtensionCommandContext, draft: RoleDraft, name: RoleName, signal: AbortSignal,
) {
  const title = `${draft.config.profile} · ${name}`;
  while (!signal.aborted) {
    const role = previewRoles(draft).roles[name];
    const action = await pick(ctx, `${title}: ${describe(role)}`, [
      { value: "model", label: "Choose model" },
      ...(role ? [
        { value: "thinking", label: "Thinking level", description: role.thinking },
        { value: "advanced", label: "Advanced limits", description: `${role.maxTokens} output tokens · ${role.timeoutMs / 1000}s timeout` },
      ] : []),
      { value: "disable", label: "Disable", description: "Explicitly disable this role in this profile" },
      { value: "reset", label: "Reset to default", description: "Remove this profile's override; work defaults stay unset" },
      { value: "back", label: "Back to roles" },
    ], signal);
    if (!action || action === "back") return;
    if (action === "disable" || action === "reset") {
      draft.edits[name] = action === "disable" ? null : "reset";
      return;
    }
    if (action === "model") {
      const models = [...await ctx.modelRegistry.getAvailable()].sort((a, b) =>
        `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
      );
      if (!models.length) {
        ctx.ui.notify("No authenticated models available. Configure a provider with /login first.", "warning");
        continue;
      }
      const selected = await pick(ctx, `Choose ${title} model`, models.map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: `${model.provider}/${model.id}`,
        description: model.name,
      })), signal, true);
      if (selected) {
        const model = models.find((m) => `${m.provider}/${m.id}` === selected)!;
        draft.edits[name] = chooseRole(name, model, role);
      }
    } else if (role && action === "thinking") {
      const model = ctx.modelRegistry.find(role.provider, role.model);
      if (!model) { ctx.ui.notify("Model is no longer registered; choose another model.", "warning"); continue; }
      const selected = await pick(ctx, `${title} thinking`, supportedThinking(model).map((level) => ({
        value: level, label: level,
      })), signal);
      if (selected) draft.edits[name] = { ...role, thinking: selected as Role["thinking"] };
    } else if (role && action === "advanced") {
      const field = await pick(ctx, `${title} limits`, [
        { value: "maxTokens", label: "Maximum output tokens", description: String(role.maxTokens) },
        { value: "timeoutMs", label: "Timeout in seconds", description: String(role.timeoutMs / 1000) },
      ], signal);
      if (!field) continue;
      const timeout = field === "timeoutMs";
      const current = timeout ? role.timeoutMs / 1000 : role.maxTokens;
      const value = await ctx.ui.input(timeout ? "Timeout (1–1800 seconds)" : "Output limit (64–32768 tokens)", String(current), { signal });
      signal.throwIfAborted();
      if (value === undefined) continue;
      const number = Number(value);
      if (!Number.isInteger(number) || number < (timeout ? 1 : 64) || number > (timeout ? 1800 : 32768)) {
        ctx.ui.notify("Enter a whole number within the displayed range.", "warning");
        continue;
      }
      draft.edits[name] = { ...role, [field]: timeout ? number * 1000 : number };
    }
  }
}

export async function showRoles(
  ctx: ExtensionCommandContext, store: RoleStore, signal: AbortSignal,
): Promise<boolean> {
  const draft = await store.begin();
  while (!signal.aborted) {
    const config = previewRoles(draft);
    const scope = config.preset === undefined ? config.profile : `${config.profile} · ${config.preset} preset`;
    const action = await pick(ctx, `Model roles · ${scope} · changes apply only on Save`, [
      ...roleNames.map((name) => ({
        value: name,
        label: `${Object.hasOwn(draft.edits, name) ? "* " : ""}${name}`,
        description: describe(config.roles[name]),
      })),
      { value: "save", label: "Save", description: "Use these roles for new tasks; leave running tasks alone" },
      { value: "cancel", label: "Cancel", description: "Discard this panel's edits" },
    ], signal);
    if (!action || action === "cancel") return false;
    try {
      if (action === "save") { await store.save(draft, ctx.modelRegistry, signal); return true; }
      await editRole(ctx, draft, action as RoleName, signal);
    } catch (error) {
      if (signal.aborted) return false;
      ctx.ui.notify(String(error), "error");
    }
  }
  return false;
}
