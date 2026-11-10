import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { alreadyReviewed, commandActions, documented, recurrence, runs, type Run } from "../extensions/workflows/autolearn.ts";
import { indexSessions, readState, registerAutolearn, type AutoState } from "../extensions/workflows/autolearn-ui.ts";
import { readDrafts } from "../extensions/workflows/learning.ts";
import { scopeRoot } from "../extensions/workflows/state.ts";
import { config, registry, temporary } from "./helpers.ts";

let next = 0;
const id = () => `e${++next}`;
const user = (text: string) => ({ id: id(), type: "message", message: { role: "user", content: text } });
const bash = (command: string) => ({ id: id(), type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: { command } }] } });
const done = () => ({ id: id(), type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] } });
const task = (text: string, commands: string[]) => [user(text), ...commands.map(bash), done()];
const release = (version: string) => task(`release ${version}`, [
  "mise run test", `git tag ${version}`, "git push --tags", `gh release create ${version} --generate-notes`,
  "npm publish --access public", `gh release view ${version}`, "mise run test",
]);
const chore = (name: string) => task(name, ["mise run test", "cargo build", "cargo test", "cargo clippy", `cargo run --bin ${name}`, "mise run test"]);
const runOf = (entries: any[]) => runs(entries)[0];

test("shell commands reduce to the steps that identify a workflow", () => {
  assert.deepEqual(commandActions("cd /repo && FOO=1 mise run test 2>&1 | tail -5"), ["mise run test"]);
  assert.deepEqual(commandActions("git status; git -C /tmp/wt rebase main && git commit -m 'x; y'"), ["git rebase"]);
  assert.deepEqual(commandActions("python3 - <<'EOF'\nimport os\nprint(os.getcwd())\nEOF"), []);
  assert.deepEqual(commandActions("timeout 30 node scripts/install.ts --check"), ["node scripts/install.ts"]);
  assert.deepEqual(commandActions("rex client:01a1beda-42d5 send-key Enter"), ["rex"]);
  assert.deepEqual(commandActions("gh pr create --fill"), ["gh pr create"]);
  assert.deepEqual(commandActions("npm publish --access public"), ["npm publish"]);
});

test("a workflow recurs only when its distinctive steps repeat across enough sessions", () => {
  const current = runOf(release("v3"));
  const others = new Map<string, Run[]>([
    ["a", [runOf(release("v1"))]], ["b", [runOf(release("v2"))]],
    ...["c", "d", "e", "f"].map((name) => [name, [runOf(chore(name))]] as [string, Run[]]),
  ]);
  const found = recurrence(current, others, 3)!;
  assert.equal(found.sessions, 3);
  assert.deepEqual(found.matches.map((match) => match.session).sort(), ["a", "b"]);
  assert.ok(found.core.includes("$ gh release create"));
  // The test command runs in every session, so on its own it is routine rather than part of the pattern.
  assert.ok(!found.core.includes("$ mise run test"));
  others.delete("b");
  assert.equal(recurrence(current, others, 3), undefined);
  assert.equal(recurrence(runOf(chore("g")), new Map([["a", [runOf(release("v1"))]], ["b", [runOf(release("v2"))]]]), 3), undefined);
  // Short or read-only tasks are never runs at all.
  assert.deepEqual(runs(task("look around", ["ls", "cat README.md", "git status", "git log", "rg foo", "wc -l x"])), []);
});

test("reviewed patterns wait for twice the sessions; documented commands are skipped", () => {
  const core = ["$ gh release create", "$ npm publish", "$ gh release create → $ npm publish", "$ git tag"];
  const reviews = [{ core, sessions: 3, at: "", outcome: "nothing" }];
  assert.ok(alreadyReviewed(core, 5, reviews));
  assert.ok(!alreadyReviewed(core, 6, reviews));
  assert.ok(!alreadyReviewed(["$ cargo build", "$ cargo test", "$ cargo build → $ cargo test", "$ cargo run"], 3, reviews));
  assert.ok(documented(core, "Release with git tag, gh release create and npm publish."));
  assert.ok(!documented(core, "Release with git tag and npm publish."));
});

