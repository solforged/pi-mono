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

test("personal roles default to OpenAI; Anthropic is opt-in; work stays unset", () => {
  assert.equal(profileName({}), "personal");
  assert.equal(profileName({ FNOX_PROFILE: "work" }), "personal");
  assert.equal(profileName({ PI_WORKFLOW_PROFILE: "anthropic" }), "anthropic");
  assert.equal(config.roles.task?.model, "gpt-6.1-sol");
  assert.equal(config.roles.commit?.model, "gpt-6-luna");
  assert.equal(config.roles.learn?.model, "gpt-6-luna");
  const anthropic = resolveConfig(base, {}, "anthropic");
  assert.equal(anthropic.roles.advisor?.model, "claude-opus-5-5");
  assert.equal(anthropic.roles.task?.model, "claude-sonnet-5-5");
  assert.equal(anthropic.roles.commit?.model, "claude-haiku-5-5");
  const work = resolveConfig(base, {}, "work");
  for (const name of roleNames) {
    assert.equal(config.roles[name]?.provider, "openai");
    assert.equal(anthropic.roles[name]?.provider, "anthropic");
    assert.equal(work.roles[name], null);
    assert.throws(() => resolveRole(work, name, registry() as any), /no fallback/);
  }
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
  assert.ok(!Object.hasOwn(saved.profiles.personal.roles, "task"));
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
