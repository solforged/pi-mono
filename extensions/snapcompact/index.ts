import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  compactMessages,
  getArchive,
  injectHistory,
  isVision,
  previousSnapcompact,
  type Archive,
} from "./compact.ts";

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer("snapcompact-report", (entry) => new Text((entry.data as { text: string }).text, 0, 0));

  function report(ctx: ExtensionContext, text: string) {
    pi.appendEntry("snapcompact-report", { text });
    if (!ctx.hasUI) console.log(text);
    else if (ctx.mode !== "tui") ctx.ui.notify(text, "info");
  }

  function archiveFrom(ctx: ExtensionContext): Archive | undefined {
    const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type === "compaction") return getArchive(entry.details);
    }
  }

  pi.registerCommand("snapcompact", {
    description: "Show whether snapcompact will archive this model as images",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      const vision = isVision(model);
      const archive = archiveFrom(ctx);
      const lines = [
        `Session: ${model ? `${model.provider}/${model.id}` : "none"}`,
        `Vision: ${vision ? "yes" : "no"}`,
        `Auto: ${vision ? "snapcompact on compact" : "default LLM summary"}`,
        archive
          ? `Last archive: ${archive.frames.length} frames, ${archive.totalChars.toLocaleString()} chars${archive.omittedFrames ? `, ${archive.omittedFrames} older pages not imaged` : ""}${archive.truncatedChars ? `, dropped ${archive.truncatedChars.toLocaleString()}` : ""}`
          : "Last archive: none",
      ];
      report(ctx, lines.join("\n"));
    },
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (event.customInstructions?.trim()) return;
    if (!isVision(ctx.model)) return;
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
    return { messages: injectHistory(event.messages, archive, isVision(ctx.model)) };
  });
}
