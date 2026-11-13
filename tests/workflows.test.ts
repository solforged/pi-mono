import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isTransientError, loadTitlePrompt, MAX_TRANSIENT_FAILURES, parseTitle, registerAutoname } from "../extensions/workflows/autoname.ts";
import { applyDraft, evidenceChunks, evidenceFromBranch, inventoryInput, inventorySkills, parseCandidates, readDrafts, renderDraft, skillRef, stageCandidate } from "../extensions/workflows/learning.ts";
import { atomicWrite, hash, readSkill, withLock } from "../extensions/workflows/state.ts";
import { agents, childArgs, childExtensions, childOutcome, createWorktree } from "../extensions/workflows/subagents.ts";
import { runProcess } from "../extensions/workflows/process.ts";
import { auxiliaryUsage, formatAuxiliary, recordUsage, showAuxiliaryUsage } from "../extensions/workflows/usage.ts";
import { config, registry, root, skill, temporary } from "./helpers.ts";

test("title prompts prefer the agent directory and fall back only when absent", async (t) => {
  const dir = await temporary(t);
  assert.equal(await loadTitlePrompt(root, dir), await readFile(join(root, "TITLE_SYSTEM.md"), "utf8"));
  await writeFile(join(dir, "TITLE_SYSTEM.md"), "Shared title rules");
  assert.equal(await loadTitlePrompt(root, dir), "Shared title rules");
  const broken = await temporary(t);
  await mkdir(join(broken, "TITLE_SYSTEM.md"));
  await assert.rejects(loadTitlePrompt(root, broken), { code: "EISDIR" });
});

