import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { callLine, completionLines, splitResult, taskLine, type TaskMeta } from "./ui.ts";

type Tool = "rex_agent" | "rex_send" | "rex_result";
const textOf = (result: any) => (result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

/** Compact tool rows: one status line collapsed; the answer as Markdown when expanded. */
export function toolRenderers(tool: Tool) {
  return {
    renderCall(args: any, theme: any) { return new Text(callLine(tool, args ?? {}, theme), 0, 0); },
    renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context?: any) {
      if (options.isPartial) return new Text(theme.fg("dim", "starting…"), 0, 0);
      const meta: TaskMeta | undefined = result?.details?.task, text = textOf(result);
      const hint = context?.keyHint?.("app.tools.expand", "to expand") ?? "";
      if (!meta) {
        const first = text.split("\n")[0] ?? "";
        if (!options.expanded) return new Text(`${result?.isError ? theme.fg("error", first) : theme.fg("muted", first)}${text.includes("\n") && hint ? theme.fg("dim", ` (${hint})`) : ""}`, 0, 0);
        return new Text(result?.isError ? theme.fg("error", text) : text, 0, 0);
      }
      const { header, answer } = splitResult(text), line = taskLine(meta, theme);
      if (!options.expanded) return new Text(`${line}${answer && hint ? theme.fg("dim", ` (${hint})`) : ""}`, 0, 0);
      const box = new Container();
      box.addChild(new Text(line, 0, 0));
      if (answer) { box.addChild(new Spacer(1)); box.addChild(new Markdown(answer, 0, 0, getMarkdownTheme())); }
      box.addChild(new Spacer(1)); box.addChild(new Text(theme.fg("dim", header), 0, 0));
      return box;
    },
  };
}

export function completionRenderer(message: any, options: any, theme: any) {
  const items: TaskMeta[] = message?.details?.items ?? [];
  if (!items.length) return new Text(theme.fg("dim", String(message?.content ?? "")), options?.outputPad ?? 0, 0);
  return new Text([theme.fg("dim", "Rex results ready"), ...completionLines(items, theme)].join("\n"), options?.outputPad ?? 0, 0);
}
