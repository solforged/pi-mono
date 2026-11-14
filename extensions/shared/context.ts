// Helpers over Pi's extension context, imported by relative path. This folder
// has no index.ts on purpose: scripts/install.ts links, and Pi loads, only
// folders that have one, so it never loads as an extension.

type Level = "info" | "warning" | "error";
interface Context { hasUI: boolean; mode?: string; ui: { notify(text: string, level?: Level): void } }

/**
 * Text for a person, outside the UI. Standard output in print mode; standard
 * error in JSON and RPC modes, where standard output is a protocol stream.
 */
export function print(ctx: { mode?: string }, text: string) {
  (ctx.mode === "json" || ctx.mode === "rpc" ? console.error : console.log)(text);
}

/** A command's answer: a notification where there is a UI, printed otherwise. */
export function report(ctx: Context, text: string, level: Level = "info") {
  if (ctx.hasUI) ctx.ui.notify(text, level); else print(ctx, text);
}

/** The session's context files (AGENTS.md and the like) as the text a child agent is given. */
export const instructionsText = (files: Array<{ path: string; content: string }> = []) =>
  files.map((f) => `Instructions from ${f.path}:\n${f.content}`).join("\n\n");
