import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { declarationSize, dropRepeatedRules, measure, owner, REPEATED_RULES, report, sections, withoutRepeatedRules } from "../extensions/prompt-size/measure.ts";
import { switchTools } from "../extensions/rex/tools.ts";
import { root } from "./helpers.ts";

test("prompts are measured by section and tools by owning extension", () => {
  assert.deepEqual(sections("intro <tools>\n- a\n</tools>\n<rules>r</rules>"), [{ name: "tools", chars: 20 }, { name: "rules", chars: 16 }, { name: "other", chars: 7 }]);
  assert.equal(owner({ name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } }), "pi");
  assert.equal(owner({ name: "x", sourceInfo: { path: "/home/u/.pi/agent/extensions/rex/index.ts" } }), "rex");
  assert.equal(owner({ name: "x", sourceInfo: { path: "/tmp/probe.ts" } }), "probe");
  const tool = { name: "t", description: "d", parameters: { type: "object" } };
  assert.equal(declarationSize(tool), JSON.stringify(tool).length);
  const m = measure("<rules>r</rules>", [tool, { ...tool, name: "u", sourceInfo: { source: "builtin" } }]);
  assert.deepEqual([m.promptChars, m.toolChars, m.total, m.owners.map(o => o.name)], [16, 2 * declarationSize(tool), 16 + 2 * declarationSize(tool), ["unknown", "pi"]]);
  assert.match(report(m), /^Fixed prompt: 0\.1 KB \(~\d+ tokens\)[\s\S]*Tool declarations by extension:[\s\S]* {2}unknown: t \d+/);
  assert.doesNotMatch(report(m), /Inactive/);
  assert.match(report(measure("", [], [{ ...tool, name: "ask_user_question" }])), /Inactive here, not counted: ask_user_question \d+/);
});

test("Pi rules that repeat a tool description are dropped and not measured", () => {
  const [rule] = REPEATED_RULES.edit;
  const guidelines: Record<string, string[]> = { edit: ["Use edit for targeted changes.", rule], read: [rule] };
  dropRepeatedRules(guidelines);
  assert.deepEqual(guidelines, { edit: ["Use edit for targeted changes."], read: [rule] });
  dropRepeatedRules(undefined);
  assert.equal(withoutRepeatedRules(`<rules>\n- a\n- ${rule}\n- b\n</rules>`), "<rules>\n- a\n- b\n</rules>");
});

test("one delegation tool per session, restoring only what the switch removed", () => {
  const all = ["read", "subagent", "rex_agent", "rex_send", "rex_result"];
  // Outside Rex: the Rex tools go; a later start inside Rex brings them back and drops subagent.
  let s = switchTools(all, all, false, []);
  assert.deepEqual([s.active, s.removed, s.changed, s.recordChanged], [["read", "subagent"], ["rex_agent", "rex_result", "rex_send"], true, true]);
  s = switchTools(s.active, all, true, s.removed);
  assert.deepEqual([s.active.sort(), s.removed], [["read", "rex_agent", "rex_result", "rex_send"], ["subagent"]]);
  s = switchTools(s.active, all, false, s.removed);
  assert.deepEqual([s.active.sort(), s.removed], [["read", "subagent"], ["rex_agent", "rex_result", "rex_send"]]);
  // Nothing to do is no change; tools the user turned off stay off.
  assert.deepEqual(switchTools(["read", "subagent"], all, false, ["rex_agent", "rex_result", "rex_send"]), { active: ["read", "subagent"], removed: ["rex_agent", "rex_result", "rex_send"], changed: false, recordChanged: false });
  assert.deepEqual(switchTools(["read"], all, false, []).active, ["read"]);
  assert.deepEqual(switchTools(["read", "rex_agent"], all, true, []).active, ["read", "rex_agent"]);
  // Without the workflows extension, nothing about subagent is recorded.
  assert.deepEqual(switchTools(["rex_agent"], ["rex_agent"], true, []).removed, []);
});

test("installed Pi keeps every repo tool declaration within budget", t => {
  const env = { ...process.env };
  for (const key of ["PI_REX_CHILD", "PI_WORKFLOW_CHILD_CONFIG", "REX_SESSION", "REX_BLOCK"]) delete env[key];
  const extensions = ["artifacts", "ask", "figure", "goal", "intercom", "rex", "sessions", "todo", "web-search", "workflows"].flatMap(name => ["-e", join(root, "extensions", name, "index.ts")]);
  const check = spawnSync("pi", ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", ...extensions, "-e", join(root, "tests/fixtures/prompt-size-smoke.ts"), "-p", "/prompt-size-smoke"], { cwd: root, encoding: "utf8", timeout: 30000, env });
  if (check.error && (check.error as any).code === "ENOENT") { t.skip("Pi is not installed"); return; }
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /Prompt size:.*passed/);
});
