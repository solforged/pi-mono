import {
  addSource,
  citationSnippet,
  preferFirst,
  ProviderError,
  SYSTEM_PROMPT,
  type SearchResponse,
  type Source,
} from "./format.ts";
import { readSseJson } from "./sse.ts";

const DEFAULT_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"];
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export type CodexAuth = {
  token: string;
  baseUrl?: string;
  headers?: Record<string, string | null>;
};

export function resolveCodexUrl(baseUrl?: string): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/responses")) return normalized;
  return `${normalized}/responses`;
}

export function shouldRetryCodexModel(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.provider !== "codex") return false;
  if (error.status === 502) return true;
  if (error.status !== 400) return false;
  return /model is not supported|requested model is not supported|not supported when using codex with a chatgpt account/i.test(error.message);
}

function extractSseError(raw: Record<string, unknown>): { code: string; message: string } {
  const candidates = [raw, raw.error, (raw.response as { error?: unknown } | undefined)?.error];
  let code = "";
  let message = "";
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    if (!code && typeof record.code === "string") code = record.code;
    if (!message && typeof record.message === "string") message = record.message;
  }
  return { code, message };
}

function classifyStatus(code: string, message: string): number {
  const detail = `${code} ${message}`.toLowerCase();
  if (/rate[- ]?limit|too many requests|quota|\b429\b/u.test(detail)) return 429;
  if (/unauthori[sz]ed|\b401\b/u.test(detail)) return 401;
  if (/forbidden|\b403\b/u.test(detail)) return 403;
  if (/timeout|timed out/u.test(detail)) return 504;
  return 500;
}

function countCharacter(text: string, target: string): number {
  let count = 0;
  for (const char of text) if (char === target) count += 1;
  return count;
}

function normalizeExtractedUrl(candidate: string): string | null {
  let url = candidate.trim();
  while (url.length > 0) {
    const last = url.at(-1);
    if (!last) break;
    if (/[.,!?;:'"]/u.test(last)) { url = url.slice(0, -1); continue; }
    if (last === ")" && countCharacter(url, ")") > countCharacter(url, "(")) { url = url.slice(0, -1); continue; }
    if (last === "]" && countCharacter(url, "]") > countCharacter(url, "[")) { url = url.slice(0, -1); continue; }
    break;
  }
  if (!/^https?:\/\//.test(url)) return null;
  try { return new URL(url).toString(); } catch { return null; }
}

export function extractTextSources(text: string): Source[] {
  const sources: Source[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "[") continue;
    const titleEnd = text.indexOf("]", index + 1);
    if (titleEnd === -1 || text[titleEnd + 1] !== "(") continue;
    let depth = 0;
    let urlEnd: number | null = null;
    for (let i = titleEnd + 1; i < text.length; i += 1) {
      const ch = text[i];
      if (!ch || ch === "\n") break;
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) { urlEnd = i; break; }
        if (depth < 0) break;
      }
    }
    if (urlEnd === null) continue;
    const title = text.slice(index + 1, titleEnd).trim();
    const url = normalizeExtractedUrl(text.slice(titleEnd + 2, urlEnd));
    if (url) addSource(sources, { title: title || url, url });
    index = urlEnd;
  }
  for (const match of text.matchAll(/https?:\/\/\S+/g)) {
    const url = normalizeExtractedUrl(match[0] ?? "");
    if (url) addSource(sources, { title: url, url });
  }
  return sources;
}

