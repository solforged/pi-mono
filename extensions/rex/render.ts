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
      const text = textOf(result);
      if (options.isPartial) return new Text(theme.fg("dim", text.split("\n")[0] || "starting…"), 0, 0);
      const meta: TaskMeta | undefined = result?.details?.task;
      const hint = context?.keyHint?.("app.tools.expand", "to expand") ?? "";
      const batch: TaskMeta[] | undefined = result?.details?.tasks;
      if (batch?.length) {
        const parts: number[] = result.details.parts ?? [], more: number = result.details.more ?? 0;
        const tail = more ? theme.fg("dim", `${more} more ready`) : "";
        if (!options.expanded) return new Text([...batch.map((m, i) => `${taskLine(m, theme)}${i === batch.length - 1 && hint ? theme.fg("dim", ` (${hint})`) : ""}`), ...(tail ? [tail] : [])].join("\n"), 0, 0);
        const box = new Container();
        let at = 0;
        batch.forEach((m, i) => {
          const { header, answer } = splitResult(text.slice(at, at + (parts[i] ?? 0))); at += (parts[i] ?? 0) + 2;
          if (i) box.addChild(new Spacer(1));
          box.addChild(new Text(taskLine(m, theme), 0, 0));
          if (answer) { box.addChild(new Spacer(1)); box.addChild(new Markdown(answer, 0, 0, getMarkdownTheme())); }
          box.addChild(new Text(theme.fg("dim", header), 0, 0));
        });
        if (tail) { box.addChild(new Spacer(1)); box.addChild(new Text(tail, 0, 0)); }
        return box;
      }
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
