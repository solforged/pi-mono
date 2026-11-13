import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load, matches, mentions, plain, SECTION, section, type Term, TERMS_TYPE, termId, termsMessage, type WikiContext, wikiDir } from "../extensions/memory/context.ts";
import { register, seenTerms, status } from "../extensions/memory/session.ts";
import { command, execute, preview, TOOL } from "../extensions/memory/tool.ts";
import { root, temporary } from "./helpers.ts";

const terms: Term[] = [
  { bundle: "shared", term: "OKF", aliases: ["Open Knowledge Format"], definition: "The bundle format. [Spec](https://example.com/spec)" },
  { bundle: "work", term: "PRR", aliases: ["readiness review"], definition: "The gate before launch. [More](/context/launch.md)" },
  { bundle: "work", term: "Atlas", definition: "The work laptop." },
  { bundle: "work", term: "IT", definition: "The help desk." },
];

const context = (over: Partial<WikiContext> = {}): WikiContext => ({
  scope: "work", reason: "LLM_WIKI_SCOPE",
  bundles: [{ name: "shared", root: "/w/shared" }, { name: "work", root: "/w/work" }],
  now: [{ ref: "work/now.md", bundle: "work", text: "## Stack\n\n* Billing: Go on Kubernetes.", bytes: 38, limit: 2000, truncated: false, stale: false, staleAfter: "2026-11-23T12:00:00Z" }],
  terms, ...over,
});

test("the wiki directory honors an absolute LLM_WIKI_DIR only", () => {
  assert.equal(wikiDir({ LLM_WIKI_DIR: "/srv/wiki" }), "/srv/wiki");
  assert.match(wikiDir({ LLM_WIKI_DIR: "relative" }), /\.local\/share\/wiki$/);
});

test("terms match whole words; acronyms and short keys match their case", () => {
  assert.ok(mentions("Is the PRR done?", "PRR"));
  assert.ok(!mentions("is the prr done?", "PRR"));
  assert.ok(!mentions("PRRs", "PRR"), "not a whole word");
  assert.ok(mentions("before the Readiness\nReview", "readiness review"), "case and whitespace in a phrase");
  assert.ok(mentions("on atlas today", "Atlas"));
  assert.ok(!mentions("is it done", "IT"));
  assert.ok(!mentions("x", " "));
  assert.deepEqual(matches("Ask IT about the PRR in the Open Knowledge Format", terms).map(t => t.term), ["OKF", "PRR", "IT"]);
  assert.deepEqual(matches("PRR and OKF", terms, new Set([termId(terms[1])])).map(t => t.term), ["OKF"]);
});

test("definitions name wiki paths that read accepts", () => {
  assert.equal(plain("Gate. [More](/context/launch.md#why)", "work"), "Gate. More (work/context/launch.md)");
  assert.equal(plain("See [x](notes/a.md)"), "See x (notes/a.md)");
  assert.equal(plain("[Spec](https://example.com/spec)", "shared"), "Spec (https://example.com/spec)");
  assert.equal(termsMessage([terms[1]]), "The user's glossary defines terms in this message:\n- **PRR** (readiness review) [work]: The gate before launch. More (work/context/launch.md)");
});

