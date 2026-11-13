import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { cliChoosesModel, registerPresets } from "../extensions/workflows/presets.ts";
import { RoleStore } from "../extensions/workflows/role-store.ts";
import { branchPreset, loadConfig, presetEntry, rememberedPresetFile } from "../extensions/workflows/roles.ts";
import { saveJson } from "../extensions/workflows/state.ts";
import { registry, root, temporary } from "./helpers.ts";

const models = (missing = "") => ({
  ...registry(),
  find: (provider: string, id: string) => id === missing ? undefined : { provider, id, maxTokens: 128000, reasoning: true },
});

async function harness(t: any, branch: unknown[] = [], argv: string[] = []) {
  const dir = await temporary(t);
  const store = await RoleStore.create(root, dir, "personal");
  const calls = { models: [] as string[], thinking: [] as string[], entries: [] as any[], reports: [] as string[], warnings: [] as string[] };
  const handlers: Record<string, (event: unknown, ctx: any) => Promise<void>> = {};
  let command: any;
  const pi = {
    on: (event: string, fn: any) => { handlers[event] = fn; },
    registerCommand: (_name: string, spec: any) => { command = spec; },
    setModel: async (model: any) => { calls.models.push(`${model.provider}/${model.id}`); return true; },
    setThinkingLevel: (level: string) => { calls.thinking.push(level); },
    appendEntry: (type: string, data: unknown) => { calls.entries.push({ type: "custom", customType: type, data }); },
  } as any;
  registerPresets(pi, store, dir, new AbortController().signal, (_ctx, text) => calls.reports.push(text), argv);
  const ctx = (modelRegistry: any = models()) => ({
    mode: "print", hasUI: false, waitForIdle: async () => {}, modelRegistry,
    ui: { notify: (text: string) => calls.warnings.push(text) },
    sessionManager: { getBranch: () => [...branch, ...calls.entries] },
  });
  return { dir, store, calls, handlers, command, ctx };
}

test("/modelpreset checks the whole lineup, then switches main, roles and the session record", async (t) => {
  const { dir, store, calls, command, ctx } = await harness(t);
  assert.deepEqual(command.getArgumentCompletions("m").map((item: any) => item.value), ["mixed"]);
  const before = store.snapshot();
  await assert.rejects(command.handler("mixed", ctx(models("gpt-6-luna"))), /not registered: openai\/gpt-6-luna/);
  await assert.rejects(command.handler("anthropic", ctx({ ...models(), hasConfiguredAuth: (m: any) => m.provider !== "anthropic" })), /authentication/);
  await assert.rejects(command.handler("nope", ctx()), /Unknown preset nope/);
  assert.deepEqual([calls.models, calls.entries], [[], []], "failed checks change nothing");
  assert.deepEqual(store.snapshot(), before);

  await command.handler("mixed", ctx());
  assert.deepEqual(calls.models, ["anthropic/claude-fable-5-2"]);
  assert.deepEqual(calls.thinking, ["high"]);
  assert.deepEqual(calls.entries.map((e) => e.data), [{ profile: "personal", preset: "mixed" }]);
  assert.equal(store.snapshot().preset, "mixed");
  assert.equal(store.snapshot().roles.task?.model, "gpt-6.1-sol");
  assert.equal(before.preset, "openai", "earlier snapshots are unchanged");
  assert.deepEqual(JSON.parse(await readFile(rememberedPresetFile(dir, "personal"), "utf8")), { preset: "mixed" });
  assert.match(calls.reports.at(-1)!, /main: anthropic\/claude-fable-5-2 \(high\)\nadvisor: openai\/gpt-6-astra/);

  await command.handler("", ctx());
  assert.match(calls.reports.at(-1)!, /^  openai: main gpt-6.1-sol · advisor gpt-6-astra · task gpt-6.1-sol\n  anthropic: .*\n\* mixed: main claude-fable-5-2/);
});

test("fresh sessions start with the remembered preset; older ones keep the profile default", async (t) => {
  const fresh = await harness(t);
  await fresh.handlers.session_start({}, fresh.ctx());
  assert.deepEqual([fresh.calls.models, fresh.calls.entries], [[], []], "nothing remembered: Pi keeps its own default model");

  await saveJson(rememberedPresetFile(fresh.dir, "personal"), { preset: "anthropic" });
  await fresh.handlers.session_start({}, fresh.ctx());
  assert.deepEqual(fresh.calls.models, ["anthropic/claude-opus-5-5"]);
  assert.equal(fresh.store.snapshot().roles.advisor?.model, "claude-fable-5-2");
  assert.equal(branchPreset(fresh.calls.entries, "personal"), "anthropic");

  const old = await harness(t, [{ type: "message", message: { role: "user", content: "hi" } }]);
  await saveJson(rememberedPresetFile(old.dir, "personal"), { preset: "anthropic" });
  await old.handlers.session_start({}, old.ctx());
  assert.deepEqual([old.calls.models, old.store.snapshot().preset], [[], "openai"]);

  const pinned = await harness(t, [{ type: "custom", customType: presetEntry, data: { profile: "personal", preset: "mixed" } }]);
  await pinned.handlers.session_start({}, pinned.ctx());
  assert.deepEqual([pinned.calls.models, pinned.store.snapshot().preset], [[], "mixed"], "resumed sessions keep their own model");

  const stale = await harness(t);
  await saveJson(rememberedPresetFile(stale.dir, "personal"), { preset: "removed" });
  await stale.handlers.session_start({}, { ...stale.ctx(), hasUI: true });
  assert.match(stale.calls.warnings[0], /Unknown preset personal.removed/);
  assert.equal(stale.store.snapshot().preset, "openai");

  assert.ok(cliChoosesModel(["--model", "x"]) && cliChoosesModel(["--provider=openai"]) && cliChoosesModel(["--models", "a,b"]));
  assert.ok(!cliChoosesModel(["-p", "--model-free", "--thinking", "low"]));
});

test("explicit model and thinking flags outrank the remembered preset; its roles still apply", async (t) => {
  for (const [argv, models, thinking] of [
    [["--thinking", "low"], ["anthropic/claude-opus-5-5"], []],
    [["--models", "sonnet,haiku"], [], []],
    [["--model=sonnet:high"], [], []],
    [[], ["anthropic/claude-opus-5-5"], ["high"]],
  ] as const) {
    const fresh = await harness(t, [], [...argv]);
    await saveJson(rememberedPresetFile(fresh.dir, "personal"), { preset: "anthropic" });
    await fresh.handlers.session_start({}, fresh.ctx());
    assert.deepEqual([fresh.calls.models, fresh.calls.thinking], [models, thinking], argv.join(" "));
    assert.equal(fresh.store.snapshot().preset, "anthropic");
  }
  const explicit = await harness(t, [], ["--thinking", "low"]);
  await explicit.command.handler("anthropic", explicit.ctx());
  assert.deepEqual(explicit.calls.thinking, ["high"], "/modelpreset is the explicit switch and sets the preset's level");
});

test("Rex and other branch readers resolve the session's preset", async (t) => {
  const dir = await temporary(t);
  const entry = (preset: string, profile = "personal") => ({ type: "custom", customType: presetEntry, data: { profile, preset } });
  assert.equal(branchPreset([entry("mixed"), entry("anthropic"), entry("openai", "work")], "personal"), "anthropic");
  assert.equal((await loadConfig(root, dir, [entry("anthropic")])).roles.task?.model, "claude-sonnet-5-5");
  assert.equal((await loadConfig(root, dir)).preset, "openai");
});