test("the session index is incremental and counts forked history once", async (t) => {
  const dir = await temporary(t);
  const original = release("v1"), fork = [...original, ...release("v2")];
  const files = { a: join(dir, "a.jsonl"), b: join(dir, "b.jsonl"), quiet: join(dir, "quiet.jsonl") };
  for (const file of Object.values(files)) await writeFile(file, "x");
  const opened: string[] = [];
  const open = (path: string) => {
    opened.push(path);
    return { getSessionId: () => path, getHeader: () => ({ timestamp: path === files.a ? "2026-01-01" : "2026-01-02" }), getBranch: () => path === files.a ? original : path === files.b ? fork : [] };
  };
  const state: AutoState = { version: 1, files: {}, reviews: [] };
  const listed = [{ path: files.a }, { path: files.b }, { path: files.quiet }, { path: join(dir, "gone.jsonl") }];
  let index = await indexSessions(state, listed, { entryIds: new Set() }, open);
  assert.equal(index.others.get(files.a)!.length, 1);
  assert.equal(index.others.get(files.b)!.length, 1); // Only the fork's own task.
  assert.equal(index.sessions, 4); // Sessions without comparable work still count toward "routine".
  // Resuming the parent changes its mtime, not which session owns the shared task.
  await writeFile(files.a, "resumed"); await utimes(files.a, new Date(), new Date(Date.now() + 5000));
  index = await indexSessions(state, listed, { entryIds: new Set() }, open);
  assert.equal(index.others.get(files.a)!.length, 1);
  assert.equal(index.others.get(files.b)!.length, 1);
  assert.equal(opened.length, 4); // Unchanged files are not reopened.
});

test("autolearn stays idle until enabled, then stages one proposal for a recurring workflow", async (t) => {
  const dir = await temporary(t);
  const files = [join(dir, "one.jsonl"), join(dir, "two.jsonl")];
  for (const file of files) await writeFile(file, "x");
  const history = new Map([[files[0], release("v1")], [files[1], release("v2")]]);
  const sessions = {
    listed: 0,
    async list() { this.listed++; return files.map((path) => ({ path })); },
    open: (path: string) => ({ getSessionId: () => path, getHeader: () => null, getBranch: () => history.get(path)! }),
  };
  const events: Record<string, (...args: any[]) => any> = {};
  const commands: Record<string, any> = {};
  const pi = { on: (event: string, fn: any) => { events[event] = fn; }, registerCommand: (name: string, command: any) => { commands[name] = command; }, appendEntry() {} } as any;
  const prompts: string[] = [];
  // A steering message mid-task does not split it.
  const released = release("v3");
  const steered = [...released.slice(0, 4), user("also check the notes"), ...released.slice(4)];
  let branch: any[] = [];
  const setBranch = (entries: any[]) => { branch = entries; };
  const notices: string[] = [];
  const ctx = {
    hasUI: true, cwd: dir, ui: { notify: (text: string) => notices.push(text) },
    modelRegistry: registry(async (_model: any, request: any) => {
      prompts.push(request.messages[0].content[0].text);
      return { stopReason: "stop", usage: {}, content: [{ type: "text", text: JSON.stringify([{
        action: "automate", name: "publishing-releases", reason: "Same release steps in three sessions",
        content: "Add a `mise run release` task that tags, publishes and creates the GitHub release.\n", sources: [`current:${steered[0].id}`],
      }]) }] };
    }),
    sessionManager: { getBranch: () => branch, getLeafId: () => branch.at(-1)?.id ?? null, getSessionFile: () => join(dir, "current.jsonl"), getSessionId: () => "current" },
  } as any;
  const settle = async () => {
    events.agent_settled({ aborted: false }, ctx);
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  // Authored skills are read-only, so only their description is sent: a
  // large one must not exhaust the input budget.
  const authored = join(dir, "authored", "SKILL.md");
  await mkdir(join(dir, "authored"));
  await writeFile(authored, `---\nname: writing-prose\ndescription: Edits prose.\n---\n${"AUTHORED BODY ".repeat(5000)}\n`);
  registerAutolearn(pi, config, dir, new AbortController().signal, () => {}, sessions);
  events.session_start({}, ctx);
  setBranch(release("v0"));
  events.before_agent_start({ systemPromptOptions: { contextFiles: [{ path: "AGENTS.md", content: "Run mise run test." }], skills: [{ name: "writing-prose", filePath: authored, description: "Edits prose." }] } });

  await settle();
  assert.equal(sessions.listed, 0);
  assert.equal(prompts.length, 0);
  setBranch([...branch, ...steered]);

  await commands.autolearn.handler("on", { ...ctx, modelRegistry: registry() });
  await settle();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Recurring steps \(in 3 sessions\)/);
  assert.match(prompts[0], /gh release create/);
  assert.match(prompts[0], /"name":"writing-prose","managed":false,"ref":"skill:writing-prose:[0-9a-f]{12}","description":"Edits prose\."/);
  assert.doesNotMatch(prompts[0], /AUTHORED BODY/);
  assert.deepEqual(notices.filter((text) => /skipped/.test(text)), []);
  const root = await scopeRoot(dir, config.profile, dir);
  const [draft] = await readDrafts(root);
  assert.equal(draft.action, "automate");
  assert.equal(draft.origin, "autolearn");
  assert.match(notices.at(-1)!, /3 sessions.*automating publishing-releases.*\/learn-review/);
  assert.equal((await readState(root)).reviews[0].outcome, "automate publishing-releases");

  // The same pattern again stays quiet: it was reviewed and a proposal is pending.
  setBranch([...branch, ...release("v4")]);
  await settle();
  assert.equal(prompts.length, 1);
});

