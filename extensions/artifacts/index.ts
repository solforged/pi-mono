import { join } from "node:path";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ArtifactStore, archiveResult, readExcerpt } from "./output.ts";

export default function (pi: ExtensionAPI) {
  const store = new ArtifactStore(join(getAgentDir(), "tool-artifacts"));
  let enabled = true;
  let saved = 0;
  let omittedBytes = 0;
  let failures = 0;

  pi.on("tool_result", async (event, ctx) => {
    if (!enabled) return;
    try {
      const result = await archiveResult(event, store);
      if (!result) return;
      saved++;
      omittedBytes += Math.max(0, result.artifact.originalBytes - result.artifact.returnedBytes);
      // Returning content without structuredContent drops the original structured
      // output. Nested calls are untouched, so codemode still gets full data.
      return { content: result.content, details: result.details };
    } catch (error) {
      failures++;
      // Fail open: no artifact means no clipping. Never turn a successful call
      // into a failure merely because local storage is unavailable.
      if (ctx.hasUI) ctx.ui.notify(`Output not archived: ${error instanceof Error ? error.message : String(error)}`, "warning");
      else console.error(`Output not archived: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  pi.registerTool({
    name: "artifact_read",
    label: "Artifact read",
    description: "Retrieve bounded verbatim text from an archived tool result by its artifact UUID. offset is a 1-based line number; query filters lines by a case-sensitive literal substring. Use column to continue a clipped long line. Never accepts arbitrary file paths.",
    promptSnippet: "Retrieve omitted evidence from archived tool output",
    promptGuidelines: ["Archived tool excerpts are incomplete. Use artifact_read with a literal query or line range when omitted evidence could affect the answer."],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({
      id: Type.String({ description: "Artifact UUID from the tool result receipt" }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "Starting line, 1-based; default 1" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 80, description: "Maximum returned lines; default 40. Output is also capped at 6000 bytes." })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Case-sensitive literal substring, not a regular expression" })),
      column: Type.Optional(Type.Integer({ minimum: 1, description: "Starting Unicode character on the first returned line, 1-based; default 1" })),
    }),
    async execute(_toolCallId, params) {
      const text = await store.read(params.id);
      return { content: [{ type: "text", text: readExcerpt(text, params) }], details: { artifactId: params.id } };
    },
  });

  pi.registerCommand("artifacts", {
    description: "Show output archival status and byte counts; /artifacts on|off toggles this runtime",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "on") enabled = true;
      else if (action === "off") enabled = false;
      else if (action && action !== "check") {
        ctx.ui.notify("Usage: /artifacts [on|off|check]", "error");
        return;
      }
      const text = [
        `Output artifacts: ${enabled ? "on" : "off"}; threshold 8192 bytes or 160 lines.`,
        `Since load: ${saved} results archived, ${omittedBytes} text bytes kept out of history, ${failures} storage failures.`,
        `Storage: ${store.root} (private; retained until manually removed).`,
        "Failed calls, read/edit/write, and nested calls are unchanged. No model calls or history rewriting.",
      ].join("\n");
      // A custom entry gives JSON/RPC consumers a report without corrupting stdout.
      pi.appendEntry("artifacts-report", { text });
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else if (ctx.mode !== "json" && ctx.mode !== "rpc") console.log(text);
    },
  });
}
