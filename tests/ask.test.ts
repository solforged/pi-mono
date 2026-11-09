import assert from "node:assert/strict";
import test from "node:test";
import { decisions, Form, invalid, items, LEDGER, normalize, parseMulti, prepare, resultText, TOOL, withLedger, type Question } from "../extensions/ask/model.ts";

const q = (question: string, extra: Partial<Question> = {}): Question => ({ question, options: [{ label: "A" }, { label: "B" }, { label: "C" }], ...extra });

test("prepare repairs stringified questions and (Recommended) labels", () => {
  const args = prepare({ questions: JSON.stringify([{ question: "Q?", options: [{ label: "x" }, { label: "y (Recommended)" }] }]) }) as any;
  assert.deepEqual(args.questions[0].options.map((o: any) => o.label), ["x", "y"]);
  assert.equal(args.questions[0].recommended, 1);
  const explicit = prepare({ questions: [{ question: "Q?", recommended: 0, options: [{ label: "x" }, { label: "y (recommended)" }] }] }) as any;
  assert.equal(explicit.questions[0].recommended, 0);
});

test("validation explains what to fix", () => {
  assert.equal(invalid(normalize([q("Q?")])), undefined);
  assert.match(invalid([])!, /1-4 questions/);
  assert.match(invalid(normalize([q("Same?"), q("Same?")]))!, /repeats/);
  assert.match(invalid(normalize([q("Q?", { options: [{ label: "A" }] })]))!, /2-4 options/);
  assert.match(invalid(normalize([q("Q?", { options: [{ label: "A" }, { label: " a " }] })]))!, /duplicate/);
  assert.match(invalid(normalize([q("Q?", { recommended: 3 })]))!, /does not exist/);
});

test("single question: cursor starts on the recommendation and Enter submits", () => {
  const form = new Form(normalize([q("Q?", { recommended: 2 })]));
  assert.equal(form.cursor[0], 2);
  assert.equal(form.enter(), "submit");
  assert.deepEqual(form.answers, [{ picked: [2] }]);
});

test("own answer row replaces a choice, and blank text leaves a single question to the agent", () => {
  const form = new Form(normalize([q("Q?")]));
  assert.equal(form.number(1), "submit");
  assert.equal(form.number(4), "edit");
  assert.equal(form.custom("something else"), "submit");
  assert.deepEqual(form.answers[0], { picked: [], custom: "something else" });
  assert.equal(form.custom("  "), "submit");
  assert.equal(form.answers[0], undefined);
  const multi = new Form(normalize([q("Many?", { multi: true })]));
  multi.number(2);
  assert.equal(multi.custom(""), "submit");
  assert.deepEqual(multi.answers[0], { picked: [1] });
});

test("multi-select toggles, keeps typed text with picks, and advances through review", () => {
  const form = new Form(normalize([q("Many?", { multi: true }), q("One?")]));
  assert.equal(form.tabs, 3);
  form.number(1); form.number(3); form.number(1);
  assert.deepEqual(form.answers[0], { picked: [2] });
  form.move(5);
  assert.equal(form.enter(), "edit");
  assert.equal(form.custom("and D"), undefined);
  assert.deepEqual(form.answers[0], { picked: [2], custom: "and D" });
  assert.equal(form.tab, 1);
  form.go(1);
  assert.equal(form.reviewing, true);
  form.move(1);
  assert.equal(form.enter(), "discuss");
  form.move(-1);
  assert.equal(form.enter(), "submit");
  const text = resultText({ outcome: "answered", items: items(form.questions, form.answers) });
  assert.equal(text, 'User answers:\n- Many? → C; own answer: "and D"\n- One? → no answer; decide yourself and state your assumption');
});

test("Enter on a multi-select question with nothing picked picks the focused option", () => {
  const form = new Form(normalize([q("Many?", { multi: true, recommended: 1 }), q("One?")]));
  assert.equal(form.enter(), undefined);
  assert.deepEqual(form.answers[0], { picked: [1] });
  assert.equal(form.tab, 1);
});

test("dialog-host multi replies take numbers and optional text", () => {
  assert.deepEqual(parseMulti("1, 3; plus this", 3), { picked: [0, 2], custom: "plus this" });
  assert.deepEqual(parseMulti("9", 3), undefined);
  assert.deepEqual(parseMulti("just words", 3), { picked: [], custom: "just words" });
  assert.equal(parseMulti("", 3), undefined);
});

const result = (id: string, outcome: string, answer?: string) => ({ type: "message", id, message: { role: "toolResult", toolName: TOOL, toolCallId: id,
  details: { outcome, items: [{ question: `${id}?`, ...(answer ? { answer } : {}) }] } } });

test("ledger restates only answered decisions that compaction removed", () => {
  const branch = [result("old", "answered", "Postgres"), result("skipped", "answered"), result("talk", "discuss"), result("omitted", "answered", "Mongo"),
    { type: "context_edit", targetId: "omitted", replacement: null }, result("retained", "answered", "Redis"),
    { type: "compaction", summary: "SUMMARY", firstKeptEntryId: "retained" }, result("later", "answered", "Valkey"), { type: "context_edit", targetId: "later", replacement: null }];
  assert.deepEqual(decisions(branch), [{ question: "old?", answer: "Postgres" }]);
  const messages = [{ role: "compactionSummary", summary: "SUMMARY", timestamp: 5 }, { role: "user", content: "hi" }, { role: "toolResult", toolCallId: "retained" }];
  const out = withLedger(messages as any[], branch)!;
  assert.equal(out.length, 4);
  assert.equal((out[1] as any).customType, LEDGER);
  assert.equal((out[1] as any).timestamp, 5);
  assert.match((out[1] as any).content, /- old\? → Postgres$/);
  assert.equal(withLedger(messages as any[], branch.filter(e => e.type !== "compaction")), undefined);
});

test("ledger follows a summary that snapcompact already turned into a user message", () => {
  const branch = [result("old", "answered", "Postgres"), { type: "compaction", id: "c", summary: "SUMMARY", firstKeptEntryId: "c" }];
  const messages = [{ role: "user", content: [{ type: "text", text: "SUMMARY" }, { type: "image" }] }, { role: "user", content: "next" }];
  const out = withLedger(messages as any[], branch)!;
  assert.equal((out[1] as any).customType, LEDGER);
  assert.equal((out[2] as any).content, "next");
});
