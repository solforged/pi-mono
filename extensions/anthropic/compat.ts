// Adapted from can1357/oh-my-pi's Anthropic fingerprint implementation.
// See NOTICE for the MIT license and pinned upstream changes.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { xxhash64 } from "./xxhash.ts";

export const DEFAULT_VERSION = "2.1.280";
export const SDK_VERSION = "0.112.1";
export const VERSION_ENV = "PI_AI_CLAUDE_CODE_VERSION";
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const BILLING_PREFIX = "x-anthropic-billing-header:";
const CCH_SEED = 0x4d659218e32a3268n;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "fallback-credit-2026-06-01",
];
type Payload = Record<string, any>;

export function isOfficialEndpoint(url: string): boolean {
  try { return new URL(url).origin === "https://api.anthropic.com"; }
  catch { return false; }
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export function createVersionState() {
  let adopted = DEFAULT_VERSION;
  return {
    version(pin?: string): string {
      if (pin && !SEMVER.test(pin)) throw new Error(`${VERSION_ENV} must be a version such as ${DEFAULT_VERSION}`);
      return pin || adopted;
    },
    // Compare against the version actually sent, not shared state. Concurrent
    // requests rejected for the same minimum may each retry once.
    adopt(message: string, sent: string, pin?: string): boolean {
      if (pin || !message.includes("claude_code_version_too_old")) return false;
      const required = /version (\d+\.\d+\.\d+) or newer is required/i.exec(message)?.[1];
      if (!required || compareVersions(required, sent) <= 0) return false;
      if (compareVersions(required, adopted) > 0) adopted = required;
      return true;
    },
  };
}
export type VersionState = ReturnType<typeof createVersionState>;

export function billingHeader(text: string, version: string): string {
  const chars = [4, 7, 20].map(i => text[i] ?? "0").join("");
  const suffix = createHash("sha256").update(`59cf53e54c78${chars}${version}`).digest("hex").slice(0, 3);
  return `${BILLING_PREFIX} cc_version=${version}.${suffix}; cc_entrypoint=cli; cch=00000;`;
}

function firstUserText(payload: Payload): string {
  // Tool-result-only user turns are not the original user prompt.
  for (const message of payload.messages ?? []) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) continue;
    const text = message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
    if (text) return text;
  }
  return "";
}

function validUserId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^user_[a-f0-9]{64}_account_[a-f0-9-]{36}_session_[a-f0-9-]{36}$/i.test(value)) return true;
  try {
    const id = JSON.parse(value);
    return typeof id?.session_id === "string" && id.session_id.length > 0;
  } catch { return false; }
}

export interface FingerprintOptions {
  sessionId: string;
  deviceId: string;
  accountId?: string;
}

// Work on the final serialized SDK payload, after Pi's onPayload hook. Only
// system[0]'s placeholder is patched; matching text in prompts stays untouched.
export function fingerprintBody(body: string, version: string, options: FingerprintOptions): string {
  const payload: Payload = JSON.parse(body);
  if (!Array.isArray(payload.messages)) throw new Error("Anthropic compatibility expected a messages payload");
  const system = typeof payload.system === "string"
    ? [{ type: "text", text: payload.system }]
    : Array.isArray(payload.system) ? payload.system : [];
  // A caller may already have injected the CC block. Replace just that leading
  // block, preserving the rest of the system and its cache controls.
  if (system[0]?.type === "text" && system[0].text?.startsWith(BILLING_PREFIX)) system.shift();
  if (!system.some((block: any) => block.type === "text" && block.text === IDENTITY)) {
    system.unshift({ type: "text", text: IDENTITY });
  }
  payload.system = [{ type: "text", text: billingHeader(firstUserText(payload), version) }, ...system];
  if (!validUserId(payload.metadata?.user_id)) {
    payload.metadata = {
      ...payload.metadata,
      user_id: JSON.stringify({
        device_id: options.deviceId,
        session_id: options.sessionId,
        ...(options.accountId ? { account_uuid: options.accountId } : {}),
      }),
    };
  }
  // Serialize system first so a tool argument containing a lookalike system
  // object cannot steal the attestation anchor.
  const serialized = JSON.stringify({ system: payload.system, ...payload });
  const marker = `"system":[{"type":"text","text":"${BILLING_PREFIX}`;
  const markerIndex = serialized.indexOf(marker);
  const placeholder = serialized.indexOf("cch=00000", markerIndex + marker.length);
  if (markerIndex < 0 || placeholder < 0 || placeholder - markerIndex > 250) {
    throw new Error("Anthropic compatibility could not anchor the billing fingerprint");
  }
  const cch = (xxhash64(Buffer.from(serialized), CCH_SEED) & 0xfffffn).toString(16).padStart(5, "0");
  return serialized.slice(0, placeholder + 4) + cch + serialized.slice(placeholder + 9);
}

function metadataSessionId(value: unknown): string | undefined {
  if (!validUserId(value)) return;
  const userId = value as string;
  if (userId.startsWith("user_")) return userId.slice(userId.lastIndexOf("_session_") + 9);
  return JSON.parse(userId).session_id;
}

