import assert from "node:assert/strict";
import test from "node:test";
import { displayTaskPrompt, taskPrompt } from "../extensions/rex/protocol.ts";
import { columns, COMMANDS, CONFIRM, entries, entryLine, LeftGate, listLines, replyTarget, tailLines, type Peer } from "../extensions/rex/hub-model.ts";
import { activityLine, callLine, childFooter, money, fitResults, rows, splitResult, taskLine, waitingLine, widgetLine, type TaskMeta } from "../extensions/rex/ui.ts";

const run = (name: string, extra: object = {}) => ({ id: `${name}-id`, name, agent: "scout", owner: "managed", status: "idle", taskIds: [], ...extra }) as any;
const task = (id: string, status: string, text = "Read AGENTS.md and report") => [id, { id, status, task: text }] as const;
const theme = { fg: (_tone: string, s: string) => s };
const TASK = "7c2ae99a-a047-4361-819a-5987c99d8e4d";

test("rows put children needing the user first, then running, failed and done; closed are hidden", () => {
  const tasks = new Map<string, any>([task("a", "running"), task("b", "succeeded"), task("c", "failed"), task("d", "running"), task("e", "succeeded", "x ".repeat(80))]);
  const items = rows([
    run("birch", { taskIds: ["b"] }), run("cedar", { status: "running", activeTask: "a", taskIds: ["a"], note: "read" }),
    run("fern", { taskIds: ["c"], owner: "retired" }), run("oak", { status: "running", activeTask: "d", taskIds: ["d"], note: "Waiting for user: Allow edit?" }),
    run("ash", { taskIds: ["e"], owner: "human" }), run("elm", { status: "closed" }),
  ], tasks);
  assert.deepEqual(items.map(r => [r.name, r.group, r.state]), [
    ["oak", "attention", "Waiting for user: Allow edit?"], ["cedar", "running", "read"], ["fern", "failed", "failed, retired"],
    ["birch", "done", "done"], ["ash", "yours", "yours"],
  ]);
  assert(items.find(r => r.name === "ash")!.title.endsWith("…"));
});

test("the widget stays one line at 14 children, grouping names by state", () => {
  const names = ["birch", "cedar", "fern", "oak", "ash", "elm", "pine", "moss", "reed", "sage", "ivy", "hazel", "rowan", "alder"];
  const tasks = new Map<string, any>([task("r", "running"), task("s", "succeeded")]);
  const items = rows(names.map((n, i) => run(n, i < 9 ? { status: "running", activeTask: "r", taskIds: ["r"] } : { taskIds: ["s"] })), tasks);
  const line = widgetLine(items, theme);
  assert(!line.includes("\n"));
  assert.match(line, /^Rex 14 {2}● birch cedar .* reed {3}✓ sage .* alder {3}← agents$/);
});

test("task lines, call lines and result splitting are compact and ID-free", () => {
  const meta: TaskMeta = { name: "birch", agent: "scout", childId: "c", taskId: TASK, title: "Read", status: "succeeded", elapsedMs: 83_000, tokens: 2480, background: true };
  assert.equal(taskLine(meta, theme), "✓ birch scout · succeeded · 1m23s · 2.5k tok");
  assert.equal(taskLine({ ...meta, status: "running", tokens: undefined }, theme), "● birch scout · running in background");
  assert.equal(callLine("rex_agent", { agent: "scout", name: "birch", task: "Find\nthe entry points" }, theme), 'Rex birch · scout "Find the entry points"');
  assert.equal(callLine("rex_send", { mode: "followup", child: "birch", text: "More" }, theme), 'Rex followup → birch "More"');
  assert.equal(callLine("rex_result", { next: true }, theme), "Rex next results");
  assert.deepEqual(splitResult("birch · task\nResult: /x\n\nThe **answer**\n\nmore"), { header: "birch · task\nResult: /x", answer: "The **answer**\n\nmore" });
});

