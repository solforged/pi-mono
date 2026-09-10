import { extractAccountId, searchCodex, type CodexAuth } from "./codex.ts";
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
  codex?: () => Promise<(AuthSource & { accountId?: string }) | undefined>;
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
      const result = await registry.getProviderAuth("openai-codex");
      const token = result?.auth.apiKey;
      if (!token) return;
      const accountId = extractAccountId(token);
      if (!accountId) return;
      return { token, accountId, baseUrl: result.auth.baseUrl, headers: result.auth.headers };
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

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function executeSearch(query: SearchQuery, options: {
  auth: SearchAuth;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<SearchResult> {
  const order = candidates(query);
  const errors: Array<{ provider: ProviderId; message: string }> = [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = withTimeout(options.signal, options.timeoutMs ?? SEARCH_TIMEOUT_MS);
  const hinted = withRecencyHint(query.query, query.recency);

  const explicit = Boolean(query.provider && query.provider !== "auto");
  for (const provider of order) {
    try {
      signal.throwIfAborted();
      const response = await runProvider(provider, hinted, query, options.auth, signal, fetchImpl);
      if (response === "skip") {
        if (explicit) errors.push({ provider, message: `${provider} credentials not configured` });
        continue;
      }
      if (!hasRenderableSearchContent(response)) {
        throw new ProviderError(provider, `${provider} returned no search content`, 204);
      }
      return { text: formatForLLM(response), response };
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
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
    if (!creds?.accountId) return "skip";
    const sessionModel = backendForSession(params.sessionProvider) === "codex" ? params.sessionModel : undefined;
    return searchCodex({ auth: creds as CodexAuth, query, sessionModel, signal, fetchImpl });
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
