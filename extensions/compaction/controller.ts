// Compaction summaries at low thinking, prepared in the background before the threshold.
// The Pi runtime functions arrive as `deps`, so tests can drive this without Pi.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { usesSnapcompact } from "../snapcompact/compact.ts";
import {
  fileOpsFor,
  limitsFor,
  planCompaction,
  previousCompaction,
  previousSummaryOf,
  retryPolicy,
  staleReason,
  summaryThinking,
  type Estimate,
  type Plan,
  type Preparation,
  type Projected,
} from "./plan.ts";

type Result = { summary: string; firstKeptEntryId: string; tokensBefore: number; usage?: unknown; details?: unknown };
type Compact = (
  preparation: any, model: any, apiKey: undefined, headers: undefined, customInstructions: string | undefined,
  signal: AbortSignal, thinkingLevel: string, streamFn: (...args: any[]) => any, env: undefined, retry: object,
) => Promise<Result>;
export type Deps = { compact: Compact; estimateTokens: Estimate };

type Speculation = {
  key: string;
  plan: Plan;
  controller: AbortController;
  promise: Promise<Result | undefined>;
  /** Set once the summary is written. */
  result?: Result;
  done: boolean;
  failed: boolean;
};

export const STATUS = "compaction";

export function register(pi: ExtensionAPI, deps: Deps) {
  let speculation: Speculation | undefined;

  const keyOf = (ctx: ExtensionContext) => `${ctx.sessionManager.getSessionId()} ${ctx.model?.provider}/${ctx.model?.id}`;
  const projection = (ctx: ExtensionContext) => ctx.sessionManager.buildSessionProjection().entries as unknown as Projected[];
  const status = (ctx: ExtensionContext, text?: string) => {
    try { if (ctx.hasUI) ctx.ui.setStatus(STATUS, text); } catch { /* stale after a session switch */ }
  };
  const drop = (ctx?: ExtensionContext) => {
    speculation?.controller.abort();
    speculation = undefined;
    if (ctx) status(ctx);
  };

  // Pi's own path routes virtual models; snapcompact handles the models it images.
  const ours = (ctx: ExtensionContext, custom: boolean) => {
    const model = ctx.model;
    if (!model || model.api === "pi-virtual") return false;
    if (custom) return true;
    return !(usesSnapcompact(model) && pi.getCommands().some((command) => command.name === "snapcompact"));
  };

  const summarize = (ctx: ExtensionContext, preparation: Preparation, custom: string | undefined, signal: AbortSignal) => {
    const registry = ctx.modelRegistry;
    return deps.compact(
      preparation, ctx.model, undefined, undefined, custom, signal, summaryThinking(pi.getThinkingLevel()),
      (model: any, context: any, options: any) => registry.streamSimple(model, context, options),
      undefined, retryPolicy(pi.getSettings()),
    );
  };

  function speculate(ctx: ExtensionContext) {
    if (!ours(ctx, false)) return;
    const limits = limitsFor(ctx.model, pi.getSettings());
    const tokens = ctx.getContextUsage()?.tokens;
    if (!limits || tokens == null || tokens < limits.threshold - limits.lead) return;
    const key = keyOf(ctx);
    const entries = projection(ctx);
    if (speculation) {
      const same = speculation.key === key && speculation.plan.previousCompactionId === previousCompaction(entries)?.id;
      // One attempt per compaction: a failure falls back to summarizing when Pi compacts.
      if (same && (!speculation.done || speculation.failed)) return;
      // A finished summary is replaced only when it could no longer commit. Growth
      // alone is no reason: the band is wider than the recent window, so replanning
      // by distance bought two summaries per compaction, and threw a good one away
      // when a single turn crossed the threshold.
      if (same && speculation.result && !staleReason(speculation.plan, speculation.result.summary, entries, limits, deps.estimateTokens)) return;
      drop(ctx);
    }
    // Past the threshold Pi compacts before the next request; that path summarizes directly.
    if (tokens >= limits.threshold) return;
    const plan = planCompaction(entries, limits, tokens, deps.estimateTokens);
    if (!plan) return;

    const controller = new AbortController();
    const current: Speculation = { key, plan, controller, promise: Promise.resolve(undefined), done: false, failed: false };
    current.promise = summarize(ctx, plan.preparation, undefined, controller.signal).then(
      (result) => {
        current.done = true;
        current.result = result;
        if (speculation === current) status(ctx, "summary ready");
        return result;
      },
      () => {
        current.done = current.failed = true;
        if (speculation === current) status(ctx);
        return undefined;
      },
    );
    speculation = current;
    status(ctx, "summarizing");
  }

  // Each completed turn may cross into the band below the threshold. Never awaited:
  // the run continues while the summary is written.
  pi.on("turn_end", (_event, ctx) => { speculate(ctx); });

  pi.on("session_before_compact", async (event, ctx) => {
    const custom = event.customInstructions?.trim() || undefined;
    if (!ours(ctx, Boolean(custom))) return;
    const { signal } = event;
    const limits = limitsFor(ctx.model, pi.getSettings());

    const prepared = speculation;
    if (!custom && limits && prepared && prepared.key === keyOf(ctx) && !prepared.failed) {
      // Waiting on a summary already under way beats starting a new one.
      const result = await Promise.race([
        prepared.promise,
        new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
      ]);
      if (signal.aborted) return;
      if (result && !staleReason(prepared.plan, result.summary, projection(ctx), limits, deps.estimateTokens)) {
        speculation = undefined;
        status(ctx);
        return { compaction: { ...result, tokensBefore: event.preparation.tokensBefore } };
      }
    }
    drop(ctx);

    const previous = previousCompaction(projection(ctx));
    const preparation = {
      ...event.preparation,
      previousSummary: previous ? previousSummaryOf(previous) : event.preparation.previousSummary,
      fileOps: fileOpsFor([], previous, event.preparation.fileOps),
    } as Preparation;
    try {
      return { compaction: await summarize(ctx, preparation, custom, signal) };
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Compaction summary failed, using Pi's default: ${message}`, "warning");
    }
  });

  // Any compaction changes what a prepared summary extends.
  pi.on("session_compact", (_event, ctx) => { drop(ctx); });
  pi.on("model_select", (_event, ctx) => { drop(ctx); });
  pi.on("session_shutdown", () => { drop(); });
}