test("automatic names cannot overwrite a manual name while a request is pending", async () => {
  assert.equal(parseTitle("<title>Fix the session naming</title>"), "Fix the session naming");
  assert.equal(parseTitle("<title>none</title>"), undefined);
  assert.equal(parseTitle("<title>Bad\ntitle</title>"), undefined);
  const events: Record<string, (...args: any[]) => any> = {};
  let name: string | undefined;
  let finish: (value: any) => void = () => {};
  const pi = { on: (event: string, fn: any) => { events[event] = fn; }, registerCommand() {}, appendEntry() {}, getSessionName: () => name, setSessionName: (value: string) => { name = value; } } as any;
  const ctx = { mode: "tui", hasUI: true, ui: { notify() {} }, modelRegistry: registry(() => new Promise((resolve) => { finish = resolve; })), sessionManager: {
    getSessionId: () => "one", getEntries: () => [],
    getBranch: () => [{ type: "message", message: { role: "user", content: "Fix the naming race" } }],
  } } as any;
  registerAutoname(pi, config, "Name the task", new AbortController().signal);
  events.session_start({}, ctx); events.message_end({ message: { role: "user" } }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  name = "My explicit name"; events.session_info_changed();
  finish({ content: [{ type: "text", text: "<title>Fix the naming race</title>" }], stopReason: "stop", usage: {} });
  await new Promise(setImmediate);
  assert.equal(name, "My explicit name");
});

test("transient naming failures retry on the next message; permanent ones use the attempt", async () => {
  const outage = "OpenAI API error (503): {\"code\":\"subscription_sharing_user_unavailable\"}";
  assert.ok(isTransientError(new Error(`tiny: ${outage}`)));
  assert.ok(isTransientError(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
  assert.ok(!isTransientError(new Error("tiny: 429 insufficient_quota")));
  assert.ok(!isTransientError(new Error("Role tiny is not configured")));

  async function run(replies: string[]) {
    const events: Record<string, (...args: any[]) => any> = {};
    const markers: unknown[] = [];
    const notices: string[] = [];
    let name: string | undefined;
    let calls = 0;
    const pi = { on: (event: string, fn: any) => { events[event] = fn; }, registerCommand() {}, getSessionName: () => name, setSessionName: (value: string) => { name = value; },
      appendEntry: (type: string, data: unknown) => { if (type === "workflow-title") markers.push(data); } } as any;
    const ctx = { mode: "tui", hasUI: true, ui: { notify: (text: string) => notices.push(text) }, sessionManager: {
      getSessionId: () => "one", getEntries: () => [],
      getBranch: () => [{ type: "message", message: { role: "user", content: "Fix the naming race" } }],
    }, modelRegistry: registry(async () => {
      const reply = replies[calls++];
      return reply.startsWith("error:")
        ? { content: [], stopReason: "error", errorMessage: reply.slice(6), usage: {} }
        : { content: [{ type: "text", text: reply }], stopReason: "stop", usage: {} };
    }) } as any;
    registerAutoname(pi, config, "Name the task", new AbortController().signal);
    events.session_start({}, ctx);
    for (let i = 0; i < replies.length + 1; i++) {
      events.message_end({ message: { role: "user" } }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise(setImmediate);
    }
    return { name, calls, markers, notices };
  }

  const recovered = await run([`error:${outage}`, "<title>Fix the naming race</title>"]);
  assert.equal(recovered.name, "Fix the naming race");
  assert.equal(recovered.calls, 2);
  assert.equal(recovered.markers.length, 1);
  assert.match(recovered.notices[0], /will retry on your next message/);

  const outageForever = await run(Array(MAX_TRANSIENT_FAILURES).fill(`error:${outage}`));
  assert.equal(outageForever.calls, MAX_TRANSIENT_FAILURES);
  assert.equal(outageForever.markers.length, 1);
  assert.match(outageForever.notices.at(-1)!, /skipped/);

  const permanent = await run(["error:insufficient_quota"]);
  assert.equal(permanent.calls, 1);
  assert.equal(permanent.markers.length, 1);
  assert.match(permanent.notices[0], /skipped/);
});

test("an unset tiny role turns automatic naming off quietly; /autoname still reports it", async () => {
  const events: Record<string, (...args: any[]) => any> = {};
  const notices: string[] = [], markers: unknown[] = [];
  let command: any;
  const pi = { on: (event: string, fn: any) => { events[event] = fn; }, registerCommand: (_name: string, spec: any) => { command = spec; },
    appendEntry: (_type: string, data: unknown) => { markers.push(data); }, getSessionName: () => undefined, setSessionName() {} } as any;
  const ctx = { mode: "tui", hasUI: true, ui: { notify: (text: string) => notices.push(text) }, modelRegistry: registry(), sessionManager: {
    getSessionId: () => "one", getEntries: () => [],
    getBranch: () => [{ type: "message", message: { role: "user", content: "Fix the naming race" } }],
  } } as any;
  registerAutoname(pi, { ...config, roles: { ...config.roles, tiny: null } }, "Name the task", new AbortController().signal);
  events.session_start({}, ctx); events.message_end({ message: { role: "user" } }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise(setImmediate);
  assert.deepEqual([notices, markers], [[], []], "no warning, and nothing spent: a role configured later still names the session");
  await command.handler("", ctx);
  assert.match(notices[0], /Configure personal\.tiny .* no fallback is allowed/);
});

test("skill drafts stay inactive until the exact diff is approved; stale edits and symlinks fail closed", async (t) => {
  const dir = await temporary(t);
  const candidate = parseCandidates(JSON.stringify([{ action: "create", name: "testing-skills", reason: "Demonstrated procedure", content: skill("testing-skills"), sources: ["s:entry"] }]), new Set(["s:entry"]), 5)[0];
  const draft = await stageCandidate(dir, candidate, []);
  assert.equal(await readSkill(dir, "testing-skills"), null);
  const queue = async (_file: string, fn: () => Promise<any>) => fn();
  await assert.rejects(applyDraft(dir, draft, "not-approved", queue), /Approval/);
  await applyDraft(dir, draft, hash(renderDraft(draft)), queue);
  assert.equal(await readSkill(dir, "testing-skills"), skill("testing-skills"));
  const inventory = await inventorySkills(dir, []);
  const update = await stageCandidate(dir, { ...candidate, action: "update", content: skill("testing-skills", "New steps") }, inventory);
  await atomicWrite(join(dir, "skills/testing-skills/SKILL.md"), skill("testing-skills", "User changes"));
  await assert.rejects(applyDraft(dir, update, hash(renderDraft(update)), queue), /changed since/);
  await assert.rejects(stageCandidate(dir, { ...candidate, action: "update", name: "authored" }, [{ name: "authored", path: "/authored", content: skill("authored"), managed: false }]), /owned skill/);
  await symlink(join(dir, "skills/testing-skills"), join(dir, "skills/escape"));
  await assert.rejects(readSkill(dir, "escape"), /symlink/);
  // A linked agent directory is the user's own layout; only links inside the managed tree are refused.
  await symlink(dir, join(dir, "linked-home"));
  const linked = join(dir, "linked-home");
  assert.equal(await readSkill(linked, "testing-skills"), skill("testing-skills", "User changes"));
  const second = await stageCandidate(linked, { ...candidate, name: "linking-homes", content: skill("linking-homes") }, []);
  await applyDraft(linked, second, hash(renderDraft(second)), queue);
  assert.equal(await readSkill(dir, "linking-homes"), skill("linking-homes"));
  await assert.rejects(readSkill(linked, "escape"), /symlink/);
  assert.throws(() => parseCandidates(JSON.stringify([{ ...candidate, name: "../escape" }]), new Set(["s:entry"]), 5), /Skill names/);
});

test("new skills take gerund names; automation ideas never touch skill files", async (t) => {
  const dir = await temporary(t);
  const parse = (item: object) => parseCandidates(JSON.stringify([{ reason: "Seen three times", sources: ["s:entry"], ...item }]), new Set(["s:entry"]), 1);
  assert.throws(() => parse({ action: "create", name: "pdf-processing", content: skill("pdf-processing") }), /gerund/);
  assert.throws(() => parse({ action: "create", name: "prompting-claude", content: skill("prompting-claude") }), /reserved/);
  assert.equal(parse({ action: "create", name: "processing-pdfs", content: skill("processing-pdfs") })[0].name, "processing-pdfs");
  // Existing skills keep whatever name they already have.
  assert.equal(parse({ action: "update", name: "pdf-processing", content: skill("pdf-processing") })[0].action, "update");
  const [idea] = parse({ action: "automate", name: "release-script", content: "Add `mise run release` wrapping the tag and upload steps.\n" });
  const draft = await stageCandidate(dir, idea, [], "autolearn");
  assert.equal(draft.origin, "autolearn");
  assert.match(renderDraft(draft), /Suggestion only: make these steps deterministic tooling/);
  await assert.rejects(applyDraft(dir, draft, hash(renderDraft(draft)), async (_file, fn) => fn()), /not a pending skill change/);
  assert.deepEqual((await readDrafts(dir)).map((d) => d.id), [draft.id]);
});


test("review input sends managed skills in full and other loaded skills by description", async (t) => {
  const dir = await temporary(t);
  await mkdir(join(dir, "skills", "testing-skills"), { recursive: true });
  await writeFile(join(dir, "skills", "testing-skills", "SKILL.md"), skill("testing-skills", "MANAGED BODY"));
  // Larger than the whole input budget; only its description may be sent.
  const authored = join(dir, "writing-prose", "SKILL.md");
  await mkdir(join(dir, "writing-prose"));
  await writeFile(authored, `---\nname: writing-prose\ndescription: Edits prose.\n---\n${"AUTHORED BODY ".repeat(5000)}\n`);
  const loaded = [{ name: "writing-prose", filePath: authored, description: "Edits prose." }];
  const inventory = await inventorySkills(dir, loaded);
  const text = inventoryInput(inventory, loaded);
  assert.match(text, /MANAGED BODY/);
  assert.doesNotMatch(text, /AUTHORED BODY/);
  assert.ok(text.length < 1000);
  const [managed, other] = JSON.parse(text);
  assert.deepEqual(Object.keys(managed), ["name", "managed", "ref", "content"]);
  assert.deepEqual(other, { name: "writing-prose", managed: false, ref: skillRef(inventory[1]), description: "Edits prose." });
  // A note about an authored skill can still cite it.
  const [note] = parseCandidates(JSON.stringify([{ action: "note", name: "writing-prose", reason: "Overlaps testing-skills", content: "", sources: [other.ref] }]), new Set(inventory.map(skillRef)), 1);
  assert.deepEqual(note.sources, [other.ref]);
});

test("learning uses original branch evidence, excludes thinking, and checkpoints large entries only when complete", () => {
  const evidence = evidenceFromBranch([
    { id: "seen", type: "message", message: { role: "user", content: "already reviewed" } },
    { id: "new", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Observed result" }] } },
    { id: "summary", type: "compaction", summary: "lossy summary" },
    { id: "large", type: "message", message: { role: "toolResult", content: "x".repeat(20000) } },
  ], "session", new Set(["seen"]));
  assert.equal(evidence.length, 2);
  assert.ok(!evidence[0].text.includes("private"));
  const chunks = evidenceChunks(evidence, 4000);
  assert.ok(chunks.every((c) => c.text.length <= 4000));
  assert.ok(!chunks.slice(0, -1).some((c) => c.entryIds.includes("large")));
  assert.ok(chunks.at(-1)?.entryIds.includes("large"));
});

test("children get explicit resource allowlists and inherit parent tool routing", async () => {
  const extension = join(root, "tests/helpers.ts");
  const paths = await childExtensions({ getAllTools: () => [{ name: "read", sourceInfo: { source: "extension", path: extension } }] } as any, config, ["read"], join(root, "extensions/workflows/index.ts"));
  assert.deepEqual(paths, [extension]);
  const args = childArgs("apple-gemini", "gemini-3.8-flash", "low", ["read"], paths, "guard.ts", "instructions.md");
  for (const flag of ["--no-extensions", "--no-skills", "--no-context-files", "--no-approve"]) assert.ok(args.includes(flag));
  assert.ok(args.includes("apple-gemini/gemini-3.8-flash"));
  assert.ok(!args.includes("subagent"));
});

test("researchers load the web tools' extension, which is not sandbox routing", async () => {
  const web = join(root, "extensions/web-search/index.ts"), self = join(root, "extensions/workflows/index.ts");
  const tools = agents.researcher.tools;
  const builtin = (name: string) => ({ name, sourceInfo: { source: "builtin" } });
  const loaded = [...["read", "grep", "find", "ls"].map(builtin), { name: "web_search", sourceInfo: { source: "extension", path: web } }, { name: "web_fetch", sourceInfo: { source: "extension", path: web } }];
  assert.deepEqual(await childExtensions({ getAllTools: () => loaded } as any, config, tools, self), [web]);
  await assert.rejects(childExtensions({ getAllTools: () => loaded.slice(0, 4) } as any, config, tools, self), /not loaded in this Pi: web_search, web_fetch/);
  const required = { ...config, subagents: { ...config.subagents, sandbox: "required" as const } };
  await assert.rejects(childExtensions({ getAllTools: () => loaded } as any, required, tools, self), /No parent tool-routing extension/);
});

test("a child's outcome survives retried errors and takes guard blocks only from the guard's own event", () => {
  const role = { provider: "p", model: "m" };
  const assistant = (stopReason: string, text = "", errorMessage?: string, model = "m") =>
    ({ type: "message_end", message: { role: "assistant", provider: "p", model, stopReason, errorMessage, content: [{ type: "text", text }] } });
  // Tool output that merely contains the marker, such as this extension's own source, is not a block.
  const reading = childOutcome(role);
  reading.event({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: 'reason: "WORKFLOW_GUARD: tool not allowed"' }] } });
  reading.event(assistant("stop", "done"));
  assert.deepEqual([reading.final, reading.text, reading.failure], [true, "done", undefined]);
  assert.throws(() => childOutcome(role).event({ type: "workflow_guard", reason: "turn limit reached" }), /WORKFLOW_GUARD: turn limit reached/);
  // Pi retries a provider error, and compacts after a cut-off reply; the task fails only if nothing follows.
  const retried = childOutcome(role);
  retried.event(assistant("error", "", "529 overloaded"));
  assert.deepEqual([retried.final, retried.failure], [false, "529 overloaded"]);
  retried.event(assistant("stop", "recovered"));
  assert.deepEqual([retried.final, retried.text, retried.failure], [true, "recovered", undefined]);
  const cut = childOutcome(role);
  cut.event(assistant("length"));
  assert.deepEqual([cut.final, cut.failure], [false, "Child stopped: length"]);
  const exhausted = childOutcome(role);
  exhausted.event(assistant("error", "", "529 overloaded"));
  assert.throws(() => exhausted.event({ type: "auto_retry_end", success: false, finalError: "529 overloaded" }), /529 overloaded/);
  assert.throws(() => childOutcome(role).event(assistant("aborted")), /aborted/);
  assert.throws(() => childOutcome(role).event(assistant("stop", "x", undefined, "other")), /unexpected model/);
});

test("workers use separate worktrees, preserve the parent checkout, and reject dirty inputs", async (t) => {
  const dir = await temporary(t);
  const signal = AbortSignal.timeout(10000);
  const git = async (...args: string[]) => {
    const result = await runProcess("git", args, { cwd: dir, signal });
    assert.equal(result.code, 0, result.stderr);
  };
  await git("init", "-q");
  // Only this disposable repository bypasses host hooks, including post-checkout.
  await git("config", "core.hooksPath", await temporary(t));
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "test: created fixture");
  // Worktrees live outside the source repository, as they do in production.
  const worktrees = await temporary(t);
  const [first, second] = await Promise.all([createWorktree(dir, join(worktrees, "first"), signal), createWorktree(dir, join(worktrees, "second"), signal)]);
  await atomicWrite(join(first, "result.txt"), "first");
  await atomicWrite(join(second, "result.txt"), "second");
  assert.equal(await readFile(join(first, "result.txt"), "utf8"), "first");
  await assert.rejects(readFile(join(dir, "result.txt")), { code: "ENOENT" });
  await atomicWrite(join(dir, "dirty.txt"), "uncommitted");
  await assert.rejects(createWorktree(dir, join(worktrees, "third"), signal), /clean repository/);
});

test("workflow locks refuse a live holder and are taken over from a dead one", async (t) => {
  const dir = await temporary(t);
  const lock = join(dir, "commit.lock");
  await withLock(dir, "commit", async () => {
    await assert.rejects(withLock(dir, "commit", async () => "never"), /Workflow is locked/);
  });
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 999999 }));
  await assert.rejects(withLock(dir, "commit", async () => "never", () => true), /Workflow is locked/);
  assert.equal(await withLock(dir, "commit", async () => "taken", (pid) => pid !== 999999), "taken");
  // A holder that has not recorded itself yet is not presumed dead.
  await mkdir(lock);
  await assert.rejects(withLock(dir, "commit", async () => "never"), /Workflow is locked/);
});

