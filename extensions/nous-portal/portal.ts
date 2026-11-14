// Nous Portal's device login, token refresh, public model catalog and account
// usage, kept apart from Pi's runtime so tests can drive them.
// Protocol reference: NousResearch/hermes-agent, hermes_cli/auth_nous.py.
// Pi owns persistence and refresh locking: Nous refresh tokens rotate on use.
import { setTimeout as delay } from "node:timers/promises";
import type { ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";

export const PROVIDER = "nous-portal";
export const PORTAL = "https://portal.nousresearch.com";
export const INFERENCE = "https://inference-api.nousresearch.com/v1";
// Nous's published public device client; this is not a client secret.
const CLIENT_ID = "hermes-cli";
const SCOPE = "inference:invoke";
const REFRESH_SKEW_MS = 120_000;
export const CATALOG_TTL_MS = 24 * 3_600_000;

// The Portal speaks OpenAI chat completions with OpenRouter-style reasoning
// parameters, and takes max_tokens, not max_completion_tokens.
const COMPAT = { thinkingFormat: "openrouter", supportsStore: false, maxTokensField: "max_tokens" } as const;

type OAuthResponse = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  device_code?: string;
  user_code?: string;
  verification_uri_complete?: string;
  interval?: number;
};

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function postOAuth(path: string, fields: Record<string, string>, signal?: AbortSignal, refresh?: string) {
  const response = await fetch(`${PORTAL}/api/oauth/${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      ...(refresh ? { "x-nous-refresh-token": refresh } : {}),
    },
    body: new URLSearchParams(fields).toString(),
    signal: requestSignal(signal),
    redirect: "error",
  });
  // Edge-firewall and service failures can return HTML, not OAuth JSON.
  const payload = await response.json().catch(() => ({}));
  const data = (payload && typeof payload === "object" ? payload : {}) as OAuthResponse;
  return { response, data };
}

function exchangeError(response: Response, data: OAuthResponse): Error {
  const code = typeof data.error === "string" && /^[a-z_]+$/.test(data.error) ? data.error : `HTTP ${response.status}`;
  const relogin = ["invalid_grant", "refresh_token_reused", "access_denied", "expired_token"].includes(code);
  // Never print token endpoint bodies, and keep the grant on gateway errors.
  return new Error(`Nous Portal: ${code}.${relogin ? ` Sign in again with /login ${PROVIDER}.` : ""}`);
}

/** Credentials from a token response, refused unless they hold a live inference JWT. */
function credentials(data: OAuthResponse, previous?: OAuthCredentials): OAuthCredentials {
  const access = data.access_token;
  const refresh = data.refresh_token || previous?.refresh;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) {
    throw new Error("Nous Portal returned incomplete OAuth credentials.");
  }
  let claims: Record<string, unknown>;
  try {
    if (access.split(".").length !== 3) throw new Error("not a JWT");
    claims = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new Error("not JWT claims");
  } catch {
    throw new Error("Nous Portal did not return an inference JWT.");
  }
  const scopes = [data.scope, claims.scope, claims.scp].flatMap(value =>
    typeof value === "string" ? value.split(/\s+/) : Array.isArray(value) ? value : [],
  );
  if (!scopes.includes(SCOPE)) throw new Error("Nous Portal token lacks inference:invoke scope.");
  const expiry = typeof claims.exp === "number" ? claims.exp * 1000
    : typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : NaN;
  if (!Number.isFinite(expiry) || expiry <= Date.now() + REFRESH_SKEW_MS) {
    throw new Error("Nous Portal returned an expired or short-lived inference JWT.");
  }
  return {
    ...previous,
    access,
    refresh,
    expires: expiry - REFRESH_SKEW_MS,
    ...(typeof claims.sub === "string" ? { accountId: claims.sub } : {}),
    ...(typeof claims.org_id === "string" ? { orgId: claims.org_id } : {}),
  };
}

/** The OAuth device flow: show the code, then poll until the user approves. */
export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const started = await postOAuth("device/code", { client_id: CLIENT_ID, scope: SCOPE }, callbacks.signal);
  if (!started.response.ok) throw exchangeError(started.response, started.data);
  const device = started.data;
  if (!device.device_code || !device.user_code || !device.verification_uri_complete ||
      !Number.isFinite(device.expires_in) || device.expires_in! <= 0) {
    throw new Error("Nous Portal returned an incomplete device authorization.");
  }
  const url = new URL(device.verification_uri_complete);
  if (url.origin !== PORTAL) throw new Error("Nous Portal returned an unexpected authorization origin.");
  let interval = Number.isFinite(device.interval) ? Math.max(1, device.interval!) : 5;
  callbacks.onDeviceCode({
    userCode: device.user_code, verificationUri: url.href, intervalSeconds: interval, expiresInSeconds: device.expires_in,
  });
  callbacks.onProgress?.("Waiting for Nous Portal authorization…");
  const deadline = Date.now() + device.expires_in! * 1000;
  const timeout = AbortSignal.timeout(device.expires_in! * 1000);
  const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, timeout]) : timeout;
  while (Date.now() < deadline) {
    await delay(Math.min(interval * 1000, deadline - Date.now()), undefined, { signal });
    const result = await postOAuth("token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: CLIENT_ID,
      device_code: device.device_code,
    }, signal);
    if (result.response.ok && result.data.access_token) return credentials(result.data);
    if (result.data.error === "authorization_pending") continue;
    if (result.data.error === "slow_down") { interval += 5; continue; }
    throw exchangeError(result.response, result.data);
  }
  throw new Error(`Nous Portal device authorization expired. Run /login ${PROVIDER} again.`);
}

/** Trades the grant for a new inference JWT. The grant rotates. */
export async function refreshToken(previous: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
  const result = await postOAuth("token", { grant_type: "refresh_token", client_id: CLIENT_ID }, signal, previous.refresh);
  if (!result.response.ok) throw exchangeError(result.response, result.data);
  return credentials(result.data, previous);
}

interface CatalogModel {
  id: string;
  name: string;
  context_length: number;
  architecture: { input_modalities: string[]; output_modalities: string[] };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
}

/** A chat model as Pi's provider registration takes it. */
export interface ChatModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat: typeof COMPAT;
}

/** The chat models in the public catalog that can call tools. */
export async function catalog(signal?: AbortSignal): Promise<ChatModel[]> {
  // The catalog is public. Never send OAuth credentials to discover models.
  const response = await fetch(`${INFERENCE}/models`, { signal: requestSignal(signal), redirect: "error" });
  if (!response.ok) throw new Error(`Nous model discovery failed (HTTP ${response.status}).`);
  const { data } = await response.json() as { data: CatalogModel[] };
  return data
    .filter(model => model.architecture?.output_modalities?.includes("text") && model.context_length > 0)
    // Pi's agent needs tools; a model whose parameters leave them out cannot run it.
    .filter(model => !model.supported_parameters || model.supported_parameters.includes("tools"))
    .map(model => {
      const parameters = model.supported_parameters ?? [];
      const price = (value?: string) => Number(value ?? 0) * 1_000_000;
      return {
        id: model.id,
        name: model.name,
        reasoning: parameters.includes("reasoning") || parameters.includes("reasoning_effort"),
        input: model.architecture.input_modalities.includes("image") ? ["text", "image"] : ["text"],
        contextWindow: model.context_length,
        maxTokens: model.top_provider?.max_completion_tokens ?? Math.min(16_384, model.context_length),
        cost: {
          input: price(model.pricing?.prompt), output: price(model.pricing?.completion),
          cacheRead: price(model.pricing?.input_cache_read), cacheWrite: price(model.pricing?.input_cache_write),
        },
        compat: COMPAT,
      };
    });
}

function restore(entry?: Readonly<ModelsStoreEntry>): ChatModel[] | undefined {
  const models = (entry?.models ?? []).filter(model => model.provider === PROVIDER) as unknown as ChatModel[];
  if (models.length === 0) return undefined;
  return models.map(({ id, name, reasoning, input, contextWindow, maxTokens, cost }) =>
    ({ id, name, reasoning, input, contextWindow, maxTokens, cost, compat: COMPAT }));
}

/**
 * Pi's model refresh: the stored catalog offline or within a day, else a new
 * one, which is stored. Returning nothing leaves the current list in place.
 */
export async function refreshModels(context: RefreshModelsContext): Promise<ChatModel[] | undefined> {
  const stored = restore(context.stored);
  const checkedAt = context.stored?.checkedAt;
  const fresh = stored && checkedAt !== undefined && Date.now() - checkedAt < CATALOG_TTL_MS;
  if (!context.allowNetwork || context.signal.aborted || (fresh && !context.force)) return stored;
  let models: ChatModel[];
  try {
    models = await catalog(context.signal);
  } catch (error) {
    // Keep a stored catalog through an outage; report only when there is none.
    if (stored) return stored;
    throw error;
  }
  if (context.signal.aborted) return stored;
  const entry = models.map(model => ({ ...model, type: "chat", provider: PROVIDER, api: "openai-completions", baseUrl: INFERENCE }));
  await context.publish({ persist: { models: entry as unknown as ModelsStoreEntry["models"], checkedAt: Date.now() } });
  return models;
}

export interface Gauge {
  id: string;
  label: string;
  /** Percent of the allowance used. */
  used: number;
  topTier: boolean;
  resetsAt?: number;
  status: "ok" | "warning" | "exhausted";
}

export interface Usage {
  gauges: Gauge[];
  notes: string[];
}

/** The account's allowance gauges and credit state. */
export async function usage(accessToken: string, signal?: AbortSignal): Promise<Usage> {
  const response = await fetch(`${PORTAL}/api/oauth/account`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: requestSignal(signal),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Nous Portal account request failed (HTTP ${response.status}).`);
  const account = await response.json();
  if (!account || typeof account !== "object" || account.error) {
    throw new Error("Nous Portal returned an invalid account report.");
  }
  const window = account.usage_window;
  const gauges: Gauge[] = [];
  const seen = new Set<string>();
  for (const gauge of Array.isArray(window?.gauges) ? window.gauges : []) {
    if (!gauge || typeof gauge.id !== "string" || !gauge.id || seen.has(gauge.id) ||
        !["all", "top_tier"].includes(gauge.scope) || !Number.isInteger(gauge.used_bp) ||
        gauge.used_bp < 0 || gauge.used_bp > 10_000) continue;
    seen.add(gauge.id);
    const reset = gauge.resets_at_ms;
    gauges.push({
      id: gauge.id,
      label: typeof gauge.label === "string" && gauge.label.trim() ? gauge.label.trim() : gauge.id,
      used: gauge.used_bp / 100,
      topTier: gauge.scope === "top_tier",
      ...(Number.isSafeInteger(reset) && reset > 0 && reset <= Date.now() + 366 * 86_400_000 ? { resetsAt: reset } : {}),
      status: gauge.used_bp === 10_000 ? "exhausted" : gauge.used_bp >= 9000 ? "warning" : "ok",
    });
  }
  // Balances and allowances are separate, so no credit limit is made up here.
  // Nous enforces model exemptions, pauses and credit overages itself.
  const notes: string[] = [];
  if (typeof window?.keep_going_on_credits === "boolean") {
    notes.push(`Continue on credits: ${window.keep_going_on_credits ? "on" : "off"}.`);
  }
  if (typeof window?.paused_reason === "string" && window.paused_reason) {
    notes.push(`Subscription paused: ${window.paused_reason}.`);
  }
  const balance = account.paid_service_access?.total_usable_credits;
  if (typeof balance === "number" && Number.isFinite(balance)) notes.push(`Credits remaining: ${balance}.`);
  return { gauges, notes };
}

/** The report /nous-usage shows. */
export function formatUsage({ gauges, notes }: Usage): string {
  const lines = gauges.map(gauge => {
    const reset = gauge.resetsAt ? `, resets ${new Date(gauge.resetsAt).toLocaleString()}` : "";
    const scope = gauge.topTier ? " (top-tier models)" : "";
    const flag = gauge.status === "ok" ? "" : ` — ${gauge.status}`;
    return `${gauge.label}${scope}: ${gauge.used}% used${reset}${flag}`;
  });
  if (lines.length === 0) lines.push("No allowance gauges reported.");
  return [...lines, ...notes, "Gauges are informational; the Portal decides access and credit use."].join("\n");
}
