import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import {
  NOTE_TYPE, close, create, decide, format, fresh, parseAmount, restore, section, snapshot, statusText, transition, valid, withBudget,
  type Snapshot,
} from "../extensions/goal/goal.ts";
import { root, noModel } from "./helpers.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const custom = (data: Snapshot, minute = 0) => ({ type: "custom", customType: "goal", data, timestamp: at(minute) });
const reply = (input: number, output: number, cacheRead = 0) => ({ type: "message", message: { role: "assistant", usage: { input, output, cacheRead, cacheWrite: 0 } } });
const note = (kind = "continue") => ({ type: "custom_message", customType: NOTE_TYPE, details: { kind } });
const result = (details: unknown, isError = false) => ({ type: "message", message: { role: "toolResult", toolName: "goal", isError, details } });

test("objectives are cleaned and budgets parsed", () => {
  const goal = create("  Make  the suite pass\n\n\n\nwithout skips ");
  assert.deepEqual(goal, { objective: "Make the suite pass\n\nwithout skips", status: "active", budget: { continuations: 25 } });
  assert.throws(() => create("   "), /must not be empty/);
  assert.throws(() => create("x".repeat(4001)), /exceeds 4000/);
  assert.equal(parseAmount("500k", "tokens"), 500_000);
  assert.equal(parseAmount("1.5M", "tokens"), 1_500_000);
  assert.equal(parseAmount("2_000", "tokens"), 2000);
  assert.equal(parseAmount("off", "tokens"), undefined);
  assert.equal(parseAmount("40", "continuations"), 40);
  assert.throws(() => parseAmount("4k", "continuations"), /whole number/);
  assert.throws(() => parseAmount("0", "tokens"), /500k/);
  assert.throws(() => parseAmount("lots", "tokens"), /500k/);
});

test("the user owns the lifecycle and the agent can only close an active goal", () => {
  const goal = create("ship it");
  assert.throws(() => transition(null, "pause"), /No goal is set/);
  const paused = transition(goal, "pause");
  assert.deepEqual([paused.event, paused.goal!.status], ["pause", "paused"]);
  assert.throws(() => transition(paused.goal, "pause"), /paused, not active/);
  assert.throws(() => transition(goal, "resume"), /already active/);
  assert.throws(() => close(paused.goal, "complete", "done"), /no active goal/);
  const blocked = close(goal, "blocked", "needs a staging key");
  assert.deepEqual([blocked.goal!.status, blocked.goal!.note], ["blocked", "needs a staging key"]);
  // Resuming starts a fresh audit: the old blocker is dropped.
  const resumed = transition(blocked.goal, "resume");
  assert.deepEqual([resumed.event, resumed.goal!.status, resumed.goal!.note], ["resume", "active", undefined]);
  const limited = { ...goal, status: "budget_limited" as const };
  assert.equal(close(limited, "complete", "tests pass").goal!.status, "complete");
  assert.throws(() => close(goal, "complete", " "), /note must not be empty/);
  const complete = close(goal, "complete", "green");
  assert.throws(() => transition(complete.goal, "resume"), /complete/);
  assert.deepEqual(transition(complete.goal, "clear"), { event: "clear", goal: null });
  assert.deepEqual(withBudget(goal, "tokens", 300_000).goal!.budget, { continuations: 25, tokens: 300_000 });
  assert.deepEqual(withBudget(goal, "continuations", undefined).goal!.budget, {});
});