test("only one of several contenders takes over a dead holder's lock", async (t) => {
  const dir = await temporary(t);
  for (let round = 0; round < 10; round++) {
    const lock = join(dir, `round-${round}.lock`);
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 999999 }));
    let holders = 0, most = 0;
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => withLock(dir, `round-${round}`, async () => {
      most = Math.max(most, ++holders);
      await new Promise((resolve) => setTimeout(resolve, 15));
      holders--;
    }, (pid) => pid !== 999999)));
    assert.equal(most, 1, "the lock is never held twice");
    for (const result of results) if (result.status === "rejected") assert.match(String(result.reason), /Workflow is locked/);
    await assert.rejects(readFile(join(lock, "owner.json")), { code: "ENOENT" });
  }
  // A takeover gate left by a crash does not disable later takeovers for good.
  const lock = join(dir, "crashed.lock");
  await mkdir(lock); await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 999999 }));
  await mkdir(`${lock}.takeover`);
  await utimes(`${lock}.takeover`, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  await assert.rejects(withLock(dir, "crashed", async () => "never", () => false), /Workflow is locked/);
  assert.equal(await withLock(dir, "crashed", async () => "taken", () => false), "taken");
});

test("auxiliary usage shows in the footer and ignores other entries", () => {
  const entries: any[] = [{ type: "custom", customType: "workflow-title", data: { usage: { totalTokens: 999 } } }];
  const status: Record<string, string | undefined> = {};
  const pi = { appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); } } as any;
  const ctx = { hasUI: true, ui: { setStatus: (key: string, text?: string) => { status[key] = text; } }, sessionManager: { getEntries: () => entries } } as any;
  showAuxiliaryUsage(ctx);
  assert.equal(status.workflows, undefined);
  recordUsage(pi, ctx, { role: "tiny", usage: { totalTokens: 800, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as any });
  assert.equal(status.workflows, "aux 800");
  recordUsage(pi, ctx, { role: "commit", usage: { totalTokens: 11_700, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0421 } } as any });
  assert.equal(status.workflows, "aux 12.5k · $0.042");
  assert.equal(auxiliaryUsage(entries).totalTokens, 12_500);
  assert.equal(formatAuxiliary(auxiliaryUsage([{ type: "custom", customType: "workflow-usage", data: { usage: { totalTokens: 2_000_000, cost: { total: 3.456 } } } }])), "aux 2.0M · $3.46");
  // A context from a replaced session throws; recording must still persist the entry.
  const stale = { hasUI: true, get ui(): any { throw new Error("stale"); }, sessionManager: { getEntries: () => entries } } as any;
  recordUsage(pi, stale, { role: "eval" });
  assert.equal(entries.at(-1).data.role, "eval");
});
