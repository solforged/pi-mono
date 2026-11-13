export type ProviderId = "codex" | "xai" | "exa";

export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly status?: number;
  constructor(provider: ProviderId, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
  }
}

export type Source = {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
};

export type Citation = {
  title: string;
  url: string;
  citedText?: string;
};

export type SearchResponse = {
  provider: ProviderId;
  answer?: string;
  sources: Source[];
  citations?: Citation[];
  model?: string;
  requestId?: string;
};

export const DEFAULT_ORDER: ProviderId[] = ["codex", "xai", "exa"];
export const SEARCH_TIMEOUT_MS = 60_000;

export function backendForSession(provider?: string): ProviderId | undefined {
  if (!provider) return;
  const id = provider.toLowerCase();
  if (id === "openai-codex" || id === "openai") return "codex";
  if (id === "xai" || id === "grok" || id === "xai-oauth") return "xai";
}

export function preferFirst<T>(preferred: T | undefined, rest: readonly T[]): T[] {
  if (preferred === undefined) return [...rest];
  return [preferred, ...rest.filter((item) => item !== preferred)];
}

export function searchOrder(sessionProvider?: string, explicit?: ProviderId | "auto"): ProviderId[] {
  if (explicit && explicit !== "auto") return [explicit];
  return preferFirst(backendForSession(sessionProvider), DEFAULT_ORDER);
}
export const SYSTEM_PROMPT = "Web research assistant: accurate, well-sourced answers. Prefer primary sources. Cite URLs. Direct answer first, then evidence.";

export function hasRenderableSearchContent(response: SearchResponse): boolean {
  return Boolean(response.answer?.trim() || response.sources.length > 0 || response.citations?.length);
}

export function truncateText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 3)}...`;
}

// An API error body, cut down for an error message: the API's own message when
// the body is JSON, and never a whole HTML error page.
export function errorDetail(body: string): string {
  let text = body;
  try {
    const json = JSON.parse(body);
    const found = [json?.error?.message, json?.error, json?.message, json?.detail].find((value) => typeof value === "string" && value.trim());
    if (found) text = found;
  } catch { /* not JSON */ }
  return truncateText(text.replace(/\s+/g, " "), 500);
}

export function addSource(sources: Source[], source: Source): void {
  const url = cleanSourceUrl(source.url);
  const existing = sources.find((candidate) => candidate.url === url);
  if (!existing) {
    sources.push({ ...source, url });
    return;
  }
  if (existing.title === existing.url && source.title !== source.url) existing.title = source.title;
  if (!existing.snippet && source.snippet) existing.snippet = source.snippet;
}

export function cleanSourceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
    return url.toString();
  } catch {
    return rawUrl.replace(/[?&]utm_source=openai$/u, "");
  }
}

/** Sources listed when the model asks for no particular number. */
export const DEFAULT_SOURCES = 10;
export const MAX_SOURCES = 20;
/** The longest answer passed on; it stays in the conversation for every later request. */
export const ANSWER_MAX = 12_000;

/** The model's `limit`, as a whole number of sources within bounds. */
export function sourceLimit(limit: unknown): number | undefined {
  return typeof limit === "number" && Number.isFinite(limit) ? Math.min(MAX_SOURCES, Math.max(1, Math.trunc(limit))) : undefined;
}

// Whether `text` holds `url` itself, not a longer URL that starts with it.
function mentions(text: string, url: string): boolean {
  for (let at = text.indexOf(url); at >= 0; at = text.indexOf(url, at + 1)) {
    if (!/^(?:[\w/%?#&=~+@-]|\.\w)/u.test(text.slice(at + url.length, at + url.length + 2))) return true;
  }
  return false;
}

// One numbered list after the answer. Nothing is repeated: a citation whose
// page is already a source adds only its quote, and a snippet the answer
// already contains is left out. A backend may return every page it read, so
// the list stops at `limit`, keeping first the pages the answer cites.
export function formatForLLM(response: SearchResponse, limit = DEFAULT_SOURCES): string {
  const full = response.answer?.trim() ?? "";
  const answer = full.length > ANSWER_MAX ? `${full.slice(0, ANSWER_MAX)}\n[Answer cut at ${ANSWER_MAX.toLocaleString("en-US")} characters.]` : full;
  const all = response.sources.map((source) => ({ ...source }));
  for (const citation of response.citations ?? []) {
    const listed = all.find((item) => item.url === citation.url);
    if (!listed) all.push({ title: citation.title || citation.url, url: citation.url, snippet: citation.citedText });
    else if (!listed.snippet && citation.citedText) listed.snippet = citation.citedText;
  }
  const cited = (url: string) => mentions(answer, url) || (response.citations ?? []).some((citation) => citation.url === url);
  const items = all.length > limit ? [...all.filter((item) => cited(item.url)), ...all.filter((item) => !cited(item.url))].slice(0, limit) : all;
  const parts: string[] = answer ? [answer] : [];
  if (answer && items.length > 0) parts.push("\nSources:");
  for (const [i, item] of items.entries()) {
    const title = item.title && item.title !== item.url ? `${item.title} ` : "";
    const date = item.publishedDate ? `(${item.publishedDate.slice(0, 10)}) ` : "";
    parts.push(`[${i + 1}] ${title}${date}${item.url}`);
    const snippet = item.snippet?.trim();
    if (snippet && !answer.includes(snippet.slice(0, 80))) parts.push(`  ${truncateText(snippet, 240)}`);
  }
  if (all.length > items.length) parts.push(`(${all.length - items.length} more sources not listed)`);
  return parts.join("\n");
}

export type Attempt = { provider: ProviderId; outcome: "answered" | "not configured" | "failed" | "timed out"; message?: string };

/** The backends that were tried before the answer, for the user. Unconfigured ones are routine and listed only on request. */
export function attemptSummary(attempts: Attempt[], all = false): string {
  return attempts
    .filter((attempt) => attempt.outcome !== "answered" && (all || attempt.outcome !== "not configured"))
    .map(({ provider, outcome, message }) => !message ? `${provider} ${outcome}` : message.toLowerCase().startsWith(provider) ? message : `${provider}: ${message}`)
    .join("; ");
}

export function formatFailures(errors: Array<{ provider: ProviderId; message: string }>): string {
  if (errors.length === 0) return "Error: No web search provider configured.";
  if (errors.length === 1) return `Error: ${errors[0]!.message}`;
  return `Error: All web search providers failed: ${errors.map((error) => `${error.provider}: ${error.message}`).join("; ")}`;
}

export const RECENCIES = ["day", "week", "month", "year"] as const;
// Models that must fill every field send "null" or "" for no recency; search without one.
export function dropBlankRecency(args: unknown): unknown {
  const input = (args ?? {}) as { recency?: unknown };
  if (input.recency === undefined || RECENCIES.includes(input.recency as any)) return args;
  const { recency: _blank, ...rest } = input;
  return rest;
}

export function withRecencyHint(query: string, recency?: string): string {
  return recency ? `${query} (focus on the past ${recency})` : query;
}
