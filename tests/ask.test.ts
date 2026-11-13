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

test("a note picks the focused option and reaches the agent beside it", () => {
  const form = new Form(normalize([q("Q?", { recommended: 1 })]));
  assert.equal(form.startNote(), "note");
  assert.equal(form.noteText, "");
  assert.equal(form.note("  only if it stays portable "), "submit");
  assert.deepEqual(form.result[0], { picked: [1], notes: { 1: "only if it stays portable" } });
  assert.equal(resultText({ outcome: "answered", items: items(form.questions, form.result) }), 'User answers:\n- Q? → B (note: "only if it stays portable")');
  assert.equal(form.noteText, "only if it stays portable");
  // Notes stay on their option: choosing another option or typing an own answer keeps them, marked not chosen.
  form.move(1); form.enter();
  assert.equal(form.noteText, "");
  assert.equal(items(form.questions, form.result)[0].answer, 'C; note on B, not chosen: "only if it stays portable"');
  form.custom("something else");
  assert.deepEqual(form.result[0], { picked: [], notes: { 1: "only if it stays portable" }, custom: "something else" });
  // Blank text removes the note but still chooses; the own-answer row takes no note.
  form.move(-1); form.note(" ");
  assert.deepEqual(form.result[0], { picked: [1] });
  form.move(5);
  assert.equal(form.startNote(), undefined);
});

test("multi-select keeps a separate note on each option and stays on the question", () => {
  const form = new Form(normalize([q("Many?", { multi: true }), q("One?")]));
  form.number(1);
  assert.equal(form.note("for writes"), undefined);
  form.move(1);
  assert.equal(form.note("for reads\nonly hot paths"), undefined);
  assert.equal(form.tab, 0);
  assert.deepEqual(form.result[0], { picked: [0, 1], notes: { 0: "for writes", 1: "for reads\nonly hot paths" } });
  form.move(-1);
  assert.equal(form.noteText, "for writes");
  // Unchecking keeps the note on its option, and the agent hears it was not chosen.
  form.toggle();
  form.move(5); form.custom("and D");
  const [item] = items(form.questions, form.result);
  assert.equal(item.answer, 'B (note: "for reads\nonly hot paths"); own answer: "and D"; note on A, not chosen: "for writes"');
  assert.deepEqual(item.notes, [{ option: "A", text: "for writes", chosen: false }, { option: "B", text: "for reads\nonly hot paths", chosen: true }]);
  // The own answer moved on to the next question; the review tab takes no note.
  assert.equal(form.tab, 1);
  form.go(1);
  assert.equal(form.reviewing, true);
  assert.equal(form.startNote(), undefined);
});

test("leaving a note without choosing keeps it on the option and leaves picks alone", () => {
  const form = new Form(normalize([q("Q?")]));
  form.move(2);
  assert.equal(form.note("maybe later", false), undefined);
  assert.equal(form.answers[0], undefined);
  assert.deepEqual(form.result[0], { picked: [], notes: { 2: "maybe later" } });
  form.note("", false);
  assert.equal(form.result[0], undefined);
});

test("what was entered before discussing survives as drafts", () => {
  const form = new Form(normalize([q("Many?", { multi: true }), q("One?")]));
  form.number(2); form.note("keep it small");
  const details = { outcome: "discuss" as const, items: items(form.questions, form.result, false) };
  assert.equal(details.items[0].answer, undefined);
  assert.equal(details.items[0].draft, 'B (note: "keep it small")');
  assert.match(resultText(details), /wait for their message\.\n\nNot submitted, but entered before leaving the dialog:\n- Many\? → B \(note: "keep it small"\)$/);
  assert.equal(resultText({ outcome: "discuss", items: items(form.questions, [], false) }), "The user wants to discuss these questions in chat instead. Nothing was answered. End your turn now, without calling tools, and wait for their message.");
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

test("ledger leaves system messages in place, and without an anchor goes after the leading ones", () => {
  const branch = [result("old", "answered", "Postgres"), { type: "compaction", id: "c", summary: "SUMMARY", firstKeptEntryId: "c" }];
  const patch = { role: "system", content: "patch" };
  const messages = [{ role: "system", content: "head" }, { role: "compactionSummary", summary: "SUMMARY" }, patch, { role: "user", content: "next" }];
  const out = withLedger(messages as any[], branch)!;
  assert.deepEqual(out.map((m: any) => m.customType ?? m.role), ["system", "compactionSummary", LEDGER, "system", "user"]);
  assert.equal(out[3], patch);
  const orphan = withLedger([{ role: "system", content: "head" }, { role: "user", content: "next" }] as any[], branch)!;
  assert.deepEqual(orphan.map((m: any) => m.customType ?? m.role), ["system", LEDGER, "user"]);
});

test("ledger follows a summary that snapcompact already turned into a user message", () => {
  const branch = [result("old", "answered", "Postgres"), { type: "compaction", id: "c", summary: "SUMMARY", firstKeptEntryId: "c" }];
  const messages = [{ role: "user", content: [{ type: "text", text: "SUMMARY" }, { type: "image" }] }, { role: "user", content: "next" }];
  const out = withLedger(messages as any[], branch)!;
  assert.equal((out[1] as any).customType, LEDGER);
  assert.equal((out[2] as any).content, "next");
});
