import assert from "node:assert/strict";
import test from "node:test";
import { register } from "../extensions/compaction/controller.ts";
import { limitsFor, planCompaction, staleReason, summaryThinking, type Limits, type Projected } from "../extensions/compaction/plan.ts";
import { usesSnapcompact } from "../extensions/snapcompact/compact.ts";

// Messages carry their own token estimate.
const estimate = (message: any) => message.tokens ?? 0;
const entry = (id: string, role: string, tokens = 5, extra: object = {}): Projected =>
  ({ sourceEntry: { id, type: "message" }, messages: [{ role, content: id, tokens, ...extra }] });
const user = (id: string, tokens?: number) => entry(id, "user", tokens);
const assistant = (id: string, tokens?: number, calls: Array<{ name: string; path: string }> = []) =>
  entry(id, "assistant", tokens, { content: calls.map(({ name, path }) => ({ type: "toolCall", name, arguments: { path } })) });
const result = (id: string, tokens?: number) => entry(id, "toolResult", tokens);
const compaction = (id: string, summary: string, details?: object): Projected =>
  ({ sourceEntry: { id, type: "compaction", summary, details }, messages: [{ role: "compactionSummary", summary }] });
const limits = (keepRecentTokens: number, threshold = 1000): Limits => ({ threshold, lead: 100, reserveTokens: 0, keepRecentTokens });

test("limits follow Pi's reserve, its overrides, and compact-ratio's lower share", () => {
  const gpt = { provider: "openai", id: "gpt", contextWindow: 400_000 };
  assert.deepEqual(limitsFor(gpt, {}), { threshold: 383_616, lead: 32_000, reserveTokens: 16_384, keepRecentTokens: 20_000 });
  const small = limitsFor({ ...gpt, contextWindow: 30_000 }, { compaction: { reserveTokens: 4000, keepRecentTokens: 2000 } });
  assert.deepEqual(small, { threshold: 26_000, lead: 8192, reserveTokens: 4000, keepRecentTokens: 2000 });
  const override = { compaction: { reserveTokens: 4000, modelOverrides: { "openai/gpt": { reserveTokens: 100_000 } } } };
  assert.equal(limitsFor(gpt, override)?.threshold, 300_000);
  assert.equal(limitsFor({ provider: "anthropic", id: "opus", contextWindow: 1_000_000 }, {})?.threshold, 400_000);
  assert.equal(limitsFor(gpt, { compaction: { enabled: false } }), undefined);
  assert.equal(limitsFor({ provider: "openai", id: "gpt" }, {}), undefined);
});

test("summaries think at low at most", () => {
  assert.equal(summaryThinking("xhigh"), "low");
  assert.equal(summaryThinking("medium"), "low");
  assert.equal(summaryThinking("minimal"), "minimal");
  assert.equal(summaryThinking("off"), "off");
  assert.equal(summaryThinking(undefined), "low");
});

test("snapcompact leaves OpenAI models to text summaries", () => {
  assert.equal(usesSnapcompact({ provider: "anthropic", input: ["text", "image"] }), true);
  assert.equal(usesSnapcompact({ provider: "openai", input: ["text", "image"] }), false);
  assert.equal(usesSnapcompact({ provider: "openai-codex", input: ["text", "image"] }), false);
  assert.equal(usesSnapcompact({ provider: "anthropic", input: ["text"] }), false);
});

