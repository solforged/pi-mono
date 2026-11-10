import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Compact once context passes this share of the model's window. Pi's own
// compaction settings only take exact model keys and absolute reserves, so new
// models from these providers would otherwise fall back to the default.
// An exact `compaction.modelOverrides` entry with reserveTokens wins for its model.
export const PROVIDER_RATIOS: Record<string, number> = { anthropic: 0.4 };

type Model = { provider: string; id: string; contextWindow?: number };

export function thresholdFor(model: Model | undefined, settings: any, ratios = PROVIDER_RATIOS): number | undefined {
  const ratio = model && ratios[model.provider];
  if (!model || !ratio || !model.contextWindow) return undefined;
  const compaction = settings?.compaction;
  if (compaction?.enabled === false) return undefined;
  if (compaction?.modelOverrides?.[`${model.provider}/${model.id}`]?.reserveTokens !== undefined) return undefined;
  return Math.floor(model.contextWindow * ratio);
}

export default function (pi: ExtensionAPI) {
  let running = false;
  // Set when a compaction left the context above the threshold, so we do not
  // compact again every turn. Cleared once usage drops below it or the model changes.
  let stuckAt: string | undefined;

  const key = (ctx: ExtensionContext) => ctx.model && `${ctx.model.provider}/${ctx.model.id}`;

  function check(ctx: ExtensionContext) {
    if (running) return;
    const limit = thresholdFor(ctx.model, pi.getSettings());
    const tokens = ctx.getContextUsage()?.tokens;
    if (limit === undefined || tokens == null) return;
    if (tokens <= limit) { stuckAt = undefined; return; }
    if (stuckAt === key(ctx)) return;
    running = true;
    const model = key(ctx);
    ctx.compact({
      onComplete: () => {
        running = false;
        const after = ctx.getContextUsage()?.tokens;
        stuckAt = after != null && after > limit ? model : undefined;
      },
      onError: (error) => {
        running = false;
        stuckAt = model;
        if (ctx.hasUI) ctx.ui.notify(`Compaction at ${Math.round(limit / 1000)}K failed: ${error.message}`, "error");
      },
    });
  }

  // Check before an idle prompt, like Pi's own pre-prompt check. Compacting
  // mid-run (turn_end, steering) aborts the running turn; Pi's native reserve
  // still guards a single long run. The prompt waits for the compaction.
  pi.on("input", (event, ctx) => { if (!event.streamingBehavior && ctx.isIdle()) check(ctx); });
  pi.on("model_select", () => { stuckAt = undefined; });
}
