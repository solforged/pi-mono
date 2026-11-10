// /diff opens a live Git diff in a Rex pane beside Pi and follows the files Pi
// edits; it also opens on its own once Pi starts changing files. /md and
// ⌘-clicks on Markdown links show a document in the diff's place until it
// closes. The panes run viewer.ts and doc.ts as their own processes; see
// docs/diff.md.
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex } from "@earendil-works/pi-tui";
import { registerDocs, type Docs } from "./docs.ts";
import { bundledMarked } from "./markdown.ts";
import { bundledHighlighter, registerDiff } from "./pane.ts";
import type { Palette } from "./render.ts";
import { TOKENS } from "./syntax.ts";

function palette(theme: Theme): Partial<Palette> {
  const colors = theme.colors as Record<string, Parameters<typeof colorToHex>[0] | undefined>;
  const hex = (name: string) => { const color = colors[name]; return color ? colorToHex(color) : undefined; };
  const sources: Record<Exclude<keyof Palette, "bg" | "syntax">, string> = {
    text: "text", muted: "muted", dim: "dim", accent: "accent", border: "borderMuted",
    added: "toolDiffAdded", removed: "toolDiffRemoved", context: "toolDiffContext", selectedBg: "selectedBg",
    success: "success", warning: "warning", error: "error",
  };
  const out: Partial<Palette> = theme.appearance === "light" ? { bg: "#ffffff" } : { bg: "#1a1a1a" };
  for (const [key, name] of Object.entries(sources)) {
    const value = hex(name);
    if (value) (out as Record<string, string>)[key] = value;
  }
  out.md = {};
  const md = { heading: "mdHeading", link: "mdLink", code: "mdCode", quote: "mdQuote", quoteBorder: "mdQuoteBorder", hr: "mdHr", bullet: "mdListBullet" } as const;
  for (const [key, name] of Object.entries(md)) {
    const value = hex(name);
    if (value) out.md[key as keyof typeof md] = value;
  }
  out.syntax = {};
  for (const token of TOKENS) {
    const value = hex(`syntax${token[0].toUpperCase()}${token.slice(1)}`);
    if (value) out.syntax[token] = value;
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  const highlighter = bundledHighlighter();
  let docs: Docs | undefined;
  const diff = registerDiff(pi, { palette: (ctx) => palette(ctx.ui.theme), highlighter, held: () => docs?.open() ?? false });
  docs = registerDocs(pi, { palette: (ctx) => palette(ctx.ui.theme), highlighter, marked: bundledMarked(), diff });
}
