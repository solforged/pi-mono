import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { ENTRY, explicitSelection, groups, register, SEARCH, section, SECTION } from "../extensions/deferred-tools/index.ts";
import { root, noModel } from "./helpers.ts";

const sessions = { name: "sessions", description: "Search and read earlier Pi sessions" };
const tools = [
  { name: "read", exposure: "direct" },
  { name: SEARCH, exposure: "model-only" },
  { name: "session_search", exposure: "deferred", namespace: sessions, description: "Search." },
  { name: "session_read", exposure: "deferred", namespace: sessions, description: "Read." },
  { name: "loose_tool", exposure: "deferred", description: "Does one thing. Then more detail." },
  { name: "mcp__docs__fetch", exposure: "deferred", namespace: { name: "mcp__docs", description: "Docs server" } },
  { name: "script_only", exposure: "codemode", namespace: { name: "scripts", description: "Codemode only" } },
];

function harness({ all = tools, active = ["read", "bash"], branch = [] as any[], argv = ["node", "pi"] } = {}) {
  const handlers: Record<string, (event: any, ctx?: any) => unknown> = {}, entries: [string, unknown][] = [];
  const pi = {
    on: (name: string, handler: any) => { handlers[name] = handler; },
    getAllTools: () => all,
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    appendEntry: (type: string, data: unknown) => { entries.push([type, data]); branch = [...branch, { type: "custom", customType: type, data }]; },
  };
  register(pi as any, argv);
  const start = () => handlers.session_start({}, { sessionManager: { getBranch: () => branch } });
  const prompt = (sections: Record<string, string> = {}) => {
    const options = { selectedTools: active, sections };
    handlers.before_agent_start({ systemPromptOptions: options });
    return options.sections;
  };
  return { start, prompt, entries, active: () => active };
}

test("deferred extension tools are grouped by namespace; MCP and codemode tools are not listed", () => {
  assert.deepEqual(groups(tools), [["loose_tool", "Does one thing."], ["sessions", "Search and read earlier Pi sessions"]]);
  assert.equal(section(tools), [
    "Tool groups available on demand, not declared until loaded. Load the ones a task needs with `tool_search`:",
    "- loose_tool: Does one thing.",
    "- sessions: Search and read earlier Pi sessions",
  ].join("\n"));
  assert.equal(section(tools.filter(t => t.exposure !== "deferred" || t.name.startsWith("mcp__"))), undefined);
});

test("tool_search is turned on once per branch, and left alone after that", () => {
  const h = harness();
  h.start();
  assert.deepEqual(h.active(), ["read", "bash", SEARCH]);
  assert.deepEqual(h.entries, [[ENTRY, { activated: SEARCH }]]);

  const off = harness({ branch: [{ type: "custom", customType: ENTRY }] });
  off.start();
  assert.deepEqual(off.active(), ["read", "bash"], "a later /tools choice stands");

  const on = harness({ active: ["read", SEARCH] });
  on.start();
  assert.deepEqual(on.entries, [], "already active: nothing to record");
});

test("an explicit tool selection, missing tool_search or no deferred tools leave the tools as they are", () => {
  for (const argv of [["pi", "--tools", "read,bash"], ["pi", "-t", "read"], ["pi", "--tools=read"], ["pi", "--no-tools"], ["pi", "-nbt"]]) {
    assert.ok(explicitSelection(argv), argv.join(" "));
    const h = harness({ argv });
    h.start();
    assert.deepEqual(h.active(), ["read", "bash"]);
  }
  assert.ok(!explicitSelection(["pi", "-p", "--tools is mentioned in the prompt"]));
  for (const all of [tools.filter(t => t.name !== SEARCH), tools.filter(t => t.exposure !== "deferred")]) {
    const h = harness({ all });
    h.start();
    assert.deepEqual(h.active(), ["read", "bash"]);
  }
});

test("the prompt lists deferred groups only while tool_search is active", () => {
  const h = harness();
  assert.deepEqual(h.prompt({ [SECTION]: "stale", other: "kept" }), { other: "kept" });
  h.start();
  const sections = h.prompt({ other: "kept" });
  assert.match(sections[SECTION], /^- sessions: /m);
  assert.equal(sections.other, "kept");
});

