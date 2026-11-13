import assert from "node:assert/strict";
import test from "node:test";
import { profileName, resolveConfig, resolveRole, roleNames } from "../extensions/workflows/roles.ts";
import { completeRole } from "../extensions/workflows/requests.ts";
import { base, config, registry, root, temporary } from "./helpers.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RoleStore, previewRoles } from "../extensions/workflows/role-store.ts";
import { supportedThinking } from "../extensions/workflows/roles.ts";
import { saveJson } from "../extensions/workflows/state.ts";

test("personal roles default to the OpenAI preset; Anthropic is a preset; work stays unset", () => {
  assert.equal(profileName({}), "personal");
  assert.equal(profileName({ FNOX_PROFILE: "work" }), "personal");
  assert.equal(config.preset, "openai");
  assert.deepEqual(config.presets, ["openai", "anthropic", "mixed"]);
  assert.equal(config.roles.task?.model, "gpt-6.1-sol");
  assert.equal(config.roles.commit?.model, "gpt-6-luna");
  assert.equal(config.roles.learn?.model, "gpt-6-luna");
  const anthropic = resolveConfig(base, {}, "personal", [], "anthropic");
  assert.equal(anthropic.roles.advisor?.model, "claude-fable-5-2");
  assert.equal(anthropic.roles.task?.model, "claude-sonnet-5-5");
  assert.equal(anthropic.roles.commit?.model, "claude-haiku-5-5");
  assert.equal(anthropic.roles.learn?.model, "claude-haiku-5-5");
  assert.equal(anthropic.roles.commit?.thinking, config.roles.commit?.thinking);
  assert.throws(() => resolveConfig(base, {}, "anthropic"), /now a personal preset/);
  const work = resolveConfig(base, {}, "work");
  assert.deepEqual([work.presets, work.preset, work.main], [[], undefined, null]);
  for (const name of roleNames) {
    assert.equal(config.roles[name]?.provider, "openai");
    assert.equal(anthropic.roles[name]?.provider, "anthropic");
    assert.equal(work.roles[name], null);
    assert.throws(() => resolveRole(work, name, registry() as any), /no fallback/);
  }
});
test("presets layer over the profile and name their own main model", () => {
  const mixed = resolveConfig(base, {}, "personal", [], "mixed");
  assert.deepEqual(mixed.main, { provider: "anthropic", model: "claude-fable-5-2", thinking: "high" });
  assert.deepEqual(mixed.roles, config.roles);
  const local = { profiles: { personal: {
    roles: { tiny: { ...config.roles.tiny, model: "profile-wide" }, commit: { ...config.roles.commit, model: "profile-wide" } },
    presets: { mixed: { roles: { commit: { model: "preset-only" } }, main: { thinking: "max" } }, extra: { roles: { task: null } } },
  } } };
  const custom = resolveConfig(base, local, "personal", [], "mixed");
  assert.equal(custom.roles.commit?.model, "preset-only");
  assert.equal(custom.roles.tiny?.model, "gpt-6-luna", "a preset's own roles override profile-wide ones");
  assert.equal(custom.main?.thinking, "max");
  assert.deepEqual(resolveConfig(base, local, "personal").presets, ["openai", "anthropic", "mixed", "extra"]);
  const extra = resolveConfig(base, local, "personal", [], "extra");
  assert.deepEqual([extra.roles.task, extra.roles.tiny?.model, extra.roles.advisor, extra.main], [null, "profile-wide", null, null]);
  assert.throws(() => resolveConfig(base, {}, "personal", [], "missing"), /Unknown preset personal.missing/);
  assert.throws(() => resolveConfig(base, { profiles: { work: { presets: { a: {} } } } }, "work"), /default preset/);
  assert.throws(() => resolveConfig(base, { profiles: { personal: { presets: { Bad: {} } } } }, "personal"), /Invalid preset name/);
  assert.throws(() => resolveConfig(base, { profiles: { personal: { presets: { mixed: { main: { model: "a b" } } } } } }, "personal", [], "mixed"), /main.model/);
});
test("arbitrary registered provider IDs and slash-containing model IDs work", () => {
  for (const provider of ["nous-portal", "grok"]) {
    const custom = resolveConfig(base, { profiles: { work: { roles: { advisor: { ...config.roles.advisor, provider, model: "org/model:id" } } } } }, "work");
    assert.equal(resolveRole(custom, "advisor", registry() as any).model.provider, provider);
    assert.equal(custom.roles.task, null);
  }
});
test("unavailable roles fail without a fallback or model mutation", async () => {
  assert.throws(() => resolveRole(config, "tiny", { find: () => undefined } as any), /not registered/);
  assert.throws(() => resolveRole(config, "tiny", { ...registry(), hasConfiguredAuth: () => false } as any), /authentication/);
  assert.throws(() => resolveConfig(base, { subagents: { concurrency: 0 } }, "personal"), /concurrency/);
  assert.equal(resolveConfig(base, {}, "personal").subagents.rexConcurrency, 6);
  assert.equal(resolveConfig(base, { subagents: { rexConcurrency: 14 } }, "personal").subagents.rexConcurrency, 14);
  assert.throws(() => resolveConfig(base, { subagents: { rexConcurrency: 17 } }, "personal"), /rexConcurrency/);
  assert.equal(resolveConfig(base, {}, "personal").subagents.evalConcurrency, 6);
  assert.equal(resolveConfig({ ...base, subagents: { ...base.subagents, evalConcurrency: undefined } }, {}, "personal").subagents.evalConcurrency, 6);
  assert.throws(() => resolveConfig(base, { subagents: { evalConcurrency: 0 } }, "personal"), /evalConcurrency/);
  assert.throws(() => resolveConfig(base, { subagents: { childExtensions: ["npm:arbitrary"] } }, "personal"), /local paths/);
  assert.throws(() => profileName({ PI_WORKFLOW_PROFILE: "../work" }), /Invalid/);
});
test("auxiliary requests use their role, limits and abort signal without changing the parent", async () => {
  let captured: any[] = [];
  const parent = { provider: "main", id: "unchanged" };
  const ctx = { model: parent, modelRegistry: registry(async (...args) => {
    captured = args;
    return { content: [{ type: "text", text: "<title>Test role model routing</title>" }], stopReason: "stop", usage: {} };
  }) } as any;
  await completeRole(ctx, config, "tiny", "Name this", "Synthetic test", new AbortController().signal);
  assert.equal(ctx.model, parent);
  assert.equal(captured[0].id, config.roles.tiny?.model);
  assert.equal(captured[2].maxTokens, config.roles.tiny?.maxTokens);
  assert.equal(captured[2].reasoningEffort, "low");
  assert.ok(captured[2].signal instanceof AbortSignal);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(completeRole(ctx, config, "tiny", "", "", abort.signal));
});