export function consumeCodexEvents(events: Iterable<Record<string, unknown>>, requestedModel: string): SearchResponse {
  const sources: Source[] = [];
  const answerParts: string[] = [];
  const streamed: string[] = [];
  let model = requestedModel;
  let requestId = "";
  let webSearchInvoked = false;

  for (const raw of events) {
    const eventType = typeof raw.type === "string" ? raw.type : "";
    if (!eventType) continue;
    if (eventType.startsWith("response.web_search_call")) webSearchInvoked = true;
    if (eventType === "response.created") {
      const resp = raw.response as { id?: string; model?: string } | undefined;
      if (resp?.id) requestId = resp.id;
      if (resp?.model) model = resp.model;
    } else if (eventType === "response.output_text.delta" && typeof raw.delta === "string") {
      streamed.push(raw.delta);
    } else if (eventType === "response.output_item.done") {
      const item = raw.item as Record<string, any> | undefined;
      if (!item) continue;
      if (item.type === "web_search_call") {
        webSearchInvoked = true;
        for (const group of [item.action?.sources, item.sources, item.results]) {
          for (const source of group ?? []) {
            const url = source?.url ?? source?.source_website_url;
            if (typeof url === "string" && url) addSource(sources, { title: source.title ?? source.caption ?? url, url });
          }
        }
      }
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part?.type === "output_text" && typeof part.text === "string") {
            answerParts.push(part.text);
            for (const annotation of part.annotations ?? []) {
              if (annotation?.type === "url_citation" && typeof annotation.url === "string") {
                addSource(sources, {
                  title: annotation.title ?? annotation.url,
                  url: annotation.url,
                  snippet: citationSnippet(part.text, annotation.start_index, annotation.end_index),
                });
              }
            }
          }
        }
      }
    } else if (eventType === "response.completed" || eventType === "response.done") {
      const resp = raw.response as { id?: string; model?: string } | undefined;
      if (resp?.id) requestId = resp.id;
      if (resp?.model) model = resp.model;
    } else if (eventType === "error" || eventType === "response.failed") {
      const { code, message } = extractSseError(raw);
      throw new ProviderError("codex", `Codex ${eventType === "error" ? "error" : "request failed"} (${code}): ${message || "Unknown error"}`, classifyStatus(code, message));
    }
  }

  if (!webSearchInvoked) {
    throw new ProviderError("codex", "Codex returned a completion without running web search", 502);
  }
  const answer = answerParts.join("\n\n").trim() || streamed.join("").trim();
  if (!answer && sources.length === 0) throw new ProviderError("codex", "Codex returned no search content", 502);
  if (sources.length === 0 && answer) {
    for (const source of extractTextSources(answer)) addSource(sources, source);
  }
  return { provider: "codex", answer: answer || undefined, sources, model, requestId: requestId || undefined };
}

function codexHeaders(auth: CodexAuth): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  headers.set("Authorization", `Bearer ${auth.token}`);
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  return headers;
}

export function codexModels(sessionModel?: string): string[] {
  const configured = process.env.PI_CODEX_WEB_SEARCH_MODEL?.trim();
  if (configured) return [configured];
  return preferFirst(sessionModel, DEFAULT_MODELS);
}

export async function searchCodex(options: {
  auth: CodexAuth;
  query: string;
  sessionModel?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<SearchResponse> {
  const models = codexModels(options.sessionModel);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = resolveCodexUrl(options.auth.baseUrl);
  let lastError: unknown;
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: codexHeaders(options.auth),
        body: JSON.stringify({
          model,
          stream: true,
          store: false,
          include: ["web_search_call.action.sources"],
          parallel_tool_calls: true,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: options.query }] }],
          tools: [{ type: "web_search", search_context_size: "high" }],
          tool_choice: { type: "web_search" },
          instructions: SYSTEM_PROMPT,
        }),
        signal: options.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new ProviderError("codex", `Codex API error (${response.status}): ${text}`, response.status);
      }
      if (!response.body) throw new ProviderError("codex", "Codex API returned no response body", 500);
      const events: Record<string, unknown>[] = [];
      for await (const event of readSseJson(response.body, options.signal)) events.push(event);
      return consumeCodexEvents(events, model);
    } catch (error) {
      lastError = error;
      const last = index === models.length - 1;
      if (process.env.PI_CODEX_WEB_SEARCH_MODEL || last || !shouldRetryCodexModel(error)) throw error;
    }
  }
  throw lastError ?? new ProviderError("codex", "Codex search failed without returning a result");
}
