import { searchCodex } from "./codex.ts";
import { searchExa } from "./exa.ts";
import {
  backendForSession,
  formatFailures,
  formatForLLM,
  hasRenderableSearchContent,
  ProviderError,
  SEARCH_TIMEOUT_MS,
  searchOrder,
  withRecencyHint,
  type ProviderId,
  type SearchResponse,
} from "./format.ts";
import { searchXai, type XaiAuth } from "./xai.ts";

export type AuthSource = {
  token: string;
  baseUrl?: string;
  headers?: Record<string, string | null>;
};

export type SearchAuth = {
  codex?: () => Promise<AuthSource | undefined>;
  xai?: () => Promise<AuthSource | undefined>;
  exa?: () => Promise<string | undefined>;
};

export type SearchQuery = {
  query: string;
  recency?: "day" | "week" | "month" | "year";
  limit?: number;
  provider?: ProviderId | "auto";
  sessionProvider?: string;
  sessionModel?: string;
};

export type SearchResult = {
  text: string;
  response?: SearchResponse;
  error?: string;
};

type Registry = {
  getProviderAuth(id: string): Promise<{
    auth: { apiKey?: string; baseUrl?: string; headers?: Record<string, string | null> };
  } | undefined>;
};

export function registryAuth(registry: Registry): SearchAuth {
  return {
    async codex() {
      const result = await registry.getProviderAuth("openai");
      const token = result?.auth.apiKey;
      if (!token) return;
      return { token, baseUrl: result.auth.baseUrl, headers: result.auth.headers };
    },
    async xai() {
      const result = await registry.getProviderAuth("xai");
      const token = result?.auth.apiKey;
      if (!token) return;
      return { token, baseUrl: result.auth.baseUrl, headers: result.auth.headers };
    },
    async exa() {
      const key = process.env.EXA_API_KEY?.trim();
      return key || undefined;
    },
  };
}

export async function availableProviders(auth: SearchAuth): Promise<Record<ProviderId, boolean>> {
  const [codex, xai, exa] = await Promise.all([
    auth.codex?.().then((value) => Boolean(value), () => false) ?? false,
    auth.xai?.().then((value) => Boolean(value), () => false) ?? false,
    auth.exa?.().then((value) => Boolean(value), () => false) ?? false,
  ]);
  return { codex, xai, exa };
}

function candidates(query: SearchQuery): ProviderId[] {
  return searchOrder(query.sessionProvider, query.provider);
}

// Rejects when the signal aborts, for steps that take no signal (credential refresh, body parsing).
const abandoned = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

export async function executeSearch(query: SearchQuery, options: {
  auth: SearchAuth;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<SearchResult> {
  const order = candidates(query);
  const errors: Array<{ provider: ProviderId; message: string }> = [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const hinted = withRecencyHint(query.query, query.recency);

  const explicit = Boolean(query.provider && query.provider !== "auto");
  for (const provider of order) {
    // Each backend has its own time limit, so a stalled one still falls through
    // to the next. Only the caller's cancellation ends the whole search.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      signal.throwIfAborted();
      const response = await Promise.race([runProvider(provider, hinted, query, options.auth, signal, fetchImpl), abandoned(signal)]);
      if (response === "skip") {
        if (explicit) errors.push({ provider, message: `${provider} credentials not configured` });
        continue;
      }
      if (!hasRenderableSearchContent(response)) {
        throw new ProviderError(provider, `${provider} returned no search content`, 204);
      }
      return { text: formatForLLM(response), response };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const message = timeout.aborted ? `${provider} timed out after ${Math.round(timeoutMs / 1000)} s`
        : error instanceof Error ? error.message : String(error);
      errors.push({ provider, message });
    }
  }
  const text = formatFailures(errors);
  return { text, error: text };
}

async function runProvider(
  provider: ProviderId,
  query: string,
  params: SearchQuery,
  auth: SearchAuth,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<SearchResponse | "skip"> {
  if (provider === "codex") {
    const creds = await auth.codex?.();
    if (!creds?.token) return "skip";
    const sessionModel = backendForSession(params.sessionProvider) === "codex" ? params.sessionModel : undefined;
    return searchCodex({ auth: creds, query, sessionModel, signal, fetchImpl });
  }
  if (provider === "xai") {
    const creds = await auth.xai?.();
    if (!creds) return "skip";
    const sessionModel = backendForSession(params.sessionProvider) === "xai" ? params.sessionModel : undefined;
    return searchXai({ auth: creds as XaiAuth, query, sessionModel, limit: params.limit, signal, fetchImpl });
  }
  const apiKey = await auth.exa?.();
  if (!apiKey) return "skip";
  return searchExa({ apiKey, query: params.query, limit: params.limit, recency: params.recency, signal, fetchImpl });
}
