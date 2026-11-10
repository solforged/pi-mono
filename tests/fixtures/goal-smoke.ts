// Explicitly loaded only by the regression suite. No model or network calls.
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import install from "../../extensions/goal/index.ts";
import { KICKOFF_TYPE, NOTE_TYPE, restore } from "../../extensions/goal/goal.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const render = (component: any) => component.render(200).map((line: string) => line.trim()).join("\n");

export default function (pi: ExtensionAPI) {
  const entries: any[] = [], events: Record<string, any> = {}, commands: Record<string, any> = {};
  const renderers: Record<string, any> = {}, sent: any[] = [];
  let tool: any, entryRenderer: any;
  install({
    on: (event: string, fn: any) => { events[event] = fn; },
    registerTool: (definition: any) => { tool = definition; pi.registerTool(definition); },
    registerCommand: (name: string, options: any) => { commands[name] = options; },
    registerMessageRenderer: (type: string, fn: any) => { renderers[type] = fn; },
    registerEntryRenderer: (_type: string, fn: any) => { entryRenderer = fn; },
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data, timestamp: new Date().toISOString() }); },
    sendMessage: (message: any, options: any) => { sent.push({ message, options }); },
  } as any);

  pi.registerCommand("goal-smoke", {
    description: "Exercise the goal extension offline against a stand-in session",
    handler: async (_args, ctx) => {
      const status: Record<string, string | undefined> = {}, notes: string[] = [];
      let idle = true, confirm = true;
      const ui = {
        ...ctx, mode: "tui", hasUI: true, isIdle: () => idle, waitForIdle: async () => {},
        sessionManager: { getBranch: () => entries },
        ui: { setStatus: (key: string, text?: string) => { status[key] = text; }, notify: (text: string) => { notes.push(text); }, confirm: async () => confirm },
      } as any;
      const goal = (args: string, context = ui) => commands.goal.handler(args, context);
      const prompt = (selectedTools = ["read"]) => {
        const event = { messageType: "user", systemPromptOptions: { sections: { goal: "stale" } as Record<string, string>, selectedTools } };
        events.before_agent_start(event, ui);
        return event.systemPromptOptions;
      };
      const settle = (extra: any = {}) => events.agent_before_settle({ entries: [], continue: false, ...extra }, ui);
      const commit = (decision: any) => { for (const entry of decision?.entries ?? []) entries.push({ ...entry, timestamp: new Date().toISOString() }); return decision; };
      const work = () => events.tool_execution_end({ toolName: "bash" });

      // The declaration is sent with every goal request; keep it small and off by default.
      assert.ok(pi.getAllTools().some(t => t.name === "goal"));
      const size = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length;
      assert.ok(size <= 320, `goal declaration grew to ${size} characters`);
      assert.equal(tool.defaultActive, false);

      await events.session_start({ reason: "new" }, ui);
      assert.equal(status.goal, undefined);
      await goal("");
      assert.match(notes.at(-1)!, /^No goal is set/);
      await assert.rejects(goal("pause"), /No goal is set/);
      await assert.rejects(goal("tokens"), /Usage/);

      // Setting a goal records it and starts a run with a hidden kickoff.
      await goal("Make the suite pass");
      assert.equal(entries.at(-1).data.event, "set");
      assert.deepEqual([sent.at(-1).message.customType, sent.at(-1).message.display, sent.at(-1).options.triggerTurn], [KICKOFF_TYPE, false, true]);
      assert.match(sent.at(-1).message.content, /^New goal: Make the suite pass/);
      assert.equal(status.goal, "goal 0/25");

      // The run carries the section and the tool; without the goal neither appears.
      let options = prompt();
      assert.match(options.sections.goal, /^Objective: Make the suite pass/);
      assert.deepEqual(options.selectedTools, ["read", "goal"]);

      // No tool ran: wait for the user. Progress: continue once per stop.
      assert.equal(await settle(), undefined);
      assert.equal(status.goal, "goal 0/25 · waiting");
      work();
      let decision = commit(await settle());
      assert.equal(decision.continue, true);
      assert.deepEqual([decision.entries[0].customType, decision.entries[0].details.n], [NOTE_TYPE, 1]);
      assert.match(decision.entries[0].content, /continuation 1 of 25/);
      events.tool_execution_end({ toolName: "goal" });
      assert.equal(await settle(), undefined, "the goal tool alone is not progress");
      work();
      assert.equal(await settle({ continue: true }), undefined, "another extension already continues");
      assert.match(render(renderers[NOTE_TYPE](decision.entries[0], { outputPad: 0 }, theme)), /↻ Goal continues 1\/25 · 0 tokens/);

      // The continuation budget ends the loop with one wrap-up request.
      await goal("continuations 2");
      assert.deepEqual(restore(entries).goal!.budget, { continuations: 2 });
      work(); commit(await settle());
      work(); decision = commit(await settle());
      assert.equal(decision.continue, true);
      assert.deepEqual(decision.entries.map((entry: any) => entry.customType), ["goal", NOTE_TYPE]);
      assert.match(decision.entries[1].content, /budget of 2 automatic continuations is spent/);
      assert.equal(restore(entries).goal!.status, "budget_limited");
      work();
      assert.equal(await settle(), undefined);

      // The agent can still close it with evidence, and then cannot touch it again.
      const result = await tool.execute("call", { status: "complete", note: "npm test: 212 passed" }, undefined, undefined, ui);
      entries.push({ type: "message", message: { role: "toolResult", toolName: "goal", isError: false, details: result.details } });
      assert.match(result.content[0].text, /^Goal marked complete/);
      assert.match(render(tool.renderResult(result, { isPartial: false }, theme, { isError: false })), /✓ Goal complete\nnpm test: 212 passed/);
      assert.equal(status.goal, "goal complete");
      await assert.rejects(tool.execute("call", { status: "complete", note: "again" }, undefined, undefined, ui), /no active goal/);
      options = prompt(["read", "goal"]);
      assert.equal(options.sections.goal, undefined);
      assert.deepEqual(options.selectedTools, ["read"]);
      await assert.rejects(goal("resume"), /complete/);

      // A token budget stops the run at the turn that crosses it.
      await goal("Cut p95 below 120 ms");
      await goal("tokens 1k");
      prompt();
      entries.push({ type: "message", message: { role: "assistant", usage: { input: 900, output: 200, cacheRead: 50000, cacheWrite: 0 } } });
      decision = commit(await events.turn_end({ outcome: "completed", entries: [] }, ui));
      assert.match(decision.entries[1].content, /budget of 1k tokens is spent/);
      assert.equal(await events.turn_end({ outcome: "completed", entries: [] }, ui), undefined);

      // Replacing an unfinished goal asks first; Escape pauses an active one.
      confirm = false;
      await goal("Something else");
      assert.equal(restore(entries).goal!.objective, "Cut p95 below 120 ms");
      confirm = true;
      await goal("resume");
      assert.equal(sent.at(-1).message.content, "The goal is resumed. Continue working toward it.");
      prompt();
      await events.agent_settled({ aborted: true }, ui);
      assert.equal(entries.at(-1).data.event, "interrupt");
      assert.equal(status.goal, "goal paused");

      // Resumed mid-run, a goal already in this run's prompt carries on in the run...
      idle = false;
      const before = sent.length;
      await goal("resume");
      work();
      assert.equal(commit(await settle()).continue, true);
      await events.agent_settled({ aborted: false }, ui);
      assert.equal(sent.length, before);
      // ...while a goal set mid-run waits for the run to settle and starts with its own prompt.
      await goal("Another objective");
      work();
      assert.equal(await settle(), undefined);
      assert.equal(sent.length, before);
      await events.agent_settled({ aborted: false }, ui);
      assert.match(sent.at(-1).message.content, /^New goal: Another objective/);
      idle = true;

      // Lifecycle entries render in the transcript.
      const card = (data: any) => render(entryRenderer({ data }, {}, theme));
      assert.equal(card({ event: "set", goal: { objective: "Ship", status: "active", budget: {} } }), "◎ Goal Ship");
      assert.equal(card({ event: "budget", goal: { objective: "Ship", status: "active", budget: { tokens: 500000 } } }), "◎ Goal budget: unlimited continuations, 500k tokens");
      assert.equal(card({ event: "interrupt", goal: null }), "◎ Goal paused by the interruption · /goal resume continues it");

      // Tree navigation restores that branch's goal.
      const later = entries.splice(entries.findIndex((entry) => entry.data?.goal?.objective === "Cut p95 below 120 ms"));
      await events.session_tree({}, ui);
      assert.equal(status.goal, "goal complete");
      entries.push(...later);
      await events.session_tree({}, ui);
      await goal("clear");
      assert.equal(status.goal, undefined);

      // Headless: the command waits for the goal run to settle, then reports it.
      const errors: string[] = [], logError = console.error;
      console.error = (text: string) => { errors.push(text); };
      try {
        const headless = { ...ui, mode: "print", hasUI: false };
        const running = goal("Write the report", headless);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(errors.length, 0);
        await events.agent_settled({ aborted: false }, headless);
        await running;
        assert.match(errors[0], /^Goal \(active\): Write the report/);
        assert.equal(process.exitCode, 1);
      } finally { console.error = logError; process.exitCode = 0; }

      console.log("Goal integration: bundled imports, registration, prompt section and tool selection, continuation, budgets, closing, interruption, rendering, branch restore and headless runs passed");
    },
  });
}
