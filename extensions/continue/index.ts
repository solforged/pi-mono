import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { planRetry } from "../retry/retry.ts";
import { CONTINUE_TYPE } from "./started.ts";

export { CONTINUE_TYPE };

export default function (pi: ExtensionAPI) {
  pi.on("input", (event, ctx) => {
    if (ctx.mode !== "tui" || event.source !== "interactive" ||
        event.text.trim() !== "." || event.images?.length) return { action: "continue" };
    // After a failed or aborted turn, rerun it instead of continuing past the failure.
    // Tree navigation is refused until this prompt finishes, so dispatch on the next tick.
    if (!event.streamingBehavior && ctx.isIdle() && planRetry(ctx.sessionManager.getBranch() as any) &&
        pi.getCommands().some(c => c.name === "retry")) {
      setTimeout(() => pi.sendUserMessage("/retry", { expandPromptTemplates: true }), 0);
      return { action: "handled" };
    }
    // The model still needs a user-role turn, but the transcript should read
    // as if the session simply kept going.
    pi.sendMessage({ customType: CONTINUE_TYPE, content: "continue", display: false },
      { triggerTurn: true, deliverAs: event.streamingBehavior });
    return { action: "handled" };
  });
}