test("installed Pi turns on tool_search and lists the deferred session tools", t => {
  const env = { ...process.env };
  for (const key of ["PI_REX_CHILD", "PI_WORKFLOW_CHILD_CONFIG"]) delete env[key];
  const extensions = ["builtin:tool-search", "extensions/sessions/index.ts", "extensions/deferred-tools/index.ts", "tests/fixtures/deferred-tools-smoke.ts"];
  const check = spawnSync("pi", ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session",
    ...extensions.flatMap(path => ["-e", path.startsWith("builtin:") ? path : join(root, path)]), ...noModel, "-p", "/deferred-tools-smoke"], { cwd: root, encoding: "utf8", timeout: 30000, env });
  if (check.error && (check.error as any).code === "ENOENT") { t.skip("Pi is not installed"); return; }
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /Deferred tools integration: passed/);
});

test("eval tasks need only tools the mock catalog has, and are graded on what the mocks returned", async () => {
  const { MOCKS, GROUPS, TASKS } = await import("../scripts/deferred-tools-tasks.ts");
  const { grade, outcome, presetModels, parseModel, report } = await import("../scripts/deferred-tools-eval.ts");
  const names = new Set(MOCKS.map(m => m.name));
  for (const task of TASKS) for (const tool of [...task.expect, ...Object.keys(task.args ?? {})]) assert.ok(names.has(tool), `${task.id} needs ${tool}`);
  for (const mock of MOCKS) assert.ok(GROUPS[mock.group], mock.name);

  const jira = TASKS.find(t => t.id === "jira")!, slack = TASKS.find(t => t.id === "slack")!, db = TASKS.find(t => t.id === "db")!;
  const ran = (tool: string, params = {}) => ({ ev: "mock_exec", tool, params });
  const search = { ev: "tool_call", tool: "tool_search", input: { query: "jira issue" } };
  assert.deepEqual(grade(jira, [search, ran("jira_issue_get")], "Assigned to Dana Whitfield.", {}), { found: true, pass: true, ran: ["jira_issue_get"], searches: ["jira issue"] });
  assert.equal(grade(jira, [ran("jira_issue_get")], "In review.", {}).pass, false, "the reply must use the result");
  assert.equal(grade(jira, [], "Dana Whitfield", {}).found, false);
  assert.equal(grade(slack, [ran("slack_post_message", { channel: "#general" })], "", {}).pass, false);
  assert.equal(grade(slack, [ran("slack_post_message", { channel: "#deploys" })], "", {}).pass, true);
  assert.equal(grade(db, [ran("db_describe_table")], "", { "report.sql": "SUM(l.amt_cents) ... h.cust_ref" }).pass, true);
  assert.equal(grade(db, [ran("db_describe_table")], "", { "report.sql": "SUM(total)" }).pass, false);

  const end = (message: any) => JSON.stringify({ type: "message_end", message: { role: "assistant", ...message } });
  assert.deepEqual(outcome([end({ content: [{ type: "text", text: "a" }], usage: { cost: { total: 0.5 } } }), "noise", end({ content: [], usage: { cost: { total: 0.25 } } })].join("\n")),
    { reply: "a", cost: 0.75, error: undefined });
  assert.equal(outcome(end({ stopReason: "error", errorMessage: "400 too old", content: [] })).error, "400 too old");

  const roles = { profiles: { p: { presets: {
    a: { main: { provider: "anthropic", model: "big", thinking: "high" }, roles: { tiny: { provider: "anthropic", model: "small", thinking: "low" } } },
    b: { main: { provider: "openai", model: "x" }, roles: { task: { provider: "anthropic", model: "big", thinking: "low" } } } } } } };
  assert.deepEqual(presetModels(roles), [{ id: "anthropic/big", thinking: "high" }, { id: "anthropic/small", thinking: "low" }, { id: "openai/x", thinking: undefined }]);
  assert.deepEqual(parseModel("openai/gpt:high"), { id: "openai/gpt", thinking: "high" });
  assert.throws(() => parseModel("gpt"), /provider\/model/);

  const row = (arm: string, task: string, pass: boolean, extra = {}) => ({ model: "openai/x", arm, task, run: 1, pass, found: pass, searches: pass && arm !== "direct" ? ["q"] : [], ran: [], cost: 0.01, seconds: 2, ...extra });
  const text = report([row("deferred", "jira", false), row("index", "jira", true), row("direct", "jira", true), row("index", "ctrl_math", true, { searches: [] }),
    { ...row("index", "jira", false), model: "anthropic/old", error: "400 too old" }] as any);
  assert.match(text, /openai\/x\s+0% 0% 0\.0\s+100% 100% 0\.5\s+100% 100% 0\.0/);
  assert.match(text, /jira \(explicit\): x: deferred/);
  assert.match(text, /anthropic\/old: 400 too old/);
});
