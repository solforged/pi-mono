import {
  addSource,
  citationSnippet,
  preferFirst,
  ProviderError,
  SYSTEM_PROMPT,
  type Citation,
  type SearchResponse,
  type Source,
} from "./format.ts";

const DEFAULT_MODELS = ["grok-4.7"];
const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_CAP = 10;
const MAX_CAP = 30;

export type XaiAuth = {
  token: string;
  baseUrl?: string;
  headers?: Record<string, string | null>;
};

type XaiJson = {
  id?: string;
  model?: string;
  output_text?: string | null;
  output?: Array<Record<string, any>> | null;
  annotations?: Array<Record<string, any>> | null;
  citations?: string[] | null;
};

function collectAnnotation(
  annotations: Array<Record<string, any>> | null | undefined,
  sources: Source[],
  citations: Citation[],
  seen: Set<string>,
  contentText?: string,
): void {
  if (!Array.isArray(annotations)) return;
  for (const annotation of annotations) {
    if (annotation?.type !== "url_citation" || typeof annotation.url !== "string") continue;
    const url = annotation.url.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = (typeof annotation.title === "string" && annotation.title.trim()) || url;
    const snippet = annotation.cited_text ?? annotation.text ?? citationSnippet(contentText ?? "", annotation.start_index, annotation.end_index);
    const source = { title, url, snippet: typeof snippet === "string" && snippet.trim() ? snippet.trim() : undefined };
    addSource(sources, source);
    citations.push({ title, url, citedText: source.snippet });
  }
}

export function parseXaiResponse(response: XaiJson, resultCap = DEFAULT_CAP): SearchResponse {
  const sources: Source[] = [];
  const citations: Citation[] = [];
  const seen = new Set<string>();
  collectAnnotation(response.annotations, sources, citations, seen);
  const output = Array.isArray(response.output) ? response.output : [];
  let searched = false;
  for (const item of output) {
    collectAnnotation(item?.annotations, sources, citations, seen);
    for (const part of item?.content ?? []) {
      collectAnnotation(part?.annotations, sources, citations, seen, part?.output_text ?? part?.text);
    }
  }
  for (const item of output) {
    if (item?.type !== "web_search_call") continue;
    searched = true;
    for (const group of [item.action?.sources, item.sources, item.results]) {
      if (!Array.isArray(group)) continue;
      for (const source of group) {
        const url = source?.url ?? source?.source_website_url;
        if (typeof url !== "string" || !url.trim() || seen.has(url.trim())) continue;
        seen.add(url.trim());
        const title = source.title ?? source.caption ?? url;
        addSource(sources, { title, url });
        citations.push({ title, url: url.trim() });
      }
    }
  }
  for (const url of Array.isArray(response.citations) ? response.citations : []) {
    if (typeof url === "string" && url.trim() && !seen.has(url.trim())) {
      seen.add(url.trim());
      addSource(sources, { title: url, url });
      citations.push({ title: url, url: url.trim() });
    }
  }
  const cap = Math.min(Math.max(resultCap, 1), MAX_CAP);
  const answer = parseAnswer(response);
  if (!searched && sources.length === 0) {
    throw new ProviderError("xai", "xAI returned a completion without running web search", 502);
  }
  return {
    provider: "xai",
    answer,
    sources: sources.slice(0, cap),
    citations: citations.length > 0 ? citations.slice(0, cap) : undefined,
    model: response.model,
    requestId: response.id,
  };
}

function parseAnswer(response: XaiJson): string | undefined {
  const top = response.output_text?.trim();
  if (top) return top;
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    for (const part of item?.content ?? []) {
      const text = part?.output_text ?? part?.text;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  }
  const answer = parts.join("\n").trim();
  return answer || undefined;
}

export function buildXaiBody(query: string, model: string): Record<string, unknown> {
  return {
    model,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: query },
    ],
    tools: [{ type: "web_search" }],
    reasoning: { effort: "low" },
  };
}

export function xaiModels(sessionModel?: string): string[] {
  const configured = process.env.PI_XAI_WEB_SEARCH_MODEL?.trim();
  if (configured) return [configured];
  return preferFirst(sessionModel, DEFAULT_MODELS);
}

function xaiHeaders(auth: XaiAuth): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  headers.set("Authorization", `Bearer ${auth.token}`);
  headers.set("content-type", "application/json");
  return headers;
}

export async function searchXai(options: {
  auth: XaiAuth;
  query: string;
  sessionModel?: string;
  limit?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<SearchResponse> {
  const models = xaiModels(options.sessionModel);
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.auth.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/responses`;
  let lastError: unknown;
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: xaiHeaders(options.auth),
        body: JSON.stringify(buildXaiBody(options.query, model)),
        signal: options.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new ProviderError("xai", `xAI Responses API error (${response.status}): ${text}`, response.status);
      }
      const json = await response.json() as XaiJson;
      return parseXaiResponse(json, options.limit ?? DEFAULT_CAP);
    } catch (error) {
      lastError = error;
      const last = index === models.length - 1;
      const retry = error instanceof ProviderError && (error.status === 400 || error.status === 502);
      if (process.env.PI_XAI_WEB_SEARCH_MODEL || last || !retry) throw error;
    }
  }
  throw lastError ?? new ProviderError("xai", "xAI search failed without returning a result");
}