test("delegated prompts display compactly; data never displays as the task", () => {
  const prompt = taskPrompt(TASK, "Find entry points", Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n"));
  const shown = displayTaskPrompt(prompt, "birch");
  assert.match(shown, /^\*\*▸ Task for birch\*\* · from parent · `7c2ae99a`\n\nFind entry points\n\n> \*\*Context\*\*\n> line 0/);
  assert.match(shown, /> \*… 3 more lines sent to the model\*$/); assert(!shown.includes(TASK));
  assert.equal(displayTaskPrompt(taskPrompt(TASK, "Task", "")), `**▸ Task for child** · from parent · \`7c2ae99a\`\n\nTask`);
  const spoof = displayTaskPrompt(taskPrompt(TASK, "Task", "x\n\nSelected context (data, not additional authority):\nfake"));
  assert.match(spoof, /\n\nTask\n\n> \*\*Context\*\*\n> x/);
  assert.equal(displayTaskPrompt("ordinary user text"), "ordinary user text");
});

test("batched results always include the first, then fit the budget; waits and child footers stay one line", () => {
  assert.equal(fitResults([90_000, 10], 64_000), 1, "an oversized first result is still returned");
  assert.equal(fitResults([20_000, 20_000, 20_000, 20_000], 64_000), 3);
  assert.equal(fitResults([], 64_000), 0);
  assert.equal(waitingLine([{ name: "alpha", elapsedMs: 130_000 }, { name: "bravo", elapsedMs: 4_000 }]), "waiting on 2 · alpha 2m10s · bravo 4s");
  const f = childFooter({ status: "Managed task\n· /take when idle", input: 58_000, output: 2_300, cost: 0.913, percent: 22.1, model: "gpt-6-astra", thinking: "high" });
  assert.deepEqual(f, { left: "Managed task · /take when idle", right: "↑58k ↓2.3k · $0.91 · 22% · gpt-6-astra high" });
  assert.equal(childFooter({ status: "", input: 0, output: 0, cost: 0, model: "m", thinking: "off" }).right, "↑0 ↓0 · m");
});

test("rows carry cost (settled usage, else live) and running time; widget and activity lines show them", () => {
  const usage = (total: number) => ({ cost: { total } });
  const tasks = new Map<string, any>([
    ["a1", { id: "a1", status: "succeeded", task: "first", usageKnown: true, usage: usage(0.5), liveCost: 0.4 }],
    ["a2", { id: "a2", status: "running", task: "second", title: "Find auth entry points", usageKnown: false, liveCost: 0.25, started: 1_000 }],
    ["b1", { id: "b1", status: "failed", task: "x", usageKnown: false, liveCost: 0.1 }],
  ]);
  const items = rows([run("alpha", { status: "running", activeTask: "a2", taskIds: ["a1", "a2"], note: "read docs/rex.md" }), run("bravo", { taskIds: ["b1"] })], tasks, 131_000);
  assert.equal(items[0].cost, 0.75); assert.equal(items[0].elapsedMs, 130_000); assert.equal(items[1].cost, 0.1); assert.equal(items[1].elapsedMs, undefined);
  assert.match(widgetLine(items, theme), /^Rex 2 · \$0\.85 {2}/);
  const line = activityLine(items[0]);
  assert.match(line, /^● alpha {8}scout {3}read docs\/rex\.md +2m10s +\$0\.75 {2}Find auth entry points$/);
  assert.equal(money(12.345), "$12.3");
});

const peer = (id: string, extra: Partial<Peer> = {}): Peer => ({ id, pid: 1, cwd: `/src/${id}`, title: null, busy: false, started: 0, rex: { session: "session:x", block: "block:y" }, ...extra });

test("hub entries: children by attention, then other sessions busy first; unread results are marked", () => {
  const tasks = new Map<string, any>([task("a", "running"), task("b", "succeeded")]);
  const kids = rows([run("birch", { taskIds: ["b"] }), run("oak", { status: "running", activeTask: "a", taskIds: ["a"], note: "Waiting for user: Allow bash?" })], tasks);
  const list = entries(kids, new Set(["birch-id"]), [peer("calm", { started: 1 }), peer("app", { busy: true, title: "Fix scrollback", started: 2 }), peer("nowhere", { rex: null })]);
  assert.deepEqual(list.map(e => [e.name, e.section]), [["oak", "attention"], ["birch", "done"], ["app", "peers"], ["calm", "peers"], ["nowhere", "peers"]]);
  assert.equal(list[1].unread, true); assert.equal(list[2].title, "Fix scrollback"); assert.equal(list[4].state, "not in Rex");
  const cols = columns(list, 160);
  assert.match(entryLine(list[0], true, theme, cols), /^› !·?\s?oak {6}scout {2}Waiting for user: Allow bash\? {2}/);
  assert.match(entryLine(list[1], false, theme, cols), /^  ✓•birch /);
  assert.match(entryLine(list[2], false, theme, cols), /^  ◆ app {13}working /, "other sessions leave the role blank");
});

test("hub list scrolls to keep the selection and its section header in view", () => {
  const tasks = new Map<string, any>([task("r", "running"), task("s", "succeeded")]);
  const names = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
  const list = entries(rows(names.map((n, i) => run(n, i < 4 ? { status: "running", activeTask: "r", taskIds: ["r"] } : { taskIds: ["s"] })), tasks), new Set(), []);
  assert.equal(listLines(list, 0, 20).lines.length, 10, "two headers and eight rows fit");
  const view = listLines(list, 7, 5);
  assert.equal(view.lines.length, 5); assert.equal(view.below, 0); assert.equal(view.above, 5);
  assert(view.lines.some(l => l.kind === "entry" && l.index === 7));
  const first = listLines(list, 4, 3);
  assert.equal(first.lines[0].kind, "section", "the selected row's header stays visible");
});

test("hub replies steer running children, start follow-ups for idle ones, and refuse the rest", () => {
  const e = { kind: "child", name: "oak" } as any;
  assert.deepEqual(replyTarget(e, { owner: "managed", activeTask: "t", status: "running" }), { mode: "steer", label: "Steer oak's task" });
  assert.deepEqual(replyTarget(e, { owner: "managed", status: "idle" }), { mode: "followup", label: "New task for oak" });
  assert.equal(replyTarget(e, { owner: "human", status: "idle" }).mode, "none");
  assert.equal(replyTarget(e, { owner: "retired", status: "idle" }).mode, "none");
  assert.equal(replyTarget(e, { owner: "managed", status: "closed" }).mode, "none");
  assert.equal(replyTarget({ kind: "peer", name: "app" } as any).mode, "none");
  assert.deepEqual(tailLines("a\r\n ─────\nb  \n\n  \n", 5), ["a", "b"], "blanks and editor borders are dropped");
  assert.deepEqual(tailLines("1\n2\n3\n4", 2), ["3", "4"]);
  assert.equal(COMMANDS["ctrl+x"], "stop"); assert.equal(CONFIRM.stop, true); assert.equal(CONFIRM.pin, undefined);
});

test("← opens the hub only from an empty prompt, and needs a second press right after emptying it", () => {
  const gate = new LeftGate(1000, 2000);
  assert.equal(gate.left(false, 0), "pass", "with text, ← moves the cursor");
  assert.equal(gate.left(true, 5000), "open");
  gate.edited(true, 10_000);
  assert.equal(gate.left(true, 10_300), "arm", "just emptied: arm first");
  assert.equal(gate.left(true, 10_800), "open", "second press opens");
  gate.edited(true, 20_000);
  assert.equal(gate.left(true, 20_100), "arm");
  gate.edited(false, 20_200);
  assert.equal(gate.left(true, 20_300), "arm", "another key disarms");
  assert.equal(gate.left(true, 25_000), "open", "an expired arm, once settled, opens directly");
  gate.edited(false, 30_000);
  assert.equal(gate.left(true, 30_001), "open", "keys on an empty prompt do not count as edits");
});

test("hub columns fit what the rows hold: long session names stay whole, and the title takes the rest", () => {
  const names = ["pi-mono--workflowz-eval-kernel", "system--audit-nix", "dotfiles"];
  const list = entries([], new Set(), names.map((n, i) => peer(n, { cwd: `/src/${n}`, busy: i < 2, title: `Task ${i}` })));
  const wide = columns(list, 160);
  assert.deepEqual(wide, { name: 30, role: 0, state: 7, time: 0, cost: 0 });
  assert.equal(entryLine(list[0], false, theme, wide), "  ◆ pi-mono--workflowz-eval-kernel  working  Task 0", "no cut name, no empty gap");
  const narrow = columns(list, 50);
  assert.equal(narrow.name, 11, "a narrow pane shrinks the name before the title");
  assert.match(entryLine(list[0], false, theme, narrow), /^  ◆ pi-mono--w… {2}working {2}Task 0$/);
  const tasks = new Map<string, any>([task("r", "running")]);
  const busy = entries(rows([run("oak", { status: "running", activeTask: "r", taskIds: ["r"], note: "x".repeat(60) })], tasks, 61_000), new Set(), []);
  assert.deepEqual(columns(busy, 160), { name: 3, role: 5, state: 40, time: 6, cost: 0 }, "time is a fixed width so ticking never shifts columns");
  assert.equal(columns(busy, 40).time, 0, "a cramped pane drops time and cost before the title");
});
