// Explicitly loaded only by the regression suite. No model or network calls.
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import install from "../../extensions/todo/index.ts";
import { restore } from "../../extensions/todo/store.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const render = (component: any) => component.render(200).map((line: string) => line.trimEnd()).join("\n");

export default function (pi: ExtensionAPI) {
  const entries: any[] = [], events: Record<string, any> = {}, commands: Record<string, any> = {}, renderers: Record<string, any> = {};
  let tool: any, active = ["todo"];
  install({
    on: (event: string, fn: any) => { events[event] = fn; },
    registerTool: (definition: any) => { tool = definition; pi.registerTool(definition); },
    registerCommand: (name: string, options: any) => { commands[name] = options; },
    registerMessageRenderer: (type: string, fn: any) => { renderers[type] = fn; },
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
    getActiveTools: () => active,
  } as any);

  pi.registerCommand("todo-smoke", {
    description: "Exercise the todo extension offline against a stand-in session",
    handler: async (_args, ctx) => {
      const log = console.log;
      try {
        const fake = { ...ctx, mode: "print", hasUI: false, sessionManager: { getBranch: () => entries } };
        const ui = { ...fake, hasUI: true };
        const run = async (params: any) => {
          const result = await tool.execute("call", params, undefined, undefined, fake);
          entries.push({ type: "message", message: { role: "toolResult", toolName: "todo", isError: false, details: result.details } });
          return result;
        };
        assert.ok(pi.getAllTools().some(t => t.name === "todo"));
        // Every request carries the declaration; keep it small.
        const size = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length;
        assert.ok(size <= 420, `todo declaration grew to ${size} characters`);
        assert.equal(tool.promptSnippet ?? tool.promptGuidelines, undefined);

        // A new session starts empty; results report the change, not the whole list.
        await events.session_start({ reason: "new" }, fake);
        let result = await run({ action: "add", items: ["write tests", "ship"] });
        assert.equal(result.content[0].text, "Added #1, #2. 2 open, 0 done.");
        result = await run({ action: "update", id: 1, status: "in_progress" });
        assert.equal(result.content[0].text, "Updated #1 (in progress). 2 open, 0 done.");
        assert.match(render(tool.renderResult(result, { expanded: false }, theme, { keyHint: () => "", isError: false })), /Updated #1 \(in progress\)\n▸ #1 write tests\n○ #2 ship/);
        assert.equal(render(tool.renderCall({ action: "update", id: 1, status: "done" }, theme)), "todo update #1 → done");
        await assert.rejects(tool.execute("x", { action: "remove" }, undefined, undefined, fake), /Provide "id"/);
        const branchPoint = entries.length;

        const prompt = (messageType = "user") => ({ messageType, systemPromptOptions: { sections: { todos: "stale" } as Record<string, string>, selectedTools: ["todo"] } });
        let event = prompt();
        await events.before_agent_start(event, fake);
        assert.equal(event.systemPromptOptions.sections.todos, "#1 [in_progress] write tests\n#2 [pending] ship");
        event.systemPromptOptions.selectedTools = [];
        await events.before_agent_start(event, fake);
        assert.equal(event.systemPromptOptions.sections.todos, undefined);

        // Reminders need progress since the last one, stop at three, and reset per user prompt.
        const settle = () => events.agent_before_settle({ entries: [] }, ui);
        await events.before_agent_start(prompt(), fake);
        assert.equal(await settle(), undefined);
        assert.equal(await events.agent_before_settle({ entries: [] }, { ...fake }), undefined);
        for (const count of [1, 2, 3]) {
          await events.tool_execution_end({});
          const decision = await settle();
          assert.equal(decision.continue, true);
          assert.equal(decision.entries[0].customType, "todo-reminder");
          assert.match(decision.entries[0].content, new RegExp(`2 open todo item.*Reminder ${count}/3`, "s"));
          assert.equal(await settle(), undefined);
        }
        await events.tool_execution_end({});
        assert.equal(await settle(), undefined);
        await events.before_agent_start(prompt("custom"), fake);
        await events.tool_execution_end({});
        assert.equal(await settle(), undefined);
        await events.before_agent_start(prompt(), fake);
        await events.tool_execution_end({});
        active = [];
        assert.equal(await settle(), undefined);
        active = ["todo"];
        assert.match(render(renderers["todo-reminder"]({ details: { count: 1, open: 2 } }, { outputPad: 0 }, theme)), /Todo reminder 1\/3: 2 open item/);

        // Delegations carry the parent's open items as context; steering does not.
        const call = (toolName: string, input: any) => { events.tool_call({ toolName, input }); return input; };
        assert.match(call("rex_agent", { agent: "scout", task: "t", context: "Inspect src." }).context, /^Inspect src\.\n\nParent session's open todo items.*#2 \[pending\] ship$/s);
        assert.match(call("rex_send", { child: "a", mode: "followup", text: "t" }).context, /^Parent session's open todo items/);
        assert.equal(call("rex_send", { child: "a", mode: "steer", text: "t" }).context, undefined);
        const tasks = call("subagent", { tasks: [{ agent: "scout", task: "a" }, { agent: "advisor", task: "b", context: "c" }] }).tasks;
        assert.ok(tasks.every((task: any) => /#1 \[in_progress\] write tests/.test(task.context)));
        assert.equal(call("read", { path: "x" }).context, undefined);

        // Command edits are saved as custom entries and restored from the branch.
        const printed: string[] = [];
        console.log = (text: string) => { printed.push(text); };
        await commands.todos.handler("done 1", fake);
        await commands.todos.handler("add  a third   item", fake);
        await commands.todos.handler("", fake);
        console.log = log;
        assert.deepEqual(printed.slice(0, 2), ["Updated #1 (done).", "Added #3."]);
        assert.equal(printed[2], "2 open, 1 done\n#2 [pending] ship\n#3 [pending] a third item\n#1 [done] write tests");
        await assert.rejects(commands.todos.handler("toString 1", fake), /Usage/);
        assert.equal(entries.at(-1).customType, "todo");
        assert.deepEqual(restore(entries).items.map((item: any) => item.id), [1, 2, 3]);

        // Navigating to an earlier point restores that branch's list.
        const later = entries.splice(branchPoint);
        await events.session_tree({}, fake);
        assert.equal((await run({ action: "list" })).content[0].text, "2 open, 0 done\n#1 [in_progress] write tests\n#2 [pending] ship");
        entries.push(...later);
        console.log("Todo integration: bundled imports, registration, branch restore, rendering, prompt section, reminders, child context and commands passed");
      } finally { console.log = log; }
    },
  });
}
