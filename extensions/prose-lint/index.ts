// Prose lint: after the agent writes or edits a Markdown file, Vale runs on the
// file before and after the change, and the alerts the change introduced are
// appended to that tool result. Nothing else enters the context: no system
// prompt text, no extra turns, and no note when the edit is clean, so the
// prompt cache and context stay as they were. Needs `vale` on PATH and uses
// the user's global and project Vale configuration; spelling is left out.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { which } from "../shared/system.ts";
import { introduced, isProse, note, vale } from "./lint.ts";

export default function (pi: ExtensionAPI) {
  const bin = which("vale");
  if (!bin) return;
  // The file as it was before each pending write or edit, by tool call.
  const before = new Map<string, { path: string; text: string }>();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string" || !isProse(input.path)) return;
    const path = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    before.set(event.toolCallId, { path, text: await readFile(path, "utf8").catch(() => "") });
  });

  pi.on("tool_result", async (event, ctx) => {
    const pending = before.get(event.toolCallId);
    if (!pending) return;
    before.delete(event.toolCallId);
    if (event.isError) return;
    const after = await readFile(pending.path, "utf8").catch(() => undefined);
    if (after === undefined || after === pending.text) return;
    const options = { signal: ctx.signal, bin };
    const [old, now] = await Promise.all([
      pending.text ? vale(pending.text, pending.path, options) : Promise.resolve([]),
      vale(after, pending.path, options),
    ]);
    const added = introduced(old, now);
    if (!added.length) return;
    const shown = relative(ctx.cwd, pending.path);
    const text = note(added, shown && !shown.startsWith("..") ? shown : pending.path);
    return { content: [...event.content, { type: "text", text }], structuredContent: event.structuredContent };
  });
}
