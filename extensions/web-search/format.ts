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

export function formatForLLM(response: SearchResponse): string {
  const parts: string[] = [];
  if (response.answer) {
    parts.push(response.answer);
    if (response.sources.length > 0) {
      parts.push("\n## Sources");
      parts.push(`${response.sources.length} source${response.sources.length === 1 ? "" : "s"}`);
    }
  }
  for (const [i, src] of response.sources.entries()) {
    const age = src.publishedDate ? ` (${src.publishedDate})` : "";
    parts.push(`[${i + 1}] ${src.title}${age}\n    ${src.url}`);
    if (src.snippet) parts.push(`    ${truncateText(src.snippet, 240)}`);
  }
  if (response.citations && response.citations.length > 0) {
    parts.push("\n## Citations");
    for (const [i, citation] of response.citations.entries()) {
      parts.push(`[${i + 1}] ${citation.title || citation.url}\n    ${citation.url}`);
      if (citation.citedText) parts.push(`    ${truncateText(citation.citedText, 240)}`);
    }
  }
  return parts.join("\n");
}

export function formatFailures(errors: Array<{ provider: ProviderId; message: string }>): string {
  if (errors.length === 0) return "Error: No web search provider configured.";
  if (errors.length === 1) return `Error: ${errors[0]!.message}`;
  return `Error: All web search providers failed: ${errors.map((error) => `${error.provider}: ${error.message}`).join("; ")}`;
}

export function withRecencyHint(query: string, recency?: string): string {
  return recency ? `${query} (focus on the past ${recency})` : query;
}

export function citationSnippet(text: string, start?: number, end?: number): string | undefined {
  if (start === undefined || end === undefined || !text) return undefined;
  const snippet = text.slice(Math.max(0, start - 100), Math.min(text.length, end + 100)).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
  if (!snippet) return undefined;
  return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}
