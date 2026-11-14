import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Usage } from "./process.ts";

// Titles, commits, learning, command subagents and workflowz evals call models
// outside tool results, so Pi's footer and /session totals never see them.
// The statusline adds these entries to its session cost.
export const USAGE_ENTRY = "workflow-usage";

/** Persist usage Pi does not bill itself. */
export function recordUsage(pi: ExtensionAPI, data: { role: string; usage?: Partial<Usage> } & Record<string, unknown>) {
  pi.appendEntry(USAGE_ENTRY, data);
}
