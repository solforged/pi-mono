import type { Theme } from "@earendil-works/pi-coding-agent";
import { excerpt } from "./excerpt.ts";
import { safeText, termsOf, type SearchOptions, type ReadOptions } from "./store.ts";

type Palette = Pick<Theme, "fg" | "bold">;
interface Options { expanded?: boolean; isPartial?: boolean; isError?: boolean; hint?: string }
interface Result { content?: Array<{ type: string; text?: string }>; details?: { full?: unknown } }
const line = (text: unknown, bytes = 180) => excerpt(safeText(typeof text === "string" ? text : "").replace(/\s+/gu, " ").trim(), [], bytes).excerpt;
const number = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : word === "match" || word === "branch" ? "es" : "s"}`;
function preview(text: string, query: unknown): string {
  let terms: string[] = [];
  try { if (typeof query === "string") terms = termsOf(query); } catch { /* Older results may not retain a valid query. */ }
  return excerpt(safeText(text).replace(/\s+/gu, " ").trim(), terms, 220).excerpt;
}
const label = (value: any, expanded = false) => line(value.name || value.session_id, expanded ? 1200 : 120);
function raw(result: Result): string { return (result.content ?? []).filter(c => c.type === "text" && typeof c.text === "string").map(c => c.text).join("\n"); }
function decode(text: string): any { try { return JSON.parse(text); } catch { return undefined; } }
// The model-facing text is pruned; details carry the full result. Results saved before that split hold it as text.
function full(result: Result, text: string): any { return result.details?.full ?? decode(text); }
function isSearch(data: any): boolean {
  return !!data && Array.isArray(data.hits) && typeof data.matching_entries === "number" && data.hits.every((hit: any) => hit && typeof hit.session_id === "string" && typeof hit.entry_id === "string" && typeof hit.excerpt === "string");
}
function hint(options: Options, theme: Palette): string[] { return !options.expanded && options.hint ? [theme.fg("dim", options.hint)] : []; }
function fallback(text: string, theme: Palette, options: Options): string {
  return [theme.fg(options.isError ? "error" : "muted", options.expanded ? safeText(text) : line(text, 240)), ...hint(options, theme)].join("\n");
}
function coverage(data: any, theme: Palette, expanded?: boolean): string[] {
  const c = data.coverage;
  if (!c || typeof c !== "object") return [];
  const lines: string[] = [];
  if (expanded) lines.push(theme.fg("dim", `Coverage: ${number(c.sessions)} sessions, ${number(c.files)} files, ${number(c.bytes)} bytes; ${number(c.excludedCurrent)} active and ${number(c.outOfScope)} out-of-scope files excluded.`));
  if (c.complete === false) {
    lines.push(theme.fg("warning", `Incomplete coverage${number(c.warningCount) ? ` (${plural(number(c.warningCount), "warning")})` : ""}.`));
    const warnings = Array.isArray(c.warnings) ? c.warnings.filter((w: unknown) => typeof w === "string") : [];
    for (const warning of expanded ? warnings : warnings.slice(0, 1)) lines.push(theme.fg("warning", expanded ? safeText(warning) : line(warning)));
    if (expanded && number(c.warningCount) > warnings.length) lines.push(theme.fg("dim", `${number(c.warningCount) - warnings.length} additional warnings not returned.`));
  }
  return lines;
}
function provenance(data: any, theme: Palette): string[] {
  return [
    theme.fg("dim", `Session: ${line(data.session_id, 600)} · ${line(data.timestamp)}`),
    theme.fg("dim", `Directory: ${line(data.cwd, 1200)}`),
    theme.fg("dim", `Revision: ${line(data.revision)}`),
  ];
}

export function searchCall(args: Partial<SearchOptions>, theme: Palette): string {
  const query = args.query === undefined ? "…" : JSON.stringify(line(args.query, 180));
  return theme.fg("toolTitle", theme.bold("session_search ")) + theme.fg("accent", query) + theme.fg("dim", ` · ${line(args.scope ?? "project")}${args.include_tools ? " · tools" : ""}`);
}
export function readCall(args: Partial<ReadOptions>, theme: Palette): string {
  const endpoint = args.entry_id ? ` · entry ${line(args.entry_id, 70)}` : args.leaf_id ? ` · path to ${line(args.leaf_id, 70)}` : "";
  return theme.fg("toolTitle", theme.bold("session_read ")) + theme.fg("accent", line(args.session_id || "…", 90)) + theme.fg("dim", `${endpoint} · ${line(args.scope ?? "project")}${args.offset ? ` · line ${line(String(args.offset))}` : ""}${args.column && args.column > 1 ? `, column ${line(String(args.column))}` : ""}${args.include_tools ? " · tools" : ""}`);
}
export function searchView(result: Result, theme: Palette, options: Options = {}): string {
  const text = raw(result);
  if (options.isError) return fallback(text, theme, options);
  if (options.isPartial) return theme.fg("muted", "Searching saved sessions…");
  const data = full(result, text);
  if (!isSearch(data)) return fallback(text, theme, options);
  const matches = plural(number(data.matching_entries), "match");
  const summary = data.matching_entries ? `${matches}${data.hits.length < data.matching_entries ? ` (${data.hits.length} returned)` : ""}` : "No matches in scanned history";
  const lines = [theme.fg(data.hits.length ? "success" : "muted", summary) + theme.fg("dim", ` · ${plural(number(data.coverage?.sessions), "session")}`)];
  const shown = options.expanded ? data.hits : data.hits.slice(0, 3);
  for (const [i, hit] of shown.entries()) {
    const date = line(hit.entry_timestamp || hit.timestamp).slice(0, 10);
    lines.push(theme.fg("accent", `${i + 1}. ${label(hit, options.expanded)}`) + theme.fg("dim", date ? ` · ${date}` : ""));
    if (options.expanded) {
      lines.push(...provenance(hit, theme));
      lines.push(theme.fg("dim", `Entry: ${line(hit.entry_id, 600)} · parent: ${line(hit.parent_id ?? "root", 600)} · ${line(hit.role)}`));
    }
    lines.push(theme.fg("toolOutput", options.expanded ? safeText(hit.excerpt) : `   ${preview(hit.excerpt, data.query)}`));
  }
  if (shown.length < data.hits.length) lines.push(theme.fg("dim", `${data.hits.length - shown.length} more returned hits.`));
  if (data.has_more) lines.push(theme.fg("dim", "More matches available; refine the query."));
  lines.push(...coverage(data, theme, options.expanded));
  if (options.expanded && typeof data.note === "string") lines.push(theme.fg("dim", safeText(data.note)));
  lines.push(...hint(options, theme));
  return lines.join("\n");
}
export function readView(result: Result, theme: Palette, options: Options = {}): string {
  const text = raw(result);
  if (options.isError) return fallback(text, theme, options);
  if (options.isPartial) return theme.fg("muted", "Reading saved history…");
  const data = full(result, text);
  if (!data || typeof data.session_id !== "string" || typeof data.text !== "string" && !Array.isArray(data.branches)) return fallback(text, theme, options);
  const lines = [theme.fg("accent", label(data, options.expanded))];
  if (options.expanded) lines.push(...provenance(data, theme));
  if (Array.isArray(data.branches)) {
    lines.push(theme.fg("muted", `${plural(data.branches.length, "branch")}; choose a leaf_id.`));
    const branches = options.expanded ? data.branches : data.branches.slice(0, 3);
    for (const branch of branches) lines.push(theme.fg("toolOutput", `  ${line(branch?.leaf_id, options.expanded ? 600 : 90)} · ${line(branch?.timestamp)}`));
    if (branches.length < data.branches.length) lines.push(theme.fg("dim", `${data.branches.length - branches.length} more returned branches.`));
    if (data.branches_truncated) lines.push(theme.fg("warning", "Branch list clipped; search for an entry to address another endpoint."));
    if (options.expanded && typeof data.instruction === "string") lines.push(theme.fg("dim", safeText(data.instruction)));
  } else {
    const body = data.text.replace(/\n$/, "").split("\n");
    const count = data.text ? body.length : 0;
    lines.push(theme.fg("muted", count ? `Lines ${number(data.offset)}–${number(data.offset) + count - 1} of ${number(data.total_lines)}${number(data.column) > 1 ? ` (first line starts at column ${number(data.column)})` : ""}` : "No visible text in this range."));
    if (options.expanded) {
      lines.push(theme.fg("dim", `Endpoint: ${line(data.endpoint_id, 600)} · parent: ${line(data.parent_id ?? "root", 600)}`));
      if (count) lines.push(theme.fg("toolOutput", safeText(data.text).trimEnd()));
    } else {
      for (const row of body.slice(0, 4)) if (row) lines.push(theme.fg("toolOutput", line(row, 220)));
      if (count > 4) lines.push(theme.fg("dim", `${count - 4} more lines in this page.`));
    }
    if (data.next) {
      lines.push(theme.fg("warning", `More available: line ${number(data.next.offset)}, column ${number(data.next.column)}.`));
      if (options.expanded) lines.push(theme.fg("dim", `Continue with session_read ${safeText(JSON.stringify(data.next))}`));
    }
  }
  lines.push(...coverage(data, theme, options.expanded));
  if (options.expanded && typeof data.note === "string") lines.push(theme.fg("dim", safeText(data.note)));
  lines.push(...hint(options, theme));
  return lines.join("\n");
}

export function reportView(text: string, theme: Palette, options: Options): string {
  return isSearch(decode(text)) ? searchView({ content: [{ type: "text", text }] }, theme, options) : safeText(text);
}