test("state and usage are restored from the branch, counting from the last set or resume", () => {
  const goal = create("ship it");
  assert.deepEqual(restore([]), { goal: null, used: { continuations: 0, tokens: 0 } });
  // Usage before the goal and while it is paused is not counted.
  const entries: any[] = [reply(900, 100), custom(snapshot("set", goal), 0), reply(100, 50, 9000), note(), reply(10, 5), note(), note("limit")];
  let state = restore(entries);
  assert.deepEqual(state.used, { continuations: 2, tokens: 165, since: Date.parse(at(0)) });
  entries.push(custom(transition(goal, "pause"), 5), reply(1000, 1000), note());
  state = restore(entries);
  assert.equal(state.goal!.status, "paused");
  assert.equal(state.used.tokens, 165);
  entries.push(custom(transition(state.goal, "resume"), 9), reply(20, 2));
  assert.deepEqual(restore(entries).used, { continuations: 0, tokens: 22, since: Date.parse(at(9)) });
  // Tool results carry snapshots too; failed calls and damaged data are ignored.
  entries.push(result(close(goal, "complete", "green")), result({ event: "complete", goal: { objective: "x" } }), result(snapshot("clear", null), true));
  assert.equal(restore(entries).goal!.status, "complete");
  entries.push(custom(snapshot("clear", null)));
  assert.equal(restore(entries).goal, null);
  assert.equal(valid({ event: "set", goal: null }), undefined);
  assert.equal(valid({ event: "set", goal: { ...goal, budget: { tokens: -1 } } }), undefined);
  assert.equal(fresh({ input: 3, output: 4, cacheRead: 100, cacheWrite: 5 }), 12);
  // Restored goals are copies, never shared with session entries.
  const entry = custom(snapshot("set", goal));
  restore([entry]).goal!.budget.continuations = 1;
  assert.equal(entry.data.goal!.budget.continuations, 25);
});

test("the loop continues on progress, waits without it, and stops at the budget", () => {
  const goal = create("ship it");
  const used = { continuations: 0, tokens: 0 };
  assert.deepEqual(decide({ goal: null, used }, true), { kind: "none" });
  assert.deepEqual(decide({ goal: { ...goal, status: "paused" }, used }, true), { kind: "none" });
  assert.deepEqual(decide({ goal, used }, false), { kind: "wait" });
  assert.deepEqual(decide({ goal, used: { continuations: 3, tokens: 0 } }, true), { kind: "continue", n: 4 });
  assert.deepEqual(decide({ goal, used: { continuations: 25, tokens: 0 } }, false), { kind: "limit", reason: "25 automatic continuations" });
  const tokens = withBudget(goal, "tokens", 500_000).goal!;
  assert.deepEqual(decide({ goal: tokens, used: { continuations: 1, tokens: 500_000 } }, true), { kind: "limit", reason: "500k tokens" });
  const unlimited = withBudget(goal, "continuations", undefined).goal!;
  assert.deepEqual(decide({ goal: unlimited, used: { continuations: 900, tokens: 0 } }, true), { kind: "continue", n: 901 });
});

test("the prompt section, status and summary describe the goal", () => {
  const goal = create("Make the suite pass");
  assert.match(section(goal)!, /^Objective: Make the suite pass\n\n.*status complete only after checking.*status blocked only when the same blocker/s);
  assert.equal(section({ ...goal, status: "paused" }), undefined);
  assert.equal(section(null), undefined);
  assert.equal(statusText({ goal, used: { continuations: 3, tokens: 0 } }), "goal 3/25");
  assert.equal(statusText({ goal: { ...goal, budget: {} }, used: { continuations: 3, tokens: 0 } }), "goal 3");
  assert.equal(statusText({ goal: { ...goal, status: "budget_limited" }, used: { continuations: 25, tokens: 0 } }), "goal out of budget");
  assert.equal(statusText({ goal: null, used: { continuations: 0, tokens: 0 } }), undefined);
  const since = Date.parse(at(0));
  const tokens = withBudget(goal, "tokens", 2_000_000).goal!;
  assert.equal(format({ goal: tokens, used: { continuations: 2, tokens: 123_456, since } }, since + 95 * 60000),
    "Goal (active): Make the suite pass\nUsed this run: 2 of 25 continuations, 123k of 2M tokens, 1 h 35 min");
  assert.match(format({ goal: close(goal, "blocked", "no key").goal, used: { continuations: 0, tokens: 0 } }), /\nBlocker: no key$/);
  assert.match(format({ goal: null, used: { continuations: 0, tokens: 0 } }), /^No goal is set/);
});

test("installed Pi loads the extension and executes offline smoke checks", t => {
  const env = { ...process.env };
  for (const key of ["PI_REX_CHILD", "PI_WORKFLOW_CHILD_CONFIG"]) delete env[key];
  const check = spawnSync("pi", ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", "-e", join(root, "tests/fixtures/goal-smoke.ts"), ...noModel, "-p", "/goal-smoke"], { cwd: root, encoding: "utf8", timeout: 30000, env });
  if (check.error && (check.error as any).code === "ENOENT") { t.skip("Pi is not installed"); return; }
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /Goal integration:.*passed/);
});
