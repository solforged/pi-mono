import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi retries provider errors and repairs unrun tool calls by itself. Three turn
// endings are left to the user (tests/fixtures/fault-smoke.ts shows them):
// a stop with nothing visible, a reply cut at the output limit, and the same
// tool call repeated with the same result. Each is handled once or twice per
// prompt with a short note to the model; nothing already sent is rewritten.
export const RECOVER_TYPE = "recover";
export const limits = { nudges: 2, warnAt: 3, blockAt: 5 };
export type Kind = "empty" | "cut" | "cut-thinking" | "loop";

export const notes: Record<Exclude<Kind, "loop">, string> = {
  empty: "Your last response had no visible output, so the task is not finished. Give the final answer, or make the next tool call.",
  cut: "Your last response reached the output limit and was cut off. Continue exactly where it stopped. Do not repeat or summarize what you already wrote.",
  "cut-thinking": "Your last response reached the output limit while still reasoning, and none of it was kept. Reason only about the next step, then make the tool call or answer. For a large deliverable, write a minimal version first and extend it.",
};
export const loopNote = (calls: string[], count: number) =>
  `You have made the same tool call ${count} times in a row and received the same result each time: ${calls.map(call => clip(call, 200)).join("; ")}. Repeating it will not change the outcome. Use different arguments or another tool, or say what is blocking you.`;
export const blockNote = (count: number) =>
  `Not run: this exact call has already returned the same result ${count} times in a row. Change the arguments, use another tool, or say what is blocking you.`;

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
const blocks = (message: any, type: string): any[] => (message?.content ?? []).filter((block: any) => block?.type === type);
const text = (content: unknown) => Array.isArray(content) ? content.filter(block => block?.type === "text").map(block => block.text).join("\n") : "";

// What a turn that made no tool calls needs, if anything.
export function diagnose(message: any): Exclude<Kind, "loop"> | undefined {
  if (message?.role !== "assistant" || blocks(message, "toolCall").length) return;
  const visible = blocks(message, "text").some(block => block.text?.trim());
  if (message.stopReason === "stop") return visible ? undefined : "empty";
  if (message.stopReason === "length") return visible ? "cut" : "cut-thinking";
}

// Key order must not make two identical calls look different.
const canonical = (value: unknown) => JSON.stringify(value, (_key, v) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
export const callKey = (name: string, input: unknown) => `${name} ${canonical(input ?? {})}`;
// A turn repeats the last one only if its results repeat too: polling for a change is not a loop.
export const turnKey = (calls: string[], results: readonly any[]) => JSON.stringify([[...calls].sort(), results.map(result => [Boolean(result.isError), text(result.content)])]);

export function registerRecover(pi: ExtensionAPI) {
  let enabled = true, nudges = 0;
  let loop = { key: "", count: 0, calls: [] as string[] };
  const counts: Record<Kind | "blocked", number> = { empty: 0, cut: 0, "cut-thinking": 0, loop: 0, blocked: 0 };
  const note = (kind: Kind, content: string, count: number) => ({ type: "custom_message" as const, customType: RECOVER_TYPE, content, display: true, details: { kind, count } });
  const reset = () => { nudges = 0; loop = { key: "", count: 0, calls: [] }; };

  pi.on("session_start", reset);
  pi.on("before_agent_start", (event) => { if (event.messageType === "user") reset(); });

  pi.on("turn_end", (event) => {
    // Failed and aborted turns belong to Pi's retries and to /retry.
    if (!enabled || event.outcome !== "completed") return;
    if (event.toolResults.length) {
      const calls = blocks(event.message, "toolCall").map(call => callKey(call.name, call.arguments));
      const key = turnKey(calls, event.toolResults);
      loop = key === loop.key ? { ...loop, count: loop.count + 1 } : { key, count: 1, calls };
      if (loop.count !== limits.warnAt) return;
      counts.loop++;
      return { entries: [...event.entries, note("loop", loopNote(calls, loop.count), loop.count)] };
    }
    loop = { key: "", count: 0, calls: [] };
    const kind = diagnose(event.message);
    if (!kind || nudges >= limits.nudges) return;
    nudges++; counts[kind]++;
    // A reply with nothing to keep would only teach the model to do it again.
    const drop = kind === "cut" ? [] : [{ type: "context_edit" as const, targetId: event.messageEntryId, replacement: null }];
    return { entries: [...event.entries, ...drop, note(kind, notes[kind], nudges)], continue: true };
  });

  // The warning was ignored: refuse the call instead of running it again.
  pi.on("tool_call", (event) => {
    if (!enabled || loop.count < limits.blockAt - 1 || !loop.calls.includes(callKey(event.toolName, event.input))) return;
    counts.blocked++;
    return { block: true, reason: blockNote(loop.count) };
  });

  pi.registerCommand("recover", {
    description: "Show or switch automatic recovery from empty, cut-off and repeating turns (on|off)",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "on" || arg === "off") enabled = arg === "on";
      else if (arg) { report(ctx, "Usage: /recover [on|off]"); return; }
      report(ctx, `Recovery ${enabled ? "on" : "off"}. Since load: ${counts.empty} empty, ${counts.cut + counts["cut-thinking"]} cut off, ${counts.loop} loop warnings, ${counts.blocked} calls refused.`);
    },
  });
}

function report(ctx: any, message: string) { if (ctx.hasUI) ctx.ui.notify(message, "info"); else console.log(message); }

export const label = (details: { kind?: Kind; count?: number } | undefined) => {
  const of = `${details?.count ?? "?"}/${limits.nudges}`;
  switch (details?.kind) {
    case "empty": return `Empty response; asked the model to continue (${of})`;
    case "cut": return `Response cut at the output limit; asked the model to continue (${of})`;
    case "cut-thinking": return `Output limit reached while reasoning; asked for the next step only (${of})`;
    case "loop": return `Same tool call ${details.count ?? "?"} times with the same result; asked the model to change course`;
    default: return "Recovery note";
  }
};