test("the section carries now.md, staleness and the on-demand commands", () => {
  const text = section(context(), "/w/bin/wiki")!;
  assert.match(text, /^Current context from the user's memory wiki \(work\/now\.md\)/);
  assert.match(text, /\* Billing: Go on Kubernetes\./);
  assert.match(text, /`\/w\/bin\/wiki -scope work` with `search <words>`/);
  assert.match(section(context(), join(homedir(), ".local/share/wiki/bin/wiki"))!, /`~\/\.local\/share\/wiki\/bin\/wiki -scope work`/);
  assert.match(text, /never write to it unasked/);
  assert.doesNotMatch(text, /refresh/);
  const stale = section(context({ now: [{ ...context().now[0], stale: true, truncated: true }] }), "wiki")!;
  assert.match(stale, /due for a refresh on 2026-11-23/);
  assert.match(stale, /over its 2000-byte limit/);
  assert.equal(section(context({ scope: "", now: [] }), "wiki"), undefined);
  const tool = section(context(), "/w/bin/wiki", true)!;
  assert.match(tool, /with the `memory` tool \(search, read, define, recent\)/);
  assert.match(tool, /record it with `memory` \(term, jot or now\); never write unasked/);
  assert.doesNotMatch(tool, /bin\/wiki/);
  assert.doesNotMatch(section(context({ now: [] }), "wiki")!, /Current context/);
});

async function fakeWiki(t: any, output: string, code = 0) {
  const dir = await temporary(t);
  const binary = join(dir, "wiki");
  // Like the real one, it prints JSON on success and an error on stderr.
  await writeFile(binary, `#!/bin/sh\n[ "$1" = context ] || exit 2\ncat <<'JSON' >&${code ? 2 : 1}\n${output}\nJSON\nexit ${code}\n`);
  await chmod(binary, 0o755);
  return { dir, binary };
}

test("load reports a missing binary apart from a failing one", async t => {
  const missing = await load("/nonexistent/wiki", "/");
  assert.ok(missing.missing && !missing.context);
  const { dir, binary } = await fakeWiki(t, "wiki: no shared bundle", 1);
  const failed = await load(binary, dir);
  assert.ok(!failed.missing && /no shared bundle/.test(failed.error!));
  const ok = await load((await fakeWiki(t, JSON.stringify(context()))).binary, dir);
  assert.equal(ok.context?.scope, "work");
});

function harness(binary: string, entries: any[] = [], active = ["read", TOOL]) {
  const handlers: Record<string, (event: any, ctx: any) => any> = {}, commands: Record<string, any> = {}, notes: [string, string][] = [];
  const pi = {
    on: (name: string, handler: any) => { handlers[name] = handler; },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    registerMessageRenderer: () => {},
    registerCommand: (name: string, command: any) => { commands[name] = command; },
  };
  register(pi as any, binary);
  const ctx = { cwd: "/", hasUI: true, ui: { notify: (text: string, level: string) => notes.push([level, text]) }, sessionManager: { buildContextEntries: () => entries } };
  const prompt = async (text: string, sections: Record<string, string> = {}, messageType = "user") => {
    const result = await handlers.before_agent_start({ messageType, prompt: text, systemPromptOptions: { sections, selectedTools: active } }, ctx);
    if (result?.message) entries.push({ type: "custom_message", ...result.message });
    return { sections, message: result?.message };
  };
  return { handlers, commands, notes, ctx, prompt, entries, active: () => active };
}

test("each prompt refreshes the section and defines a new term once", async t => {
  const { binary } = await fakeWiki(t, JSON.stringify(context()));
  const h = harness(binary);
  const first = await h.prompt("Where is the PRR for billing?", { [SECTION]: "old", other: "kept" });
  assert.match(first.sections[SECTION], /Billing: Go on Kubernetes/);
  assert.match(first.sections[SECTION], /`memory` tool/, "the tool is active");
  assert.equal(first.sections.other, "kept");
  assert.equal(first.message.customType, TERMS_TYPE);
  assert.deepEqual(first.message.details, { terms: ["work/prr"], names: ["PRR"] });
  assert.equal((await h.prompt("And the PRR owner?")).message, undefined, "already in context");
  assert.deepEqual(seenTerms(h.entries), new Set(["work/prr"]));
  assert.equal((await h.prompt("PRR", {}, "custom")).message, undefined, "custom runs are not prompts");
  assert.deepEqual(h.notes, []);

  // After compaction drops the definition, the next mention brings it back.
  h.entries.length = 0;
  assert.ok((await h.prompt("PRR again")).message);
});

test("stale or oversized context and a broken wiki warn once; a machine without one stays quiet", async t => {
  const now = [{ ...context().now[0], stale: true, truncated: true, bytes: 2500 }];
  const h = harness((await fakeWiki(t, JSON.stringify(context({ now })))).binary);
  await h.prompt("one");
  await h.prompt("two");
  assert.deepEqual(h.notes.map(([, text]) => text.split(" ").slice(0, 4).join(" ")), ["work/now.md was due for", "work/now.md is 2500 bytes,"]);

  const broken = harness((await fakeWiki(t, "wiki: no shared bundle", 1)).binary);
  const { sections } = await broken.prompt("x", { [SECTION]: "old" });
  assert.equal(sections[SECTION], undefined);
  assert.match(broken.notes[0][1], /no shared bundle/);

  const scope = process.env.LLM_WIKI_SCOPE;
  delete process.env.LLM_WIKI_SCOPE;
  t.after(() => { if (scope !== undefined) process.env.LLM_WIKI_SCOPE = scope; });
  const absent = harness("/nonexistent/wiki");
  await absent.prompt("x");
  assert.deepEqual(absent.notes, []);
});

test("/memory reports the scope, now.md and the terms in context", async t => {
  const { binary } = await fakeWiki(t, JSON.stringify(context()));
  const h = harness(binary);
  await h.prompt("PRR?");
  await h.commands.memory.handler("", h.ctx);
  const report = h.notes.at(-1)![1];
  assert.match(report, /^Scope: work \(LLM_WIKI_SCOPE\)/);
  assert.match(report, /work\/now\.md, 38\/2000 bytes, refresh due 2026-11-23\n/);
  assert.match(report, /4 terms in view; defined in context: PRR/);
  assert.match(status(undefined, binary, new Set()), /not loaded yet/);
  assert.match(status({ context: context({ now: [] }) }, "wiki", new Set()), /fill in now\.md in the work bundle \(`wiki -scope work init` creates it if missing\)/);
});

async function installedPi(t: any, ...prompts: string[]) {
  const wiki = await temporary(t);
  await mkdir(join(wiki, "bin"));
  const json = JSON.stringify(context({ now: [{ ...context().now[0], text: "* Billing runs on queues." }] }));
  await writeFile(join(wiki, "bin", "wiki"), `#!/bin/sh\nif [ "$1" = context ]; then cat <<'JSON'\n${json}\nJSON\nelse echo "wiki $*"; fi\n`);
  await chmod(join(wiki, "bin", "wiki"), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, LLM_WIKI_DIR: wiki };
  for (const key of ["PI_REX_CHILD", "PI_WORKFLOW_CHILD_CONFIG", "LLM_WIKI_SCOPE"]) delete env[key];
  return spawnSync("pi", ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session",
    "-e", join(root, "extensions/memory/index.ts"), "-e", join(root, "tests/fixtures/memory-provider.ts"),
    "--provider", "memory-smoke", "--model", "memory-smoke/fixture", "-p", ...prompts], { cwd: root, encoding: "utf8", timeout: 30000, env });
}

