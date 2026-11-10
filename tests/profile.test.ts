import assert from "node:assert/strict";
import test from "node:test";
import { calibrate, carried, mainBranch, parse, profile, program, readOnly, render, timeline } from "../scripts/profile.ts";

// Prices per token: reading from cache 1, sending for the first time 10.
const READ = 1, FIRST = 10;
let n = 0, clock = Date.parse("2026-11-09T10:00:00Z");
function session(...specs: object[]) {
  const entries: any[] = [{ type: "session", version: 3, id: "s", timestamp: new Date(clock).toISOString() }];
  for (const spec of specs) entries.push({ id: `e${++n}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date(clock += 1000).toISOString(), ...spec });
  return entries;
}
const user = (text = "fix it") => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });
// cacheRead and cacheWrite are tokens; the dollar cost follows the prices above.
function assistant(usage: { cacheRead?: number; cacheWrite?: number; input?: number }, content: object[], stopReason = content.some((c: any) => c.type === "toolCall") ? "toolUse" : "stop", model = "m") {
  const { cacheRead = 0, cacheWrite = 0, input = 0 } = usage;
  const cost = { input: input * FIRST, output: 0, cacheRead: cacheRead * READ, cacheWrite: cacheWrite * FIRST, total: 0 };
  cost.total = cost.input + cost.cacheRead + cost.cacheWrite;
  return { type: "message", message: { role: "assistant", model, stopReason, content, usage: { input, output: 0, cacheRead, cacheWrite, cost } } };
}
const result = (toolCallId: string, toolName: string, text: string, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId, toolName, isError, content: [{ type: "text", text }] } });
const text = (value: string) => ({ type: "text", text: value });

test("the main branch is the last entry's ancestry, and torn records are skipped", () => {
  const entries = parse([
    { type: "session", id: "s" }, { id: "a", parentId: null }, { id: "b", parentId: "a" }, { id: "c", parentId: "a" },
  ].map(e => JSON.stringify(e)).join("\n") + "\n{\"id\":\"d\",\"par");
  assert.deepEqual(mainBranch(entries).map(e => e.id), ["a", "c"]);
});

test("a result is charged once at the first-send price, then at the read price on each later turn", () => {
  const t = timeline(mainBranch(session(
    user(), assistant({ cacheWrite: 100 }, [call("1", "read", { path: "a.ts" })]), result("1", "read", "x".repeat(400)),
    assistant({ cacheRead: 100, cacheWrite: 100 }, [call("2", "bash", { command: "ls" })]), result("2", "bash", "a.ts"),
    assistant({ cacheRead: 200, cacheWrite: 1 }, [text("Done.")]),
  )));
  assert.deepEqual(t.prompts, [3]);
  const [read] = t.results;
  assert.deepEqual([read.tool, read.bytes, read.start, read.end], ["read", 400, 1, 3]);
  // 400 bytes at the default 4 bytes per token is 100 tokens: 100 × 10 on the turn that first sends it, 100 × 1 after.
  assert.equal(carried(t, read), 1100);
  assert.equal(carried(t, read, 2), 100);
});

test("bytes per token are measured from prompt growth once a model has enough turns", () => {
  const specs: object[] = [user()];
  // Each turn adds a 300-byte result and the prompt grows by 100 tokens: 3 bytes per token.
  for (let i = 0; i < 25; i++) specs.push(assistant({ cacheRead: 1000 + i * 100 }, [call(`c${i}`, "read", {})]), result(`c${i}`, "read", "y".repeat(288)));
  const t = timeline(mainBranch(session(...specs)));
  const rate = calibrate([t]).m;
  assert.ok(rate > 2.9 && rate < 3.2, `rate ${rate}`);
  assert.equal(t.bytesPerToken.m, rate);
  assert.deepEqual(calibrate([timeline(mainBranch(session(user(), assistant({ cacheRead: 10 }, [text("hi")]))))]), {});
});

test("compaction ends what it dropped and keeps the rest", () => {
  const entries = session(
    user(), assistant({ cacheWrite: 10 }, [call("1", "read", { path: "old.ts" })]), result("1", "read", "old"),
    assistant({ cacheRead: 10 }, [call("2", "read", { path: "kept.ts" })]), result("2", "read", "kept"),
  );
  entries.push({ id: "cmp", parentId: entries.at(-1).id, timestamp: new Date(clock += 1000).toISOString(), type: "compaction", summary: "earlier work", firstKeptEntryId: entries.at(-2).id });
  entries.push({ id: "last", parentId: "cmp", timestamp: new Date(clock += 1000).toISOString(), ...assistant({ cacheWrite: 30 }, [text("Done.")]) });
  const t = timeline(mainBranch(entries));
  assert.deepEqual(t.results.map(r => [r.text, r.end]), [["old", 2], ["kept", 3]]);
  assert.equal(t.drops.length, 0); // Below the size where a miss is worth reporting.
});

test("cache rewrites are attributed to what happened between the two requests", () => {
  const big = { cacheRead: 30_000 };
  const idle = session(user(), assistant(big, [text("a")]), user());
  clock += 6 * 60_000;
  idle.push({ id: "late", parentId: idle.at(-1).id, timestamp: new Date(clock).toISOString(), ...assistant({ cacheWrite: 30_100 }, [text("b")]) });
  assert.deepEqual(timeline(mainBranch(idle)).drops.map(d => [d.cause, d.rewritten]), [["idle 5m–1h", 30_100]]);

  const patched = session(user(), assistant(big, [text("a")]), { type: "message", message: { role: "system", content: "", sections: { todos: null }, toolsAdded: [{ name: "todo" }] } }, user(), assistant({ cacheWrite: 30_100 }, [text("b")]));
  const [drop] = timeline(mainBranch(patched)).drops;
  // A patch normally keeps the cache, so it is reported as context, not as the cause.
  assert.deepEqual([drop.cause, drop.detail], ["unexplained", "after a patch: +todo -todos"]);
  // 30,000 tokens re-sent at 10 instead of 1.
  assert.equal(drop.extra, 30_000 * (FIRST - READ));
  assert.equal(timeline(mainBranch(session(user(), assistant(big, [text("a")]), user(), assistant({ cacheRead: 30_050 }, [text("b")])))).drops.length, 0);
});

test("cache warming refreshes are counted apart from model calls", () => {
  const warm = { type: "usage", kind: "cache_warm", usage: { cacheRead: 500, cost: { total: 500 * READ } } };
  const report = profile([session(user(), assistant({ cacheWrite: 100 }, [text("done")]), warm, warm)]);
  assert.deepEqual(report.warming, { count: 2, dollars: 1000 });
  assert.equal(report.calls, 1);
  assert.equal(report.total, 100 * FIRST + 1000);
  assert.match(render(report), /Cache warming: 2 refreshes/);
});

test("bash commands are classified by the program they run", () => {
  assert.equal(program("cd /repo && FOO=1 /usr/bin/sed -n 1,20p a.ts"), "sed");
  assert.equal(program("git status --short | head"), "git");
  const bash = (command: string) => readOnly({ id: "", name: "bash", args: { command } });
  for (const command of ["sed -n 1,20p a.ts", "cd x && cat a.ts 2>/dev/null", "rg foo src | head", "git log --oneline -5", "ls -la"]) assert.ok(bash(command), command);
  for (const command of ["sed -i s/a/b/ a.ts", "cat a.ts > b.ts", "git commit -m x", "rm a.ts", "node --test", "find . -name x -delete"]) assert.ok(!bash(command), command);
  assert.ok(readOnly({ id: "", name: "read", args: {} }));
  assert.ok(!readOnly({ id: "", name: "edit", args: {} }));
});

test("the report sizes candidates from what the sessions recorded", () => {
  const body = "z".repeat(4000);
  const report = profile([session(
    user(),
    assistant({ cacheWrite: 100 }, [call("1", "read", { path: "/r/a.ts" })]), result("1", "read", body),
    assistant({ cacheRead: 1100, cacheWrite: 10 }, [call("2", "bash", { command: "cat /r/a.ts" })]), result("2", "bash", body),
    assistant({ cacheRead: 2100, cacheWrite: 10 }, [call("3", "bash", { command: "rg nothing" })]), result("3", "bash", "(no output)\n\nCommand exited with code 1"),
    assistant({ cacheRead: 2110, cacheWrite: 10 }, [call("4", "read", { path: "/r/a.ts" })]), result("4", "read", body),
    assistant({ cacheRead: 3110, cacheWrite: 10 }, [call("5", "edit", { path: "/r/a.ts" })]), result("5", "edit", "Successfully replaced 1 block(s)"),
    assistant({ cacheRead: 3120, cacheWrite: 10 }, [call("6", "bash", { command: "node --test" })]), result("6", "bash", "SyntaxError: Unexpected token\n\nCommand exited with code 1"),
    assistant({ cacheRead: 3130, cacheWrite: 10 }, [call("7", "web_search", { query: "q", recency: "null" })]), result("7", "web_search", "Validation failed for tool \"web_search\":\n  - recency: expected one of", true),
    assistant({ cacheRead: 3140, cacheWrite: 10 }, []),
    { type: "custom_message", customType: "recover", content: "note", details: { kind: "empty", count: 1 } },
    assistant({ cacheRead: 3150, cacheWrite: 10 }, [text("Done.")]),
  )]);
  const sizing = Object.fromEntries(report.sizings.map(s => [s.candidate, s.count]));
  assert.equal(report.calls, 9);
  assert.deepEqual(report.callsPerTurn, [2, 7, 0, 0]);
  assert.deepEqual(report.validation, { "web_search.recency": 1 });
  assert.deepEqual(report.endings, { empty: 1, cut: 0, repeats: 0, recovered: { empty: 1 } });
  assert.equal(sizing["All re-reads (ceiling)"], 1);
  assert.equal(sizing["Bash file reads"], 1);
  assert.equal(sizing["…that repeat a `read`"], 1);
  assert.equal(sizing["Elide empty results"], 1);
  // Turns 2 to 4 each follow a single read-only call with another one.
  assert.equal(sizing["Batch read-only turns (ceiling)"], 3);
  assert.equal(sizing["Post-edit check"], 1);
  // The second whole-file read supersedes the first: 1000 tokens no longer re-read on four later turns…
  const supersede = report.sizings.find(s => s.candidate === "Blank superseded reads")!;
  assert.equal(supersede.count, 0); // …but re-sending the 1010 tokens after it at 9 more each costs more than that.
  assert.equal(report.tools.read.calls, 2);
  assert.equal(report.bash.cat.bytes, 4000);
  const printed = render(report);
  for (const expected of ["1 sessions", "What the prompt spend carried", "Candidate sizing", "Turn endings left to the user: 1 empty stops", "Recovery notes: empty 1", "web_search.recency 1"]) assert.ok(printed.includes(expected), expected);
});
