import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Loaded explicitly by the runner, never auto-discovered as a top-level extension.
export default function (pi: ExtensionAPI) {
  const config = JSON.parse(process.env.PI_WORKFLOW_CHILD_CONFIG ?? "null");
  if (!config || !Array.isArray(config.tools) || !Number.isInteger(config.maxTurns)) throw new Error("Missing child guard configuration");
  let turns = 0;
  pi.on("input", async (_event, ctx) => {
    if (ctx.model?.provider !== config.provider || ctx.model?.id !== config.model) {
      console.error("WORKFLOW_GUARD: requested model was not selected; refusing the prompt");
      return { action: "handled" };
    }
    pi.setActiveTools(config.tools);
    const selected = await pi.setModel({ ...ctx.model, maxTokens: Math.min(ctx.model.maxTokens, config.maxTokens) });
    if (!selected) {
      console.error("WORKFLOW_GUARD: authentication unavailable; refusing the prompt");
      return { action: "handled" };
    }
    return { action: "continue" };
  });
  pi.on("session_compact", (event) => {
    if (event.compactionEntry.usage) console.log(JSON.stringify({ type: "workflow_usage", usage: event.compactionEntry.usage }));
  });
  pi.on("turn_start", () => { turns++; });
  // The runner learns of a block from this event, not from the result text: a
  // file or page the child reads may contain any text, this marker included.
  const refuse = (reason: string) => {
    console.log(JSON.stringify({ type: "workflow_guard", reason }));
    return { block: true, terminate: true, reason: `WORKFLOW_GUARD: ${reason}` };
  };
  pi.on("tool_call", (event) => {
    if (!config.tools.includes(event.toolName)) return refuse("tool not allowed");
    if (turns >= config.maxTurns) return refuse("turn limit reached");
  });
}
