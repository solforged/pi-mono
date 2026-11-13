// Explicitly loaded only by the regression suite. No model or network calls.
// Runs Pi's own bash tool, so a change in the status lines it writes shows up
// here, and draws the results through the extension's renderers.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import install from "../../extensions/tool-frames/index.ts";
import { shellResult } from "../../extensions/tool-frames/layout.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

export default function (pi: ExtensionAPI) {
  let renderer: any;
  install({ registerToolRenderer: (resolve: any) => { renderer = resolve("bash", () => undefined); }, on: () => {} } as any);

  pi.registerCommand("tool-frames-smoke", {
    description: "Check framed bash rows against what Pi's bash tool returns",
    handler: async (_args, ctx) => {
      const bash = createBashToolDefinition(ctx.cwd);
      const run = async (command: string, options: { timeout?: number; signal?: AbortSignal } = {}) => {
        try {
          const result: any = await bash.execute("call", { command, timeout: options.timeout }, options.signal, undefined, ctx as any);
          return { text: result.content[0].text as string, isError: Boolean(result.isError) };
        } catch (error) {
          return { text: (error as Error).message, isError: true };
        }
      };
      const draw = (command: string, ran: { text: string; isError: boolean }, expanded = false) => {
        const state = {};
        const context = {
          args: { command }, state, invalidate() {}, toolCallId: "call", cwd: ctx.cwd, executionStarted: true, argsComplete: true,
          isPartial: false, expanded, isError: ran.isError, durationMs: 1200, outputPad: 1, keyHint: () => "ctrl+o to expand",
        };
        const head = renderer.renderCall(context.args, theme, context);
        renderer.renderResult({ content: [{ type: "text", text: ran.text }] }, {}, theme, context);
        const lines: string[] = head.render(80).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""));
        for (const line of lines) assert.ok([...line].length <= 80, line);
        return lines.map((line) => line.trim());
      };

      const failed = await run("echo boom; exit 3");
      assert.deepEqual(shellResult(failed.text, failed.isError), { output: "boom", status: { kind: "exit", code: 3 }, fullOutputPath: undefined });
      const failedRow = draw("echo boom; exit 3", failed);
      assert.match(failedRow[0], /^╭─ \$ echo boom; exit 3 ─+ exit 3 · 1\.2s ─╮$/);
      assert.deepEqual(failedRow.slice(1, -1), [`│ boom${" ".repeat(70)} │`]);

      // A successful command that prints what looks like Pi's status line still succeeded.
      const quoted = await run("printf 'done\\nCommand exited with code 3\\n'");
      assert.deepEqual(shellResult(quoted.text, quoted.isError), { output: "done\nCommand exited with code 3", status: { kind: "ok" }, fullOutputPath: undefined });
      const quotedRow = draw("printf", quoted);
      assert.match(quotedRow[0], /^╭─ \$ printf ─+ ✓ 1\.2s ─╮$/);
      assert.match(quotedRow[2], /^│ Command exited with code 3 +│$/);

      const silent = await run("true");
      assert.deepEqual(shellResult(silent.text, silent.isError), { output: "", status: { kind: "ok" }, fullOutputPath: undefined });
      assert.equal(draw("true", silent).length, 2);

      const slow = await run("echo started; sleep 5", { timeout: 1 });
      assert.deepEqual(shellResult(slow.text, slow.isError), { output: "started", status: { kind: "timeout", seconds: 1 }, fullOutputPath: undefined });

      const stopped = await run("echo started; sleep 5", { signal: AbortSignal.timeout(300) });
      assert.deepEqual(shellResult(stopped.text, stopped.isError), { output: "started", status: { kind: "aborted" }, fullOutputPath: undefined });

      // Enough lines for Pi to cut the output and save the whole of it.
      const long = await run("seq 1 3000");
      const parsed = shellResult(long.text, long.isError);
      try {
        assert.deepEqual(parsed.status, { kind: "ok" });
        assert.ok(parsed.fullOutputPath, long.text.slice(-200));
        assert.ok(parsed.output.endsWith("\n2999\n3000"), parsed.output.slice(-40));
        const collapsed = draw("seq 1 3000", long);
        assert.match(collapsed[1], /^│ … \d+ earlier lines · ctrl\+o to expand +│$/);
        assert.deepEqual(collapsed.slice(2, 7).map((line) => line.replace(/[│ ]/g, "")), ["2996", "2997", "2998", "2999", "3000"]);
        assert.match(collapsed[7], /^│ full output: /);
        assert.ok(draw("seq 1 3000", long, true).length > 1000);
      } finally {
        if (parsed.fullOutputPath) rmSync(parsed.fullOutputPath, { force: true });
      }
      console.log("tool-frames integration: bash rows match Pi's bash results; passed");
    },
  });
}