test("a plan keeps the recent window and cuts at a turn start", () => {
  const entries = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3"), assistant("a3")];
  const plan = planCompaction(entries, limits(10), 30, estimate)!;
  assert.equal(plan.preparation.firstKeptEntryId, "u3");
  assert.equal(plan.preparation.isSplitTurn, false);
  assert.deepEqual(plan.preparation.messagesToSummarize.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(plan.preparation.tokensBefore, 30);
  assert.equal(plan.previousCompactionId, undefined);
  assert.deepEqual([...plan.summarizedIds], ["u1", "a1", "u2", "a2"]);
  assert.equal(planCompaction(entries, limits(100), 30, estimate), undefined, "nothing to summarize below the window");
});

test("one long run is cut inside the turn and its prefix summarized separately", () => {
  const entries = [user("u1"), assistant("a1", 5, [{ name: "read", path: "src/a.ts" }]), result("t1"), assistant("a2", 5, [{ name: "edit", path: "src/b.ts" }]), result("t2"), assistant("a3")];
  const plan = planCompaction(entries, limits(10), 30, estimate)!;
  assert.equal(plan.preparation.firstKeptEntryId, "a3", "never cut at a tool result");
  assert.equal(plan.preparation.isSplitTurn, true);
  assert.equal(plan.preparation.messagesToSummarize.length, 0);
  assert.equal(plan.preparation.turnPrefixMessages.length, 5);
  assert.deepEqual([...plan.preparation.fileOps.read], ["src/a.ts"]);
  assert.deepEqual([...plan.preparation.fileOps.edited], ["src/b.ts"]);
});

test("a plan extends the previous summary, and a snapcompact archive's transcript", () => {
  const entries = [compaction("c1", "Earlier work.", { readFiles: ["old.ts"], modifiedFiles: ["changed.ts"] }), user("u2"), assistant("a2"), user("u3"), assistant("a3")];
  const plan = planCompaction(entries, limits(10), 30, estimate)!;
  assert.equal(plan.previousCompactionId, "c1");
  assert.equal(plan.preparation.previousSummary, "Earlier work.");
  assert.deepEqual([...plan.preparation.fileOps.read], ["old.ts"]);
  assert.deepEqual([...plan.preparation.fileOps.edited], ["changed.ts"]);
  assert.equal(plan.preparation.messagesToSummarize.length, 2, "the old summary itself is not resummarized");

  const archived = [compaction("c1", "Reading guide for images", { snapcompact: { frames: [], totalChars: 9, truncatedChars: 0, text: "¶user:hi\u2588¶ai:ok" } }), ...entries.slice(1)];
  const fromArchive = planCompaction(archived, limits(10), 30, estimate)!;
  assert.match(fromArchive.preparation.previousSummary!, /¶user:hi\n¶ai:ok/);
  assert.doesNotMatch(fromArchive.preparation.previousSummary!, /Reading guide/);
});

test("a prepared summary is stale when its prefix changed or too much arrived since", () => {
  const entries = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3"), assistant("a3")];
  const plan = planCompaction(entries, limits(10), 30, estimate)!;
  const later = [...entries, user("u4"), assistant("a4")];
  assert.equal(staleReason(plan, "summary", later, limits(10), estimate), undefined);
  assert.equal(staleReason(plan, "summary", [compaction("c9", "x"), ...later.slice(4)], limits(10), estimate), "another compaction ran");
  assert.equal(staleReason(plan, "summary", entries.slice(0, 4), limits(10), estimate), "its history left the branch");
  const edit = { sourceEntry: { id: "e1", type: "context_edit", targetId: "a1" }, messages: [] };
  assert.equal(staleReason(plan, "summary", [...later, edit], limits(10), estimate), "summarized history was edited");
  const keptEdit = { sourceEntry: { id: "e2", type: "context_edit", targetId: "a4" }, messages: [] };
  assert.equal(staleReason(plan, "summary", [...later, keptEdit], limits(10), estimate), undefined);
  assert.equal(staleReason(plan, "summary", [...later, user("huge", 900)], limits(10), estimate), "too much history arrived since");
});

// A Pi double: OpenAI model, threshold 90,000 tokens, band from 78,750.
function harness(options: { provider?: string; commands?: string[] } = {}) {
  const handlers: Record<string, (event: any, ctx: any) => any> = {};
  const settings = { compaction: { reserveTokens: 10_000, keepRecentTokens: 10 } };
  const pi = {
    on: (name: string, handler: any) => { handlers[name] = handler; },
    getSettings: () => settings,
    getThinkingLevel: () => "xhigh",
    getCommands: () => (options.commands ?? []).map((name) => ({ name })),
  };
  const state = {
    tokens: 0,
    entries: [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3"), assistant("a3")] as Projected[],
    status: undefined as string | undefined,
    notes: [] as string[],
    calls: [] as Array<{ preparation: any; custom?: string; thinking: string; settle: (value: any) => void; fail: (error: Error) => void; signal: AbortSignal }>,
  };
  const ctx = {
    model: { provider: options.provider ?? "openai", id: "gpt", api: "openai-responses", contextWindow: 100_000, input: ["text", "image"] },
    hasUI: true,
    sessionManager: { getSessionId: () => "s1", buildSessionProjection: () => ({ entries: state.entries }) },
    modelRegistry: { streamSimple: () => { throw new Error("unexpected stream"); } },
    getContextUsage: () => ({ tokens: state.tokens }),
    ui: { setStatus: (_key: string, text?: string) => { state.status = text; }, notify: (text: string) => { state.notes.push(text); } },
  };
  const compact = (preparation: any, _model: any, _key: any, _headers: any, custom: string | undefined, signal: AbortSignal, thinking: string) =>
    new Promise<any>((settle, fail) => { state.calls.push({ preparation, custom, thinking, settle, fail, signal }); });
  register(pi as any, { compact: compact as any, estimateTokens: estimate });
  const turn = () => handlers.turn_end({}, ctx);
  const compactNow = (extra: object = {}) => {
    const controller = new AbortController();
    const preparation = { firstKeptEntryId: "pi-cut", tokensBefore: 95_000, previousSummary: undefined, fileOps: { read: new Set(), written: new Set(), edited: new Set() } };
    return { controller, result: handlers.session_before_compact({ preparation, branchEntries: [], customInstructions: undefined, signal: controller.signal, ...extra }, ctx) };
  };
  const summary = (preparation: any, text = "SUMMARY") => ({ summary: text, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore });
  return { state, handlers, ctx, turn, compactNow, summary };
}

test("a summary starts in the band, once, at low thinking, and commits with its own cut", async () => {
  const { state, turn, compactNow, summary } = harness();
  state.tokens = 70_000;
  turn();
  assert.equal(state.calls.length, 0, "below the band");
  state.tokens = 80_000;
  turn();
  turn();
  assert.equal(state.calls.length, 1, "one summary at a time");
  assert.equal(state.calls[0]!.thinking, "low");
  assert.equal(state.calls[0]!.preparation.firstKeptEntryId, "u3");
  assert.equal(state.status, "summarizing");
  state.calls[0]!.settle(summary(state.calls[0]!.preparation, "PREPARED"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.status, "summary ready");

  state.entries.push(user("u4"), assistant("a4"));
  state.tokens = 95_000;
  const result = await compactNow().result;
  assert.equal(state.calls.length, 1, "no new summary at the threshold");
  assert.deepEqual(result.compaction, { summary: "PREPARED", firstKeptEntryId: "u3", tokensBefore: 95_000 });
  assert.equal(state.status, undefined);
});

test("compaction waits for a summary already under way", async () => {
  const { state, turn, compactNow, summary } = harness();
  state.tokens = 80_000;
  turn();
  const pending = compactNow().result;
  state.calls[0]!.settle(summary(state.calls[0]!.preparation, "PREPARED"));
  assert.equal((await pending).compaction.summary, "PREPARED");
  assert.equal(state.calls.length, 1);
});

test("a stale summary falls back to summarizing Pi's preparation", async () => {
  const { state, turn, compactNow, summary } = harness();
  state.tokens = 80_000;
  turn();
  state.calls[0]!.settle(summary(state.calls[0]!.preparation));
  state.entries = [compaction("c1", "Someone else's summary.", { readFiles: ["x.ts"] }), user("u9"), assistant("a9")];
  const pending = compactNow().result;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.calls.length, 2);
  const fallback = state.calls[1]!;
  assert.equal(fallback.preparation.firstKeptEntryId, "pi-cut");
  assert.equal(fallback.preparation.previousSummary, "Someone else's summary.");
  assert.deepEqual([...fallback.preparation.fileOps.read], ["x.ts"]);
  assert.equal(fallback.thinking, "low");
  fallback.settle(summary(fallback.preparation, "FRESH"));
  assert.equal((await pending).compaction.summary, "FRESH");
});

test("custom instructions summarize directly, even for models snapcompact images", async () => {
  const { state, turn, compactNow, summary } = harness({ provider: "anthropic", commands: ["snapcompact"] });
  state.tokens = 35_000; // inside Anthropic's band
  turn();
  assert.equal(state.calls.length, 0, "snapcompact compacts this model without a summary");
  assert.equal(await compactNow().result, undefined);
  const pending = compactNow({ customInstructions: "focus on tests" }).result;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.calls[0]!.custom, "focus on tests");
  state.calls[0]!.settle(summary(state.calls[0]!.preparation));
  assert.equal((await pending).compaction.summary, "SUMMARY");
});

test("without the snapcompact extension, every model gets a summary", () => {
  const { state, turn } = harness({ provider: "anthropic" });
  state.tokens = 35_000; // compact-ratio puts Anthropic's threshold at 40,000
  turn();
  assert.equal(state.calls.length, 1);
});

test("a failed summary is not retried until the next compaction", async () => {
  const { state, handlers, ctx, turn } = harness();
  state.tokens = 80_000;
  turn();
  state.calls[0]!.fail(new Error("rate limited"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.status, undefined);
  turn();
  assert.equal(state.calls.length, 1);
  handlers.session_compact({}, ctx);
  turn();
  assert.equal(state.calls.length, 2);
});

test("much more context than when planned replaces the summary", async () => {
  const { state, turn, summary } = harness();
  state.tokens = 79_000;
  turn();
  state.calls[0]!.settle(summary(state.calls[0]!.preparation));
  await new Promise((resolve) => setImmediate(resolve));
  state.tokens = 79_005;
  turn();
  assert.equal(state.calls.length, 1, "a few tokens more keeps it");
  state.entries.push(user("u4"), assistant("a4"));
  state.tokens = 79_011;
  turn();
  assert.equal(state.calls.length, 2, "more than keepRecentTokens replans");
  assert.equal(state.calls[1]!.preparation.firstKeptEntryId, "u4");
});

test("a model switch cancels a summary under way", () => {
  const { state, handlers, ctx, turn } = harness();
  state.tokens = 80_000;
  turn();
  handlers.model_select({}, ctx);
  assert.equal(state.calls[0]!.signal.aborted, true);
});

test("cancelling compaction while waiting returns nothing", async () => {
  const { state, turn, compactNow } = harness();
  state.tokens = 80_000;
  turn();
  const { controller, result } = compactNow();
  controller.abort();
  assert.equal(await result, undefined);
});

test("a failed fallback summary leaves compaction to Pi with a warning", async () => {
  const { state, compactNow } = harness();
  const pending = compactNow().result;
  await new Promise((resolve) => setImmediate(resolve));
  state.calls[0]!.fail(new Error("boom"));
  assert.equal(await pending, undefined);
  assert.match(state.notes[0]!, /boom/);
});