test("an over-budget skill inventory warns without marking the pattern reviewed", async (t) => {
  const dir = await temporary(t);
  const history = new Map([[join(dir, "one.jsonl"), release("v1")], [join(dir, "two.jsonl"), release("v2")]]);
  for (const file of history.keys()) await writeFile(file, "x");
  const sessions = { list: async () => [...history.keys()].map((path) => ({ path })), open: (path: string) => ({ getSessionId: () => path, getHeader: () => null, getBranch: () => history.get(path)! }) };
  const events: Record<string, (...args: any[]) => any> = {};
  const commands: Record<string, any> = {};
  const pi = { on: (event: string, fn: any) => { events[event] = fn; }, registerCommand: (name: string, command: any) => { commands[name] = command; }, appendEntry() {} } as any;
  let calls = 0;
  const notices: string[] = [];
  let branch: any[] = [];
  const ctx = {
    hasUI: true, cwd: dir, ui: { notify: (text: string) => notices.push(text) },
    modelRegistry: registry(async () => { calls++; return { stopReason: "stop", usage: {}, content: [{ type: "text", text: "[]" }] }; }),
    sessionManager: { getBranch: () => branch, getLeafId: () => branch.at(-1)?.id ?? null, getSessionFile: () => join(dir, "current.jsonl"), getSessionId: () => "current" },
  } as any;
  const root = await scopeRoot(dir, config.profile, dir);
  await mkdir(join(root, "skills", "huge"), { recursive: true });
  await writeFile(join(root, "skills", "huge", "SKILL.md"), `---\nname: huge\ndescription: "Huge."\n---\n${"x".repeat(config.learning.maxInputChars)}\n`);
  registerAutolearn(pi, config, dir, new AbortController().signal, () => {}, sessions);
  events.session_start({}, ctx);
  events.before_agent_start({ systemPromptOptions: { contextFiles: [], skills: [] } });
  await commands.autolearn.handler("on", ctx);
  branch = release("v3");
  events.agent_settled({ aborted: false }, ctx);
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 0);
  assert.match(notices.at(-1)!, /Managed skills exceed the learning input budget/);
  assert.deepEqual((await readState(root)).reviews, []); // Raising the limit lets this pattern be reviewed.
});

test("a dry run lists recurring patterns and why each would or would not run, without saving", async (t) => {
  const dir = await temporary(t);
  const history = new Map<string, any[]>();
  for (const [i, entries] of [release("v1"), release("v2"), release("v3"), chore("a")].entries()) history.set(join(dir, `${i}.jsonl`), entries);
  for (const file of history.keys()) await writeFile(file, "x");
  const sessions = {
    list: async () => [...history.keys()].map((path, i) => ({ path, name: i === 0 ? "first release" : undefined, firstMessage: `release ${i}` })),
    open: (path: string) => ({ getSessionId: () => path, getHeader: () => null, getBranch: () => history.get(path)! }),
  };
  const commands: Record<string, any> = {};
  const reports: string[] = [];
  const pi = { on() {}, registerCommand: (name: string, command: any) => { commands[name] = command; }, appendEntry() {} } as any;
  registerAutolearn(pi, config, dir, new AbortController().signal, (_ctx, text) => reports.push(text), sessions);
  let instructions = "";
  const ctx = { cwd: dir, getSystemPromptOptions: () => ({ contextFiles: [{ path: "AGENTS.md", content: instructions }] }) } as any;

  await commands.autolearn.handler("dry-run", ctx);
  assert.match(reports[0], /no model call, nothing saved\. 4 sessions indexed; a pattern needs 3/);
  assert.match(reports[0], /Autolearn is off here/);
  assert.match(reports[0], /1\. would review · 3 sessions · .*gh release create/);
  assert.match(reports[0], /seen in: .*"first release"/);
  assert.doesNotMatch(reports[0], /cargo/);
  const root = await scopeRoot(dir, config.profile, dir);
  assert.deepEqual((await readState(root)).files, {});

  instructions = "Run mise run test, then release with git tag, gh release create, npm publish and gh release view.";
  await commands.autolearn.handler("dry-run", ctx);
  assert.match(reports[1], /skip: already in project instructions/);
});
