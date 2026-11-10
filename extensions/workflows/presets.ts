import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RoleStore } from "./role-store.ts";
import {
  branchPreset, checkLineup, presetEntry, rememberedPreset, rememberedPresetFile, roleNames,
  type Config, type MainModel,
} from "./roles.ts";
import { saveJson } from "./state.ts";

type Report = (ctx: ExtensionContext, text: string) => void;
type Ref = { provider: string; model: string; thinking: string } | null;

const ref = (r: Ref) => r ? `${r.provider}/${r.model} (${r.thinking})` : "not configured";
export const describeLineup = (config: Config) => [
  `main: ${config.main ? ref(config.main) : "unchanged"}`,
  ...roleNames.map((name) => `${name}: ${ref(config.roles[name])}`),
];
const summary = (config: Config) => [["main", config.main], ["advisor", config.roles.advisor], ["task", config.roles.task]]
  .map(([label, r]) => `${label} ${(r as Ref)?.model ?? "-"}`).join(" · ");

/** Explicit --model/--provider flags keep their main model in a fresh session. */
export const cliChoosesModel = (argv = process.argv.slice(2)) => argv.some((arg) => /^--(model|provider)(=|$)/.test(arg));

// A session records its preset as a branch entry, so resume, fork and Rex (which reads
// the branch) agree. Only an explicit /modelpreset, or a fresh session starting with the
// remembered choice, changes the main model; role edits and profiles never do.
export function registerPresets(pi: ExtensionAPI, store: RoleStore, agentDir: string, signal: AbortSignal, report: Report) {
  async function setMain(ctx: ExtensionContext, main: MainModel) {
    const model = ctx.modelRegistry.find(main.provider, main.model);
    if (!model) throw new Error(`Model not registered: ${main.provider}/${main.model}`);
    if (!await pi.setModel(model)) throw new Error(`No configured authentication: ${main.provider}/${main.model}`);
    pi.setThinkingLevel(main.thinking);
  }
  function warn(ctx: ExtensionContext, text: string) {
    if (ctx.hasUI) ctx.ui.notify(text, "warning"); else console.error(text);
  }
  async function follow(ctx: ExtensionContext) {
    const current = store.snapshot();
    if (!current.presets.length) return;
    const branch = ctx.sessionManager.getBranch();
    const pinned = branchPreset(branch, current.profile);
    if (pinned !== undefined) {
      if (pinned !== current.preset) store.adopt(await store.lineup(pinned));
      return;
    }
    // Sessions that predate presets, or never chose one, keep the profile default.
    if (branch.some((entry: any) => entry.type === "message")) {
      const fallback = await store.lineup();
      if (fallback.preset !== current.preset) store.adopt(fallback);
      return;
    }
    const remembered = await rememberedPreset(agentDir, current.profile);
    if (remembered === undefined) return;
    const next = await store.lineup(remembered);
    if (next.main && !cliChoosesModel()) {
      try { await setMain(ctx, next.main); }
      catch (error) { warn(ctx, `Model preset ${remembered}: kept the current main model. ${(error as Error).message}`); }
    }
    store.adopt(next);
    pi.appendEntry(presetEntry, { profile: next.profile, preset: remembered });
  }
  for (const event of ["session_start", "session_tree"] as const) {
    pi.on(event, async (_event, ctx) => {
      try { await follow(ctx); }
      catch (error) { warn(ctx, `Model preset: ${(error as Error).message}`); }
    });
  }

  pi.registerCommand("modelpreset", {
    description: "Switch the main model and roles to a preset: /modelpreset [name]",
    getArgumentCompletions: (prefix: string) => {
      const names = store.snapshot().presets.filter((name) => name.startsWith(prefix.trim()));
      return names.length ? names.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const current = store.snapshot();
      if (!current.presets.length) throw new Error(`Profile ${current.profile} has no model presets; see docs/roles.md`);
      let name = args.trim();
      if (!name) {
        const lineups = await Promise.all(current.presets.map((preset) => store.lineup(preset)));
        if (ctx.mode !== "tui") {
          report(ctx, lineups.map((c) => `${c.preset === current.preset ? "* " : "  "}${c.preset}: ${summary(c)}`).join("\n"));
          return;
        }
        // Loaded on demand: the TUI picker needs Pi runtime packages that tests and print mode do not.
        const { pick } = await import("./roles-ui.ts");
        name = await pick(ctx, `Model preset · ${current.profile}`, lineups.map((c) => ({
          value: c.preset!, label: `${c.preset}${c.preset === current.preset ? " (current)" : ""}`, description: summary(c),
        })), signal) ?? "";
        if (!name) return;
      }
      if (!current.presets.includes(name)) throw new Error(`Unknown preset ${name}; choose ${current.presets.join(", ")}`);
      await ctx.waitForIdle(); signal.throwIfAborted();
      // Check everything before changing anything: no partial switches and no fallbacks.
      const next = await store.lineup(name);
      checkLineup(next, ctx.modelRegistry);
      if (next.main) await setMain(ctx, next.main);
      store.adopt(next);
      pi.appendEntry(presetEntry, { profile: next.profile, preset: name });
      let remembered = "New sessions start with it.";
      try { await saveJson(rememberedPresetFile(agentDir, next.profile), { preset: name }); }
      catch (error) { remembered = `Could not remember it for new sessions: ${(error as Error).message}`; }
      report(ctx, [`Model preset: ${name} (${next.profile})`, ...describeLineup(next),
        `New tasks use these roles; running tasks keep theirs. ${remembered}`].join("\n"));
    },
  });
}
