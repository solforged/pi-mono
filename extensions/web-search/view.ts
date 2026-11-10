import type { Theme } from "@earendil-works/pi-coding-agent";
import { attemptSummary } from "./format.ts";

type Palette = Pick<Theme, "fg" | "bold">;
interface Options { expanded?: boolean; isPartial?: boolean; isError?: boolean; hint?: string }
interface Result { content?: Array<{ type: string; text?: string }>; details?: any }

// Web text is untrusted: terminal control characters are shown, never sent to the terminal.
const safe = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
function clip(value: unknown, max = 160): string {
  const line = safe(typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
const body = (result: Result) => (result.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function view(result: Result, theme: Palette, options: Options, waiting: string, head: (details: any) => string): string {
  if (options.isPartial) return theme.fg("muted", waiting);
  const text = body(result), hint = !options.expanded && options.hint ? [theme.fg("dim", options.hint)] : [];
  if (options.isError) return [theme.fg("error", options.expanded ? safe(text) : clip(text, 240)), ...hint].join("\n");
  const rows = text.split("\n").filter((row) => row.trim());
  const shown = options.expanded ? [theme.fg("toolOutput", safe(text).trimEnd())]
    : [...rows.slice(0, 3).map((row) => theme.fg("toolOutput", clip(row, 200))), ...(rows.length > 3 ? [theme.fg("dim", `${rows.length - 3} more lines`)] : [])];
  return [head(result.details ?? {}), ...shown, ...hint].join("\n");
}

export function searchCall(args: { query?: unknown; recency?: unknown }, theme: Palette): string {
  const query = args.query === undefined ? "…" : JSON.stringify(clip(args.query));
  return theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", query) + theme.fg("dim", args.recency ? ` · past ${clip(args.recency, 10)}` : "");
}
export function searchView(result: Result, theme: Palette, options: Options = {}): string {
  return view(result, theme, options, "Searching the web…", (details) => {
    const trouble = attemptSummary(Array.isArray(details.attempts) ? details.attempts : [], options.expanded);
    const backend = `${clip(details.provider ?? "search", 20)}${options.expanded && details.model ? ` (${clip(details.model, 60)})` : ""}`;
    return theme.fg("success", `${backend} · ${plural(Array.isArray(details.sources) ? details.sources.length : 0, "source")}`) + (trouble ? theme.fg("warning", ` · after ${clip(trouble, options.expanded ? 1200 : 160)}`) : "");
  });
}
export function fetchCall(args: { url?: unknown; find?: unknown; offset?: unknown }, theme: Palette): string {
  const part = args.find ? ` · find ${JSON.stringify(clip(args.find, 60))}` : "";
  return theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", clip(args.url ?? "…", 200)) + theme.fg("dim", `${part}${args.offset ? ` · from ${clip(String(args.offset), 12)}` : ""}`);
}
export function fetchView(result: Result, theme: Palette, options: Options = {}): string {
  return view(result, theme, options, "Fetching…", (details) =>
    theme.fg("success", clip(details.title || details.url || "page", options.expanded ? 600 : 100)) + theme.fg("dim", typeof details.chars === "number" ? ` · ${details.chars.toLocaleString("en-US")} chars` : ""));
}
