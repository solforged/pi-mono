// /diff opens a live Git diff in a Rex pane beside Pi and follows the files Pi
// edits; it also opens on its own once Pi starts changing files. The pane runs
// viewer.ts as its own process; see docs/diff.md.
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex } from "@earendil-works/pi-tui";
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
  out.syntax = {};
  for (const token of TOKENS) {
    const value = hex(`syntax${token[0].toUpperCase()}${token.slice(1)}`);
    if (value) out.syntax[token] = value;
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  registerDiff(pi, { palette: (ctx) => palette(ctx.ui.theme), highlighter: bundledHighlighter() });
}
