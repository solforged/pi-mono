import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { askInTerminal, askWithDialogs } from "./dialog.ts";
import { invalid, items, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, normalize, prepare, resultText, TOOL, withLedger, type Details, type Question } from "./model.ts";

const option = Type.Object({
  label: Type.String(),
  description: Type.Optional(Type.String({ description: "What choosing it means" })),
  preview: Type.Optional(Type.String({ description: "Markdown shown while focused, e.g. code or a mockup" })),
});
const question = Type.Object({
  question: Type.String(),
  header: Type.Optional(Type.String({ description: "Tab label, 1-3 words" })),
  options: Type.Array(option, { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS }),
  recommended: Type.Optional(Type.Integer({ minimum: 0, description: "Index of the option you recommend" })),
  multi: Type.Optional(Type.Boolean({ description: "Allow several options" })),
});

const STATUS = { discuss: "Continuing in chat instead", handback: "Handed back to the parent agent", interrupted: "Interrupted", unavailable: "No interactive user", invalid: "Not shown: invalid questions" };

export default function (pi: ExtensionAPI) {
  // After "discuss", the rest of the run's tool calls are blocked as terminating, so
  // siblings after the ask cannot keep the agent going. Siblings before it already ran.
  let discussing = false;
  pi.on("agent_start", () => { discussing = false; });
  pi.on("tool_call", () => discussing ? { block: true, terminate: true, reason: "The user wants to discuss in chat first." } : undefined);

  pi.registerTool({
    name: TOOL,
    label: "Ask",
    description: "Ask the user 1-4 multiple-choice questions and wait. They can also type an answer, leave a question to you, or end the turn to discuss in chat.",
    promptSnippet: "Ask the user multiple-choice questions",
    promptGuidelines: [
      "Use ask_user_question only when plausible readings of the request lead to materially different work; otherwise decide and state the assumption.",
      "Put every open question in one ask_user_question call and set recommended where you have a view.",
    ],
    parameters: Type.Object({ questions: Type.Array(question, { minItems: 1, maxItems: MAX_QUESTIONS }) }),
    executionMode: "sequential",
    prepareArguments: args => prepare(args) as any,
    async execute(_id, params, signal, _update, ctx) {
      const questions = normalize(params.questions as Question[]);
      const done = (details: Details, note?: string) => ({ content: [{ type: "text" as const, text: resultText(details, note) }], details });
      const problem = invalid(questions);
      if (problem) return { ...done({ outcome: "invalid", items: [] }, problem), isError: true };
      if (!ctx.hasUI) return done({ outcome: "unavailable", items: [] });
      const ending = ctx.mode === "tui" ? await askInTerminal(ctx, questions, signal) : await askWithDialogs(ctx, questions, signal);
      // Whatever was entered before leaving the dialog stays in the result as drafts.
      if (ending.outcome === "discuss" && process.env.PI_REX_CHILD) return done({ outcome: "handback", items: items(questions, ending.answers, false) });
      discussing = ending.outcome === "discuss";
      if (ending.outcome !== "answered") return { ...done({ outcome: ending.outcome, items: items(questions, ending.answers, false) }), terminate: discussing };
      return done({ outcome: "answered", items: items(questions, ending.answers) });
    },
    renderCall(args: any, theme) {
      const qs: any[] = Array.isArray(args?.questions) ? args.questions : [];
      const first = qs.length === 1 ? String(qs[0]?.question ?? "") : qs.map((q, i) => q?.header ?? `Q${i + 1}`).join(", ");
      return new Text(`${theme.fg("toolTitle", theme.bold("ask "))}${theme.fg("muted", first)}`, 0, 0);
    },
    renderResult(result: any, _options, theme) {
      const details: Details | undefined = result?.details;
      if (!details?.outcome) return new Text(theme.fg("muted", result?.content?.[0]?.text ?? ""), 0, 0);
      const answered = details.outcome === "answered";
      const lines = answered ? [] : [theme.fg(details.outcome === "discuss" ? "warning" : "muted", STATUS[details.outcome])];
      for (const item of details.items) {
        const entered = answered ? item.answer : item.draft;
        if (!answered && !entered) continue;
        // Older results carry only the answer text.
        const summary = item.chosen || item.custom ? [item.chosen?.join(", "), item.custom ? `own answer: "${item.custom}"` : ""].filter(Boolean).join("; ") : item.notes ? "" : entered;
        const mark = !answered ? theme.fg("dim", "  draft ") : entered ? theme.fg("success", "✓ ") : theme.fg("dim", "· ");
        lines.push(`${mark}${theme.fg("muted", `${item.header ?? item.question}: `)}${summary || theme.fg("dim", entered ? "notes only" : "left to the agent")}`);
        for (const note of item.notes ?? []) note.text.split("\n").forEach((row, i) =>
          lines.push(`    ${i ? "  " : theme.fg(note.chosen ? "accent" : "dim", "✎ ")}${row}${i ? "" : theme.fg("dim", ` (${note.option}${note.chosen ? "" : ", not chosen"})`)}`));
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // Print and JSON runs never show the tool; nothing is re-enabled later, so /tools choices stand.
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI && pi.getActiveTools().includes(TOOL)) pi.setActiveTools(pi.getActiveTools().filter(name => name !== TOOL));
  });

  // Restate answered questions that compaction removed from context.
  pi.on("context", (event, ctx) => {
    const messages = withLedger(event.messages as any[], ctx.sessionManager.getBranch() as any[]);
    return messages ? { messages } : undefined;
  });
}