function fingerprintHeaders(headers: Headers, version: string, payload: Payload, sessionId: string): Headers {
  const result = new Headers(headers);
  const arch = ({ arm64: "arm64", x64: "x64", ia32: "x86" } as Record<string, string>)[process.arch] ?? `other::${process.arch}`;
  const os = ({ darwin: "MacOS", linux: "Linux", win32: "Windows", freebsd: "FreeBSD" } as Record<string, string>)[process.platform] ?? `Other:${process.platform}`;
  const values = {
    "user-agent": `claude-cli/${version} (external, cli)`,
    "x-app": "cli",
    "x-claude-code-session-id": metadataSessionId(payload.metadata?.user_id) ?? sessionId,
    "x-stainless-arch": arch,
    "x-stainless-lang": "js",
    "x-stainless-os": os,
    "x-stainless-package-version": SDK_VERSION,
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v26.3.0",
    "x-stainless-timeout": "600",
  };
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  // Keep Pi's feature-specific betas; do not enable OMP-only wire features.
  // Subscription tokens have no long-context credit balance for this beta.
  const betas = (result.get("anthropic-beta") ?? "").split(",").map(s => s.trim()).filter(s => s && s !== "context-1m-2025-08-07");
  result.set("anthropic-beta", [...new Set([...betas, ...OAUTH_BETAS, ...(payload.thinking && payload.thinking.type !== "disabled" ? ["effort-2025-11-24"] : [])])].join(","));
  result.delete("content-length");
  result.delete("x-stainless-helper-method");
  return result;
}

// Read only as much as needed. Cancellation is fire-and-forget because a
// cloned response is a tee: cancelling one branch can wait for its unread peer.
async function readText(stream: ReadableStream<Uint8Array> | null, signal: AbortSignal, limit = Infinity): Promise<string | undefined> {
  signal.throwIfAborted();
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = (reason?: unknown) => { void reader.cancel(reason).catch(() => {}); };
  const onAbort = () => { cancel(signal.reason); rejectAbort(signal.reason); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    while (true) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) { cancel(); return; }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export function compatibilityFetch(
  baseFetch: typeof fetch,
  state: VersionState,
  fingerprint: FingerprintOptions,
  pin?: string,
): typeof fetch {
  return async (input, init) => {
    const original = input instanceof Request ? input : undefined;
    const url = new URL(original?.url ?? String(input));
    const method = (init?.method ?? original?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? original?.headers);
    // Inspect only metadata until eligibility is known. Even an unused clone
    // would tee a pass-through streaming upload into an unconsumed buffer.
    if (!isOfficialEndpoint(url.href) || url.pathname !== "/v1/messages" || method !== "POST" ||
        !/^Bearer sk-ant-oat/i.test(headers.get("authorization") ?? "")) {
      return baseFetch(input, init);
    }
    // Like fetch itself, this consumes an eligible Request's body. A supplied
    // init.body replaces it, including when the input Request was already used.
    const request = new Request(input, init);
    const body = (await readText(request.body, request.signal))!;
    const payload = JSON.parse(body);
    const send = (version: string) => {
      request.signal.throwIfAborted();
      const patchedInit = {
        ...init,
        headers: fingerprintHeaders(request.headers, version, payload, fingerprint.sessionId),
        body: fingerprintBody(body, version, fingerprint),
        signal: request.signal,
      };
      // Keep transport-specific init fields (for example dispatcher or TLS
      // options) that constructing a standard Request alone would discard.
      return baseFetch(new Request(request, patchedInit), patchedInit);
    };
    const sent = state.version(pin);
    const response = await send(sent);
    if (response.status < 400 || response.status >= 500 || pin) return response;
    let message: string | undefined;
    try {
      const inspectionSignal = AbortSignal.any([request.signal, AbortSignal.timeout(1000)]);
      message = await readText(response.clone().body, inspectionSignal, 32_768);
    } catch { request.signal.throwIfAborted(); return response; }
    if (!message || !state.adopt(message, sent, pin)) return response;
    // This is a rejected HTTP request, not a partially consumed model stream.
    // Retry once only; Pi still owns rate-limit retries and stream events.
    await response.body?.cancel();
    return send(state.version(pin));
  };
}

export function wrapAnthropicProvider(provider: Provider, state = createVersionState()): Provider {
  const deviceId = randomBytes(32).toString("hex");
  const defaultSessionId = randomUUID();
  function optionsFor<T extends StreamOptions>(model: Model<any>, options?: T): T | undefined {
    if (model.provider !== "anthropic" || model.api !== "anthropic-messages" || !isOfficialEndpoint(model.baseUrl) ||
        !options?.apiKey?.startsWith("sk-ant-oat")) return options;
    const metadata = options.metadata;
    const accountId = [metadata?.account_uuid, metadata?.accountId, metadata?.account_id].find(v => typeof v === "string" && v.length > 0) as string | undefined;
    return {
      ...options,
      fetch: compatibilityFetch(options.fetch ?? globalThis.fetch, state, {
        deviceId,
        sessionId: options.sessionId ?? defaultSessionId,
        accountId,
      }, options.env?.[VERSION_ENV] ?? process.env[VERSION_ENV]),
    };
  }
  return {
    ...provider,
    stream: (model, context, options) => provider.stream(model, context, optionsFor(model, options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, optionsFor(model, options)),
  };
}
