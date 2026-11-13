import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addUsage, emptyUsage, type Usage } from "./process.ts";

// Titles, commits, learning, command subagents and workflowz evals call models
// outside tool results, so Pi's footer and /session totals never see them.
export const USAGE_ENTRY = "workflow-usage";
const STATUS = "workflows";

export function auxiliaryUsage(entries: readonly any[]): Usage {
  const usage = emptyUsage();
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === USAGE_ENTRY) addUsage(usage, entry.data?.usage);
  }
  return usage;
}

export function formatAuxiliary(usage: Usage): string | undefined {
  if (usage.totalTokens <= 0 && usage.cost.total <= 0) return undefined;
  const n = usage.totalTokens;
  const tokens = n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
  // Zero cost usually means the catalog has no price, not a free call.
  const cost = usage.cost.total > 0 ? ` · $${usage.cost.total.toFixed(usage.cost.total >= 1 ? 2 : 3)}` : "";
  return `aux ${tokens}${cost}`;
}

export function showAuxiliaryUsage(ctx: ExtensionContext) {
  try {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS, formatAuxiliary(auxiliaryUsage(ctx.sessionManager.getEntries())));
  } catch { /* stale after a session switch */ }
}

/** Persist usage Pi does not bill itself and refresh the footer total. */
export function recordUsage(pi: ExtensionAPI, ctx: ExtensionContext | undefined, data: { role: string; usage?: Partial<Usage> } & Record<string, unknown>) {
  pi.appendEntry(USAGE_ENTRY, data);
  if (ctx) showAuxiliaryUsage(ctx);
}
