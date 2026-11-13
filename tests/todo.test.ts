import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { apply, empty, format, ordered, reminder, restore, section, upNext, valid, withParentTodos, type List } from "../extensions/todo/store.ts";
import { root, noModel } from "./helpers.ts";

const result = (list: List, isError = false) => ({ type: "message", message: { role: "toolResult", toolName: "todo", isError, details: { action: "add", ...list } } });
const custom = (data: unknown) => ({ type: "custom", customType: "todo", data });
const build = (texts: string[]) => apply(empty(), { action: "add", items: texts }).list;

test("operations update items, never reuse IDs, and validate input", () => {
  let { list, summary } = apply(empty(), { action: "add", items: ["  write\n tests ", "ship"] });
  assert.equal(summary, "Added #1, #2");
  assert.equal(list.items[0].text, "write tests");
  ({ list } = apply(list, { action: "update", id: 1, change: { status: "done", note: "covered" } }));
  assert.deepEqual([list.items[0].status, list.items[0].note], ["done", "covered"]);
  ({ list } = apply(list, { action: "update", id: 1, change: { note: "" } }));
  assert.equal(list.items[0].note, undefined);
  ({ list, summary } = apply(list, { action: "clear_done" }));
  assert.equal(summary, "Removed 1 finished item(s)");
  ({ list } = apply(list, { action: "remove", id: 2 }));
  ({ list } = apply(list, { action: "add", items: ["again"] }));
  assert.equal(list.items[0].id, 3);
  assert.throws(() => apply(list, { action: "add", items: [" "] }), /must not be empty/);
  assert.throws(() => apply(list, { action: "add", items: [] }), /at least one/);
  assert.throws(() => apply(list, { action: "update", id: 9, change: { status: "done" } }), /#9 not found/);
  assert.throws(() => apply(list, { action: "update", id: 3, change: {} }), /Provide text, status or note/);
  assert.throws(() => apply(list, { action: "update", id: 3, change: { status: "later" as any } }), /status must be one of/);
  assert.throws(() => apply(list, { action: "add", items: Array(200).fill("x") }), /at most 200/);
});

test("blocked items sort after started ones and the glance follows the current item", () => {
  let list = build(["a", "b", "c", "d", "e", "f"]);
  const set = (id: number, status: any, note?: string) => { list = apply(list, { action: "update", id, change: { status, note } }).list; };
  set(4, "in_progress"); set(2, "blocked", "waiting on the API"); set(6, "done");
  assert.deepEqual(ordered(list.items).map((item) => item.id), [4, 2, 1, 3, 5, 6]);
  assert.equal(format(list).split("\n")[2], "#2 [blocked] b (note: waiting on the API)");
  // Started and blocked lead; then the pending items after #4, wrapping to earlier ones.
  assert.deepEqual(upNext(list, 4).items.map((item) => item.id), [4, 2, 5, 1]);
  assert.equal(upNext(list, 4).hidden, 1);
  assert.deepEqual(upNext(build(["x", "y"]), 3).items.map((item) => item.id), [1, 2]);
  assert.deepEqual(upNext(empty()), { items: [], hidden: 0 });
});

test("state is restored from the latest valid snapshot on the branch", () => {
  const first = build(["a"]), second = build(["a", "b"]), edited = apply(second, { action: "update", id: 2, change: { status: "done" } }).list;
  assert.deepEqual(restore([]), empty());
  assert.deepEqual(restore([result(first), { type: "message", message: { role: "user", content: "hi" } }, result(second)]), second);
  assert.deepEqual(restore([result(first), custom(edited)]), edited);
  // Failed calls and damaged snapshots leave the previous state in place.
  assert.deepEqual(restore([result(first), result(second, true), custom({ nextId: 1, items: [{ id: 1, text: "x", status: "pending" }] })]), first);
  assert.equal(valid({ nextId: 3, items: [{ id: 1, text: "x", status: "bogus" }] }), undefined);
  // Restored lists are copies, never shared with session entries.
  const entry = result(first); restore([entry]).items[0].text = "changed";
  assert.equal(entry.message.details.items[0].text, "a");
});

test("listings, prompt section, reminder and child context stay bounded", () => {
  let list = build(["a", "b", "c"]);
  list = apply(list, { action: "update", id: 3, change: { status: "in_progress" } }).list;
  list = apply(list, { action: "update", id: 1, change: { status: "done" } }).list;
  assert.equal(format(list), "2 open, 1 done\n#3 [in_progress] c\n#2 [pending] b\n#1 [done] a");
  assert.equal(section(list), "#3 [in_progress] c\n#2 [pending] b");
  assert.match(reminder(list, 2)!, /^You stopped with 2 open todo item\(s\):\n#3 \[in_progress\] c\n#2 \[pending\] b\n\n.*waiting on the user.*\(Reminder 2\/3\)$/s);
  const finished = apply(build(["x"]), { action: "update", id: 1, change: { status: "done" } }).list;
  assert.equal(section(finished), undefined);
  assert.equal(reminder(finished, 1), undefined);
  const long = section(build(Array.from({ length: 30 }, (_, i) => `item ${i}`)), 20, 300)!;
  assert.ok(long.length < 320);
  assert.match(long, /\n… \d+ more$/);
  assert.equal(format(empty()), "The todo list is empty.");

  assert.equal(withParentTodos("Inspect src.", list), "Inspect src.\n\nParent session's open todo items (read-only, for orientation):\n#3 [in_progress] c\n#2 [pending] b");
  assert.match(withParentTodos(undefined, list)!, /^Parent session's open todo items/);
  assert.equal(withParentTodos("x".repeat(15990), list), "x".repeat(15990));
  assert.equal(withParentTodos("kept", finished), "kept");
  assert.equal(withParentTodos(undefined, finished), undefined);
});

test("installed Pi loads the extension and executes offline smoke checks", t => {
  const env = { ...process.env };
  for (const key of ["PI_REX_CHILD", "PI_WORKFLOW_CHILD_CONFIG"]) delete env[key];
  const check = spawnSync("pi", ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", "-e", join(root, "tests/fixtures/todo-smoke.ts"), ...noModel, "-p", "/todo-smoke"], { cwd: root, encoding: "utf8", timeout: 30000, env });
  if (check.error && (check.error as any).code === "ENOENT") { t.skip("Pi is not installed"); return; }
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /Todo integration:.*passed/);
});
