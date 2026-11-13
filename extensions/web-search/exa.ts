import { errorDetail, ProviderError, type SearchResponse, type Source } from "./format.ts";

const EXA_API_URL = "https://api.exa.ai/search";
const MAX_ANSWER_SUMMARIES = 3;

export type ExaResult = {
  url?: string;
  title?: string;
  summary?: string;
  text?: string;
  highlights?: string[];
  publishedDate?: string;
  author?: string;
};

export type ExaJson = {
  requestId?: string;
  results?: ExaResult[];
};

export function recencyStartDate(recency?: string, now = new Date()): string | undefined {
  if (!recency) return;
  const days = recency === "day" ? 1 : recency === "week" ? 7 : recency === "month" ? 30 : recency === "year" ? 365 : 0;
  if (!days) return;
  const start = new Date(now.getTime() - days * 86400000);
  return start.toISOString().slice(0, 10);
}

export function synthesizeAnswer(results: ExaResult[]): string | undefined {
  const parts: string[] = [];
  for (const result of results) {
    if (parts.length >= MAX_ANSWER_SUMMARIES) break;
    const summary = result.summary?.trim();
    if (!summary) continue;
    const title = result.title?.trim() || result.url || "Untitled";
    parts.push(`**${title}**: ${summary}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function buildExaBody(query: string, options: { limit?: number; recency?: string; now?: Date } = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query,
    numResults: options.limit ?? 10,
    type: "auto",
    contents: { summary: { query } },
  };
  const start = recencyStartDate(options.recency, options.now);
  if (start) body.startPublishedDate = start;
  return body;
}

export function parseExaResponse(response: ExaJson, limit?: number): SearchResponse {
  const sources: Source[] = [];
  for (const result of response.results ?? []) {
    if (!result.url) continue;
    const snippet = result.summary || result.text || result.highlights?.join(" ");
    sources.push({
      title: result.title ?? result.url,
      url: result.url,
      snippet: snippet?.slice(0, 500),
      publishedDate: result.publishedDate,
    });
  }
  const limited = limit ? sources.slice(0, limit) : sources;
  const answer = synthesizeAnswer((response.results ?? []).filter((result) => result.url));
  return { provider: "exa", answer, sources: limited };
}

export async function searchExa(options: {
  apiKey: string;
  query: string;
  limit?: number;
  recency?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<SearchResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(EXA_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": options.apiKey },
    body: JSON.stringify(buildExaBody(options.query, { limit: options.limit, recency: options.recency })),
    signal: options.signal,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new ProviderError("exa", `Exa API error (${response.status}): ${errorDetail(text)}`, response.status);
  }
  return parseExaResponse(await response.json() as ExaJson, options.limit);
}
