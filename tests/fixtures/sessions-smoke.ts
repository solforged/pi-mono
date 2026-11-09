// Explicitly loaded only by the regression suite. No model or network calls.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import install from "../../extensions/sessions/index.ts";

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const colored = { fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[39m`, bold: (text: string) => `\u001b[1m${text}\u001b[22m` };
function render(component: any) {
  const first = component.render(80);
  for (const width of [80, 40, 20, 8, 2, 80]) {
    for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} columns exceed width ${width}: ${line}`);
  }
  assert.deepEqual(component.render(80), first, "resizing must not retain stale layout");
  return first.map((line: string) => line.trimEnd()).join("\n");
}
function renderContext(args = {}, isError = false, lastComponent?: any) {
  return { args, isError, lastComponent, state: {}, keyHint(key: string, label: string) {
    assert.equal(key, "app.tools.expand"); return `alt+x ${label}`;
  } };
}
function checkViews(tools: any[], search: any, read: any) {
  const searchData = JSON.parse(search.content[0].text), readData = JSON.parse(read.content[0].text);
  const payload = (data: any) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
  const examples = [
    [search, payload({ ...searchData, hits: [], matching_entries: 0 }), payload({ ...searchData, has_more: true, coverage: { ...searchData.coverage, complete: false, warnings: ["Cannot read archive"], warningCount: 1 } })],
    [read, payload({ ...readData, next: { session_id: "smoke-past", entry_id: "entry", offset: 3, column: 1, revision: readData.revision }, text: "L1: Header\nL2: 🙂漢字 e\u0301 👩🏽‍💻 ".repeat(20) }), payload({ ...readData, text: undefined, branches: [{ leaf_id: "a".repeat(128), timestamp: readData.timestamp }], branches_truncated: true })],
  ];
  const unchanged = JSON.stringify([search, read]);
  for (const [i, tool] of tools.entries()) {
    const args = i ? { session_id: "saved漢字🙂".repeat(20), entry_id: "a".repeat(128), offset: 3 } : { query: "検索 👩🏽‍💻 e\u0301 ".repeat(20), scope: "all" };
    for (const theme of [plain, colored]) {
      const call = tool.renderCall(args, theme, renderContext(args)); render(call);
      assert.equal(tool.renderCall({}, theme, renderContext({}, false, call)), call);
      render(call);
      for (const sample of examples[i]) {
        const old = JSON.parse(JSON.stringify(sample)); delete old.details;
        const collapsed = tool.renderResult(old, { expanded: false, isPartial: false }, theme, renderContext(args));
        render(collapsed);
        const expanded = tool.renderResult(old, { expanded: true, isPartial: false }, theme, renderContext(args, false, collapsed));
        assert.equal(expanded, collapsed); render(expanded);
      }
      render(tool.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme, renderContext(args)));
      render(tool.renderResult({ content: [{ type: "text", text: "Cannot read\u001b[2J" }] }, { expanded: false }, theme, renderContext(args, true)));
      render(tool.renderResult(payload({ unexpected: true }), { expanded: true }, theme, renderContext(args)));
    }
  }
  const collapsed = render(tools[0].renderResult(search, { expanded: false }, plain, renderContext()));
  assert.match(collapsed, /1 match · 1 session/); assert.match(collapsed, /alt\+x to expand/);
  assert.ok(!collapsed.includes('"session_id"'));
  assert.match(render(tools[0].renderResult(search, { expanded: true }, plain, renderContext())), /Session: smoke-past/);
  assert.match(render(tools[1].renderResult(read, { expanded: true }, plain, renderContext())), /smoke lexical decision/);
  assert.equal(JSON.stringify([search, read]), unchanged, "rendering must not change persisted or model-facing results");
}

export default function (pi: ExtensionAPI) {
  const tools: any[] = [];
  install({ ...pi, registerTool(definition: any) { tools.push(definition); pi.registerTool(definition); } });
  pi.registerCommand("sessions-smoke", {
    description: "Exercise session tools offline with synthetic history",
    handler: async (_args, ctx) => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-sessions-smoke-")));
      const previous = process.env.PI_CODING_AGENT_DIR;
      try {
        process.env.PI_CODING_AGENT_DIR = dir;
        const store = join(dir, "sessions", "project"); await mkdir(store, { recursive: true });
        const date = "2026-01-01T00:00:00.000Z";
        await writeFile(join(store, "past.jsonl"), [
          { type: "session", version: 3, id: "smoke-past", cwd: ctx.cwd, timestamp: date },
          { type: "message", id: "entry", parentId: null, timestamp: date, message: { role: "user", content: "smoke lexical decision" } },
        ].map(v => JSON.stringify(v)).join("\n") + "\n");
        assert.deepEqual(tools.map(t => t.name), ["session_search", "session_read"]);
        // Every request carries both declarations; keep them small.
        for (const [tool, budget] of [[tools[0], 520], [tools[1], 620]]) {
          const size = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length;
          assert.ok(size <= budget, `${tool.name} declaration grew to ${size} characters`);
          assert.equal(tool.promptSnippet ?? tool.promptGuidelines, undefined);
        }
        assert.ok(pi.getAllTools().some(t => t.name === "session_search"));
        const fake = { ...ctx, sessionManager: { getSessionDir: () => store, getSessionId: () => "live", getSessionFile: () => undefined } };
        const search = await tools[0].execute("search", { query: "smoke decision" }, undefined, undefined, fake);
        assert.equal(JSON.parse(search.content[0].text).hits[0].entry_id, "entry");
        const read = await tools[1].execute("read", { session_id: "smoke-past", entry_id: "entry" }, undefined, undefined, fake);
        assert.match(JSON.parse(read.content[0].text).text, /smoke lexical decision/);
        checkViews(tools, search, read);
        assert.equal(tools[1].annotations.readOnlyHint, true);
        console.log("Session integration: bundled imports, registration, search, retrieval, compact/expanded rendering, narrow widths, Unicode and noninteractive execution passed");
      } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        await rm(dir, { recursive: true, force: true });
      }
    },
  });
}