test("role panel drafts are isolated; save preserves other profiles and running snapshots", async (t) => {
  const dir = await temporary(t);
  const file = join(dir, "roles.local.json");
  const local = {
    version: 1, note: "keep me",
    profiles: {
      personal: { roles: { task: { note: "custom field" } } },
      work: { roles: { advisor: null } },
    },
  };
  await saveJson(file, local);
  const store = await RoleStore.create(root, dir, "personal");
  const running = store.snapshot();
  const draft = await store.begin();
  draft.edits.task = { ...config.roles.task!, provider: "nous-portal", model: "test-model" };
  assert.equal(previewRoles(draft).roles.task?.provider, "nous-portal");
  assert.equal(store.snapshot().roles.task?.provider, "openai");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), local);
  const models = { ...registry(), find: (provider: string, id: string) => ({ provider, id, maxTokens: 8192, reasoning: true }) };
  await store.save(draft, models as any, new AbortController().signal);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.note, "keep me");
  assert.equal(saved.profiles.personal.roles.task.note, "custom field");
  assert.equal(saved.profiles.personal.presets.openai.roles.task.provider, "nous-portal", "edits belong to the active preset");
  assert.deepEqual(saved.profiles.work, local.profiles.work);
  assert.equal(store.snapshot().roles.task?.provider, "nous-portal");
  assert.equal(running.roles.task?.provider, "openai");
});

test("disable is explicit null; reset removes only the active profile override", async (t) => {
  const dir = await temporary(t);
  const store = await RoleStore.create(root, dir, "personal");
  const disabled = await store.begin();
  disabled.edits.task = null;
  await store.save(disabled, registry() as any, new AbortController().signal);
  assert.equal(store.snapshot().roles.task, null);
  const reset = await store.begin();
  reset.edits.task = "reset";
  await store.save(reset, registry() as any, new AbortController().signal);
  assert.equal(store.snapshot().roles.task?.provider, "openai");
  const saved = JSON.parse(await readFile(join(dir, "roles.local.json"), "utf8"));
  assert.ok(!Object.hasOwn(saved.profiles.personal.presets.openai.roles, "task"));
  assert.equal(saved.profiles.personal.roles, undefined);
  const work = await RoleStore.create(root, dir, "work");
  const workReset = await work.begin();
  workReset.edits.task = "reset";
  await work.save(workReset, registry() as any, new AbortController().signal);
  assert.equal(work.snapshot().roles.task, null);
});

test("stale or cancelled role saves do not overwrite files; thinking choices respect model metadata", async (t) => {
  const dir = await temporary(t);
  const store = await RoleStore.create(root, dir, "personal");
  const draft = await store.begin();
  draft.edits.tiny = null;
  const file = join(dir, "roles.local.json");
  await saveJson(file, { note: "external edit" });
  await assert.rejects(store.save(draft, registry() as any, new AbortController().signal), /files changed/);
  const current = await store.begin();
  current.edits.tiny = null;
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(store.save(current, registry() as any, cancel.signal));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { note: "external edit" });
  assert.deepEqual(supportedThinking({ reasoning: false }), ["off"]);
  assert.deepEqual(supportedThinking({ reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, max: "max" } }), ["high", "max"]);
});
