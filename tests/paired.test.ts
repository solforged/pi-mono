import assert from "node:assert/strict";
import test from "node:test";
import { paired, report, type Row } from "../scripts/paired.ts";
import { TASKS } from "../scripts/paired-tasks.ts";

const row = (task: string, arm: "off" | "on", cost: number, run = 1, pass = true): Row =>
  ({ task, run, arm, pass, cost, turns: cost * 10, calls: 0, multi: 0, batchable: 0, promptTokens: 0, seconds: 0, note: "" });

test("runs are averaged per task before tasks are compared", () => {
  // Task a ran twice as often; it must not count twice.
  const rows = [row("a", "off", 4, 1), row("a", "off", 6, 2), row("a", "on", 3, 1), row("a", "on", 3, 2), row("b", "off", 2), row("b", "on", 4)];
  const result = paired(rows, r => r.cost);
  assert.deepEqual(result.tasks, [{ task: "a", off: 5, on: 3 }, { task: "b", off: 2, on: 4 }]);
  assert.equal(result.diff, 0);
  assert.ok(result.low <= 0 && result.high >= 0);
});

test("a consistent difference gives an interval that excludes zero, and repeats exactly", () => {
  const rows = ["a", "b", "c", "d", "e"].flatMap((task, i) => [row(task, "off", 10 + i), row(task, "on", 8 + i * 0.9)]);
  const result = paired(rows, r => r.cost);
  assert.ok(result.high < 0, `interval ${result.low} to ${result.high}`);
  assert.deepEqual(paired(rows, r => r.cost), result);
});

test("a task missing an arm is left out", () => {
  assert.deepEqual(paired([row("a", "off", 1), row("b", "off", 1), row("b", "on", 2)], r => r.cost).tasks.map(t => t.task), ["b"]);
  assert.equal(paired([], r => r.cost).diff, 0);
});

test("the report shows both arms, the difference, and what was spent", () => {
  const text = report([row("a", "off", 1.5), row("a", "on", 1, 1, false)]);
  assert.match(text, /1 tasks, 1 runs off and 1 on, \$2\.50 spent/);
  assert.match(text, /tests pass\s+100%\s+0%\s+−100%/);
  assert.match(text, /cost\s+\$1\.500\s+\$1\.000\s+−\$0\.500/);
});

test("tasks have unique names and a prompt", () => {
  assert.equal(new Set(TASKS.map(t => t.id)).size, TASKS.length);
  for (const task of TASKS) assert.ok(/^[0-9a-f]{7,}$/.test(task.commit) && task.prompt.length > 40, task.id);
});
