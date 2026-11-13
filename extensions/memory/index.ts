// Keeps the memory wiki's small always-on layer in front of the model: each
// bundle's now.md in the system prompt, and a glossary entry the first time a
// prompt uses its term. The memory tool reaches the rest on demand and makes
// the three writes the user confirms. See docs/memory.md.
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { TERMS_TYPE } from "./context.ts";
import { type Details, register } from "./session.ts";
import { ACTIONS, DESCRIPTION, execute, type Params, TOOL, WRITES } from "./tool.ts";

export default function (pi: ExtensionAPI) {
  const session = register(pi);

  pi.registerMessageRenderer(TERMS_TYPE, (message, options, theme) => {
    const names = (message.details as Details | undefined)?.names ?? [];
    let text = theme.fg("dim", "◇ ") + theme.fg("muted", `Glossary: ${names.join(", ") || "terms"}`);
    if (options.expanded) text += "\n" + theme.fg("dim", String(message.content));
    return new Text(text, options.outputPad, 0);
  });

  pi.registerTool({
    name: TOOL,
    label: "Memory",
    description: DESCRIPTION,
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      words: Type.Optional(Type.String({ description: "search: words that must all appear" })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "read: wiki paths, such as work/now.md" })),
      term: Type.Optional(Type.String({ description: "define: the term to look up; term: the term to add or change" })),
      aliases: Type.Optional(Type.Array(Type.String(), { description: "term: other names for it" })),
      replace: Type.Optional(Type.Boolean({ description: "term: change the existing entry" })),
      text: Type.Optional(Type.String({ description: "jot: the learning; term: the definition; now: the complete new text" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const p = params as Params;
      const scope = WRITES.has(p.action) ? await session.scope(ctx.cwd) : "";
      const confirm = ctx.hasUI ? (title: string, body: string) => ctx.ui.confirm(title, body) : undefined;
      const text = await execute(session.binary, p, ctx.cwd, scope, confirm, signal);
      return { content: [{ type: "text", text }], details: { action: p.action } };
    },
    renderCall(args: any, theme) {
      const subject = args.words ?? args.term ?? (args.paths?.length ? args.paths.join(" ") : undefined) ?? (args.action === "jot" ? args.text : undefined);
      let text = theme.fg("toolTitle", theme.bold("memory ")) + theme.fg("muted", args.action ?? "");
      if (subject) text += ` ${theme.fg("dim", String(subject).length > 80 ? `${String(subject).slice(0, 79)}…` : String(subject))}`;
      return new Text(text, 0, 0);
    },
  });
}