test("installed Pi puts now.md in the system prompt and a definition in the conversation once", async t => {
  const run = await installedPi(t, "Is the PRR done?", "What about the PRR owner?");
  if (run.error && (run.error as any).code === "ENOENT") { t.skip("Pi is not installed"); return; }
  assert.equal(run.status, 0, run.stderr || run.stdout);
  // Print mode shows the last reply: both prompts are in context, the definition once.
  assert.match(run.stdout, /SECTION present DEFINITIONS 1 PROMPTS 2/);
});

test("installed Pi runs memory lookups, and refuses a write it cannot confirm", async t => {
  const lookup = await installedPi(t, "lookup");
  if (lookup.error && (lookup.error as any).code === "ENOENT") { t.skip("Pi is not installed"); return; }
  assert.equal(lookup.status, 0, lookup.stderr || lookup.stdout);
  assert.match(lookup.stdout, /TOOL OK wiki define PRR/);
  const write = await installedPi(t, "write");
  assert.match(write.stdout, /TOOL ERROR .*needs the user's confirmation/);
});

test("the tool is withdrawn where the wiki is not built", async t => {
  const missing = harness("/nonexistent/wiki");
  missing.handlers.session_start({}, missing.ctx);
  assert.deepEqual(missing.active(), ["read"]);
  const built = harness((await fakeWiki(t, JSON.stringify(context()))).binary);
  built.handlers.session_start({}, built.ctx);
  assert.deepEqual(built.active(), ["read", TOOL]);
});

test("tool actions map to wiki arguments; flags cannot be smuggled in as a term", () => {
  assert.deepEqual(command({ action: "search", words: " deploy  vpn " }), { args: ["search", "deploy", "vpn"] });
  assert.deepEqual(command({ action: "read", paths: ["work/now.md", " "] }), { args: ["read", "work/now.md"] });
  assert.deepEqual(command({ action: "define" }), { args: ["define"] });
  assert.deepEqual(command({ action: "define", term: "PRR" }), { args: ["define", "PRR"] });
  assert.deepEqual(command({ action: "recent" }), { args: ["recent"] });
  assert.deepEqual(command({ action: "jot", text: "Staging needs the VPN." }), { args: ["jot", "Staging needs the VPN."] });
  assert.deepEqual(command({ action: "term", term: "-replace", text: "Odd.", aliases: ["a", " "], replace: true }), { args: ["term", "-aliases", "a", "-replace", "--", "-replace", "Odd."] });
  assert.deepEqual(command({ action: "now", text: "## Lately\n\n* x" }), { args: ["now", "-set"], input: "## Lately\n\n* x" });
  for (const p of [{ action: "search" }, { action: "read", paths: [] }, { action: "jot", text: " " }, { action: "term", term: "X" }, { action: "now" }, { action: "drop" }] as any[]) {
    assert.throws(() => command(p), /required|Unknown/);
  }
  assert.deepEqual(preview({ action: "term", term: "PRR", aliases: ["readiness review"], text: "The gate." }, "work"), { title: "Add to the work glossary?", body: "**PRR** (readiness review): The gate." });
  assert.equal(preview({ action: "jot", text: "x" }, "").title, "Jot in this scope's journal?");
  assert.equal(preview({ action: "term", term: "X", text: "y", replace: true }, "work").title, "Change an entry in the work glossary?");
  assert.match(preview({ action: "now", text: "* é" }, "work").body, /^\* é\n\n4 bytes\./);
  assert.equal(preview({ action: "now", text: "x" }, "work").title, "Replace work/now.md?");
});

test("reads run directly; writes run only after the user confirms", async t => {
  const dir = await temporary(t);
  const binary = join(dir, "wiki"), log = join(dir, "calls");
  await writeFile(binary, `#!/bin/sh\necho "$*" >> ${log}\n[ "$1" = now ] && { echo "stdin: $(cat)"; exit 0; }\n[ "$1" = fail ] && { echo "wiki: the work bundle is not present" >&2; exit 1; }\necho "ran $*"\n`);
  await chmod(binary, 0o755);
  const asked: string[] = [];
  const yes = async (title: string) => { asked.push(title); return true; };
  assert.equal(await execute(binary, { action: "search", words: "vpn" }, dir, "work", undefined), "ran search vpn");
  assert.equal(await execute(binary, { action: "jot", text: "x" }, dir, "work", async () => false), "The user declined; nothing was written.");
  await assert.rejects(execute(binary, { action: "jot", text: "x" }, dir, "work", undefined), /needs the user's confirmation/);
  assert.equal(await execute(binary, { action: "now", text: "* Queues." }, dir, "work", yes), "stdin: * Queues.");
  assert.deepEqual(asked, ["Replace work/now.md?"]);
  assert.equal((await readFile(log, "utf8")).trim(), "search vpn\nnow -set");
  await assert.rejects(execute(binary, { action: "define", term: "x" } as any, "/nonexistent-dir", "", undefined));
  await writeFile(binary, `#!/bin/sh\necho "wiki: the work bundle is not present" >&2\nexit 1\n`);
  await assert.rejects(execute(binary, { action: "recent" }, dir, "", undefined), { message: "the work bundle is not present" });
});
