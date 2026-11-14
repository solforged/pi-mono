import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { limitsFor } from "../compaction/plan.ts";
import { print } from "../shared/context.ts";
import {
  compactMessages,
  FRAME_TOKEN_SHARE,
  frameTokens,
  getArchive,
  historyBlocks,
  injectHistory,
  isVision,
  previousSnapcompact,
  usesSnapcompact,
  type Archive,
} from "./compact.ts";

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer("snapcompact-report", (entry) => new Text((entry.data as { text: string }).text, 0, 0));

  function report(ctx: ExtensionContext, text: string) {
    pi.appendEntry("snapcompact-report", { text });
    if (!ctx.hasUI) print(ctx, text);
    else if (ctx.mode !== "tui") ctx.ui.notify(text, "info");
  }

  function archiveFrom(ctx: ExtensionContext): Archive | undefined {
    const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type === "compaction") return getArchive(entry.details);
    }
  }

  // Frames ride along with every request, so they get a share of the compaction
  // threshold: a small window would otherwise be mostly archive again right
  // after compacting. Unlimited when Pi's compaction is off for this model.
  function frameTokenBudget(ctx: ExtensionContext): number | undefined {
    const limits = limitsFor(ctx.model, pi.getSettings());
    return limits ? Math.floor(limits.threshold * FRAME_TOKEN_SHARE) : undefined;
  }

  pi.registerCommand("snapcompact", {
    description: "Show whether snapcompact will archive this model as images",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      const vision = isVision(model);
      const archive = archiveFrom(ctx);
      const budget = frameTokenBudget(ctx);
      const sent = archive && vision ? historyBlocks(archive, { tokens: budget }).filter((block) => block.type === "image") : [];
      const lines = [
        `Session: ${model ? `${model.provider}/${model.id}` : "none"}`,
        `Vision: ${vision ? "yes" : "no"}`,
        `Auto: ${usesSnapcompact(model) ? "snapcompact on compact" : "LLM summary"}`,
        archive
          ? `Last archive: ${archive.frames.length} frames, ${archive.totalChars.toLocaleString()} chars${archive.omittedFrames ? `, ${archive.omittedFrames} older pages not imaged` : ""}${archive.truncatedChars ? `, dropped ${archive.truncatedChars.toLocaleString()}` : ""}`
          : "Last archive: none",
        ...(sent.length ? [`Sent with each request: ${sent.length} frames, about ${sent.reduce((sum, frame) => sum + frameTokens(frame), 0).toLocaleString()} tokens${budget ? ` of a ${budget.toLocaleString()} budget` : ""}`] : []),
      ];
      report(ctx, lines.join("\n"));
    },
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (event.customInstructions?.trim()) return;
    if (!usesSnapcompact(ctx.model)) return;
    const { preparation, branchEntries, signal } = event;
    if (!preparation.firstKeptEntryId) return;
    signal.throwIfAborted();
    const previous = previousSnapcompact(branchEntries ?? []);
    try {
      const messages = convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);
      const result = compactMessages(messages, {
        model: ctx.model,
        previousSummary: previous.archive ? undefined : preparation.previousSummary,
        previousArchive: previous.archive,
        previousDetails: previous.details ?? preparation.fileOps,
        fileOps: preparation.fileOps,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        maxFrameTokens: frameTokenBudget(ctx),
      });
      const archive = result.details.snapcompact;
      ctx.ui.notify(
        `Snapcompact: archived ${archive.totalChars.toLocaleString()} chars onto ${archive.frames.length} frame${archive.frames.length === 1 ? "" : "s"}`,
        "info",
      );
      return { compaction: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!signal.aborted) ctx.ui.notify(`Snapcompact failed, using default compaction: ${message}`, "warning");
    }
  });

  // Not a context handler: its changed list would make Pi fold every system
  // message into the head, so later tool and prompt patches would rewrite the
  // cached prefix and drop earlier thinking.
  pi.on("context_with_system", async (event, ctx) => {
    const archive = archiveFrom(ctx);
    if (!archive) return;
    return { messages: injectHistory(event.messages, archive, isVision(ctx.model), frameTokenBudget(ctx)) };
  });
}
