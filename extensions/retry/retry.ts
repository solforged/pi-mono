import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const RETRY_TYPE = "retry";
export const SHORTCUT = "f5";
const ABORTED = "Operation aborted";
const START_POLLS = 300;

type Entry = { type: string; id: string; parentId: string | null; [key: string]: any };
type Resend =
  | { kind: "prompt"; content: any }
  | { kind: "message"; message: { customType: string; content: any; display: boolean; details?: unknown } }
  | { kind: "continue"; interrupted: boolean };
export type Plan = Resend & { target: string; dropped: Entry[] };

const CONTEXT_TYPES = new Set(["message", "custom_message", "compaction", "branch_summary"]);
/** Entries that never start a turn: metadata, edits, and prompt or tool patches. */
const passive = (e: Entry) => !CONTEXT_TYPES.has(e.type) || (e.type === "message" && e.message.role === "system");
const failed = (e: Entry) => e.type === "message" && e.message.role === "assistant" &&
  (e.message.stopReason === "error" || e.message.stopReason === "aborted");
const text = (content: unknown) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(c => c?.type === "text" ? c.text : "").join("\n") : "";

/**
 * Plans a retry when the branch ends in a failed or aborted assistant turn.
 * Earlier failed attempts and passive entries are dropped with it. A turn
 * started by a user or extension message is retried by resending that message
 * on a new branch; one that failed after tool results continues from them.
 */
export function planRetry(branch: Entry[]): Plan | undefined {
  let i = branch.length - 1;
  while (i >= 0 && passive(branch[i])) i--;
  if (i < 0 || !failed(branch[i])) return undefined;
  while (i >= 0 && (passive(branch[i]) || failed(branch[i]))) i--;
  if (i < 0) return undefined;
  const anchor = branch[i];
  if (anchor.type === "message" && anchor.message.role === "user") {
    return { kind: "prompt", target: anchor.id, content: anchor.message.content, dropped: branch.slice(i) };
  }
  if (anchor.type === "custom_message") {
    const { customType, content, display, details } = anchor;
    return { kind: "message", target: anchor.id, message: { customType, content, display, details }, dropped: branch.slice(i) };
  }
  let interrupted = false;
  for (let j = i; j >= 0 && branch[j].type === "message" && branch[j].message.role === "toolResult"; j--) {
    if (branch[j].message.isError && text(branch[j].message.content).includes(ABORTED)) interrupted = true;
  }
  return { kind: "continue", target: anchor.id, interrupted, dropped: branch.slice(i + 1) };
}

export function retryNote(interrupted: boolean) {
  return "Retry: the previous response failed before it finished. Continue from where it stopped." +
    (interrupted ? ` Tool results reading "${ABORTED}" were interrupted, not refused; run them again if still needed.` : "");
}

function report(ctx: ExtensionContext, message: string) {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
  else console.error(message);
}

/** Moves the leaf before the failed turn and starts it again with the current model. */
export async function retry(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  if (!ctx.isIdle()) return report(ctx, "Wait for the current response to finish, or press Esc, before retrying");
  const plan = planRetry(ctx.sessionManager.getBranch() as Entry[]);
  if (!plan) return report(ctx, "Nothing to retry");
  const model = ctx.model, level = pi.getThinkingLevel();
  const draft = ctx.mode === "tui" ? ctx.ui.getEditorText() : "";
  const result = await ctx.navigateTree(plan.target, { summarize: false });
  if (result.cancelled) return report(ctx, "Retry cancelled");
  // Navigating to a message restores its text into an empty editor; it is being resent instead.
  if (ctx.mode === "tui" && !draft.trim()) ctx.ui.setEditorText("");
  // A model switched after the failure would otherwise be lost with the abandoned branch on resume.
  if (model && plan.dropped.some(e => e.type === "model_change")) {
    const saved = ctx.sessionManager.getBranch().findLast((e: Entry) => e.type === "model_change") as Entry | undefined;
    if (saved?.provider !== model.provider || saved?.modelId !== model.id) {
      await pi.setModel(model);
      pi.setThinkingLevel(level);
    }
  }
  if (plan.kind === "prompt") pi.sendUserMessage(plan.content);
  else if (plan.kind === "message") pi.sendMessage(plan.message, { triggerTurn: true });
  else pi.sendMessage({ customType: RETRY_TYPE, content: retryNote(plan.interrupted), display: true }, { triggerTurn: true });
  // Print and JSON runs exit when the command returns, so wait for the turn to start after input
  // handlers and then settle. Interactive and RPC hosts stream it themselves.
  if (!ctx.hasUI) {
    for (let i = 0; i < START_POLLS && ctx.isIdle(); i++) await new Promise(r => setTimeout(r, 10));
    await ctx.waitForIdle();
  }
}

export function registerRetry(pi: ExtensionAPI) {
  pi.registerCommand("retry", {
    description: "Retry the last failed or aborted agent turn",
    handler: async (_args, ctx) => retry(pi, ctx),
  });
  pi.registerShortcut(SHORTCUT, {
    description: "Retry the last failed or aborted agent turn",
    // Shortcuts lack tree navigation, so they dispatch the command.
    handler: async ctx => {
      if (!ctx.isIdle()) return report(ctx, "Wait for the current response to finish, or press Esc, before retrying");
      pi.sendUserMessage("/retry", { expandPromptTemplates: true });
    },
  });
}
