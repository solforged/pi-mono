import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadTitlePrompt, parseTitle, registerAutoname } from "../extensions/workflows/autoname.ts";
import { applyDraft, evidenceChunks, evidenceFromBranch, inventorySkills, parseCandidates, renderDraft, stageCandidate } from "../extensions/workflows/learning.ts";
import { atomicWrite, hash, readSkill } from "../extensions/workflows/state.ts";
import { childArgs, childExtensions, createWorktree } from "../extensions/workflows/subagents.ts";
import { runProcess } from "../extensions/workflows/process.ts";
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

test("skill drafts stay inactive until the exact diff is approved; stale edits and symlinks fail closed", async (t) => {
  const dir = await temporary(t);
  const candidate = parseCandidates(JSON.stringify([{ action: "create", name: "test-skill", reason: "Demonstrated procedure", content: skill(), sources: ["s:entry"] }]), new Set(["s:entry"]), 5)[0];
  const draft = await stageCandidate(dir, candidate, []);
  assert.equal(await readSkill(dir, "test-skill"), null);
  const queue = async (_file: string, fn: () => Promise<any>) => fn();
  await assert.rejects(applyDraft(dir, draft, "not-approved", queue), /Approval/);
  await applyDraft(dir, draft, hash(renderDraft(draft)), queue);
  assert.equal(await readSkill(dir, "test-skill"), skill());
  const inventory = await inventorySkills(dir, []);
  const update = await stageCandidate(dir, { ...candidate, action: "update", content: skill("test-skill", "New steps") }, inventory);
  await atomicWrite(join(dir, "skills/test-skill/SKILL.md"), skill("test-skill", "User changes"));
  await assert.rejects(applyDraft(dir, update, hash(renderDraft(update)), queue), /changed since/);
  await assert.rejects(stageCandidate(dir, { ...candidate, action: "update", name: "authored" }, [{ name: "authored", path: "/authored", content: skill("authored"), managed: false }]), /owned skill/);
  await symlink(join(dir, "skills/test-skill"), join(dir, "skills/escape"));
  await assert.rejects(readSkill(dir, "escape"), /symlink/);
  assert.throws(() => parseCandidates(JSON.stringify([{ ...candidate, name: "../escape" }]), new Set(["s:entry"]), 5), /Skill names/);
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
