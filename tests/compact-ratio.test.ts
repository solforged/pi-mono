import assert from "node:assert/strict";
import test from "node:test";
import registerCompactRatio, { thresholdFor } from "../extensions/compact-ratio/index.ts";

const opus = { provider: "anthropic", id: "claude-opus-9", contextWindow: 1_000_000 };

test("anthropic models compact at 40% of their window", () => {
  assert.equal(thresholdFor(opus, {}), 400_000);
  assert.equal(thresholdFor({ ...opus, contextWindow: 200_000 }, undefined), 80_000);
});

test("other providers, disabled compaction and exact overrides are left to Pi", () => {
  assert.equal(thresholdFor({ ...opus, provider: "openai" }, {}), undefined);
  assert.equal(thresholdFor({ ...opus, contextWindow: undefined }, {}), undefined);
  assert.equal(thresholdFor(opus, { compaction: { enabled: false } }), undefined);
  const settings = { compaction: { modelOverrides: { "anthropic/claude-opus-9": { reserveTokens: 1 } } } };
  assert.equal(thresholdFor(opus, settings), undefined);
  assert.equal(thresholdFor({ ...opus, id: "claude-opus-10" }, settings), 400_000);
  const keepOnly = { compaction: { modelOverrides: { "anthropic/claude-opus-9": { keepRecentTokens: 1 } } } };
  assert.equal(thresholdFor(opus, keepOnly), 400_000);
});

function harness(settings: object = {}) {
  const handlers: Record<string, (event: any, ctx?: any) => unknown> = {};
  registerCompactRatio({ on: (name: string, h: any) => { handlers[name] = h; }, getSettings: () => settings } as any);
  const state = { tokens: 0, idle: true, compactions: [] as any[] };
  const ctx = {
    model: opus, hasUI: false, isIdle: () => state.idle,
    getContextUsage: () => ({ tokens: state.tokens }),
    compact: (options: any) => { state.compactions.push(options); },
  };
  const input = (event: object = {}) => handlers.input({ text: "hi", source: "interactive", ...event }, ctx);
  return { state, input, handlers };
}

test("an idle prompt above the threshold compacts once", () => {
  const { state, input } = harness();
  state.tokens = 399_999;
  input();
  assert.equal(state.compactions.length, 0);
  state.tokens = 400_001;
  input();
  input();
  assert.equal(state.compactions.length, 1, "no second compaction while one runs");
  state.tokens = 50_000;
  state.compactions[0].onComplete();
  state.tokens = 450_000;
  input();
  assert.equal(state.compactions.length, 2);
});

test("steering, queued and busy input never compacts, since that aborts the run", () => {
  const { state, input } = harness();
  state.tokens = 900_000;
  input({ streamingBehavior: "steer" });
  input({ streamingBehavior: "followUp" });
  state.idle = false;
  input();
  assert.equal(state.compactions.length, 0);
});

test("a compaction that cannot get below the threshold is not repeated every prompt", () => {
  const { state, input, handlers } = harness();
  state.tokens = 500_000;
  input();
  state.compactions[0].onComplete();
  input();
  assert.equal(state.compactions.length, 1);
  state.tokens = 100_000;
  input();
  state.tokens = 500_000;
  input();
  assert.equal(state.compactions.length, 2, "dropping below the threshold re-arms it");
  state.compactions[1].onError(new Error("boom"));
  input();
  assert.equal(state.compactions.length, 2);
  handlers.model_select({});
  input();
  assert.equal(state.compactions.length, 3, "a model switch re-arms it");
});
