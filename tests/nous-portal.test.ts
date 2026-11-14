import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  CATALOG_TTL_MS, catalog, formatUsage, login, PROVIDER, refreshModels, refreshToken, usage,
} from "../extensions/nous-portal/portal.ts";

const now = 1_800_000_000_000;
const realFetch = globalThis.fetch;
const realNow = Date.now;
beforeEach(() => { Date.now = () => now; });
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

function jwt(claims: Record<string, unknown> = {}): string {
  return `e30.${Buffer.from(JSON.stringify({
    sub: "test-account", scope: "inference:invoke", exp: now / 1000 + 3600, ...claims,
  })).toString("base64url")}.test-signature`;
}
const device = {
  device_code: "test-device-code", user_code: "ABCD-EFGH",
  verification_uri_complete: "https://portal.nousresearch.com/device?user_code=ABCD-EFGH",
  expires_in: 600, interval: 1,
};
const callbacks = (overrides: Record<string, unknown> = {}) => ({
  onAuth: () => {}, onDeviceCode: () => {}, onPrompt: async () => "", onSelect: async () => undefined, ...overrides,
}) as Parameters<typeof login>[0];
const catalogResponse = {
  data: [
    {
      id: "vendor/reasoner", name: "Reasoner", context_length: 200_000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      top_provider: { max_completion_tokens: 32_768 },
      supported_parameters: ["tools", "reasoning"],
      pricing: { prompt: "0.000002", completion: "0.000008" },
    },
    {
      id: "vendor/chat-only", name: "No tools", context_length: 32_000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["temperature"],
    },
    {
      id: "vendor/embed", name: "Embeddings", context_length: 8192,
      architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
    },
  ],
};

test("device authorization shows the code, waits through pending and slow_down, then returns credentials", async () => {
  let polls = 0;
  let shown: { userCode: string; verificationUri: string } | undefined;
  globalThis.fetch = (async (url, init) => {
    const form = new URLSearchParams(init!.body as string);
    if (String(url).endsWith("/device/code")) {
      assert.equal(form.get("scope"), "inference:invoke");
      return Response.json(device);
    }
    assert.ok(shown, "polled before the code was shown");
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    if (++polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
    if (polls === 2) return Response.json({ error: "slow_down" }, { status: 400 });
    return Response.json({ access_token: jwt(), refresh_token: "new-grant" });
  }) as typeof fetch;
  const result = await login(callbacks({ onDeviceCode: (info: typeof shown) => { shown = info; } }));
  assert.deepEqual(shown && { userCode: shown.userCode, verificationUri: shown.verificationUri },
    { userCode: "ABCD-EFGH", verificationUri: device.verification_uri_complete });
  assert.equal(result.expires, now + 3_600_000 - 120_000);
  assert.equal(result.refresh, "new-grant");
});

test("refresh rotates the grant and uses the inference JWT's expiry", async () => {
  globalThis.fetch = (async (_url, init) => {
    const form = new URLSearchParams(init!.body as string);
    assert.equal(new Headers(init!.headers).get("x-nous-refresh-token"), "old-grant");
    assert.equal(form.has("refresh_token"), false);
    assert.equal(form.get("grant_type"), "refresh_token");
    return Response.json({ access_token: jwt({ exp: now / 1000 + 900 }), refresh_token: "rotated-grant", expires_in: 86400 });
  }) as typeof fetch;
  const result = await refreshToken({ access: jwt(), refresh: "old-grant", expires: now - 1, orgId: "existing-org" });
  assert.equal(result.refresh, "rotated-grant");
  assert.equal(result.expires, now + 900_000 - 120_000);
  assert.equal(result.orgId, "existing-org");
});

for (const [name, token] of [
  ["an opaque OAuth token", () => "not-an-inference-jwt"],
  ["a missing inference scope", () => jwt({ scope: "profile" })],
  ["an expiry at the refresh boundary", () => jwt({ exp: now / 1000 + 120 })],
] as const) {
  test(`refresh refuses ${name} before it can be used for inference`, async () => {
    globalThis.fetch = (async () => Response.json({ access_token: token(), refresh_token: "rotated-grant" })) as typeof fetch;
    await assert.rejects(refreshToken({ access: jwt(), refresh: "old-grant", expires: now - 1 }), /Nous Portal/);
  });
}

test("cancelling authorization stops before polling", async () => {
  const controller = new AbortController();
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json(device); }) as typeof fetch;
  await assert.rejects(login(callbacks({ signal: controller.signal, onDeviceCode: () => controller.abort() })));
  assert.equal(requests, 1);
});

test("a gateway challenge is not reported as a revoked grant", async () => {
  globalThis.fetch = (async () => new Response("edge security checkpoint", {
    status: 403, headers: { "x-vercel-mitigated": "challenge" },
  })) as typeof fetch;
  await assert.rejects(refreshToken({ access: jwt(), refresh: "old-grant", expires: now - 1 }), (error: Error) =>
    error.message.includes("HTTP 403") && !error.message.includes("/login"));
});

test("the catalog keeps tool-capable chat models with their capabilities, without credentials", async () => {
  globalThis.fetch = (async (_url, init) => {
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json(catalogResponse);
  }) as typeof fetch;
  const models = await catalog();
  assert.deepEqual(models.map(model => model.id), ["vendor/reasoner"]);
  assert.partialDeepStrictEqual(models[0], {
    reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_768,
    cost: { input: 2, output: 8 }, compat: { thinkingFormat: "openrouter", maxTokensField: "max_tokens" },
  });
});

function refreshContext(overrides: Record<string, unknown> = {}) {
  const published: unknown[] = [];
  return {
    published,
    context: {
      allowNetwork: true, signal: new AbortController().signal,
      publish: async (publication: unknown) => { published.push(publication); return true; },
      ...overrides,
    } as unknown as Parameters<typeof refreshModels>[0],
  };
}
const storedModel = {
  id: "vendor/stored", name: "Stored", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, type: "chat", provider: PROVIDER,
  api: "openai-completions", baseUrl: "https://inference-api.nousresearch.com/v1",
};

test("model refresh stores a new catalog for offline starts", async () => {
  globalThis.fetch = (async () => Response.json(catalogResponse)) as typeof fetch;
  const { context, published } = refreshContext();
  const models = await refreshModels(context);
  assert.deepEqual(models?.map(model => model.id), ["vendor/reasoner"]);
  const entry = (published[0] as { persist: { models: Array<Record<string, unknown>>; checkedAt: number } }).persist;
  assert.equal(entry.checkedAt, now);
  assert.partialDeepStrictEqual(entry.models[0], { id: "vendor/reasoner", provider: PROVIDER, type: "chat" });
});

test("model refresh uses the stored catalog offline, within a day, and through an outage", async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return new Response("down", { status: 503 }); }) as typeof fetch;
  const fresh = { models: [storedModel], checkedAt: now - 1000 };
  const stale = { models: [storedModel], checkedAt: now - CATALOG_TTL_MS - 1 };
  for (const overrides of [{ allowNetwork: false, stored: stale }, { stored: fresh }, { stored: stale }]) {
    const { context, published } = refreshContext(overrides);
    assert.deepEqual((await refreshModels(context))?.map(model => model.id), ["vendor/stored"]);
    assert.deepEqual(published, []);
  }
  assert.equal(requests, 1);
  // With nothing stored, offline leaves the list alone and an outage is an error.
  assert.equal(await refreshModels(refreshContext({ allowNetwork: false }).context), undefined);
  await assert.rejects(refreshModels(refreshContext().context), /HTTP 503/);
});

test("usage reports subscription windows and model tiers, never a credit limit", async () => {
  globalThis.fetch = (async (_url, init) => {
    assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer /);
    return Response.json({
      usage_window: { keep_going_on_credits: false, gauges: [
        { id: "day", scope: "all", label: "Daily", used_bp: 3750, resets_at_ms: now + 60_000 },
        { id: "top_tier", scope: "top_tier", label: "Large models", used_bp: 10_000 },
        { id: "unrecognized", scope: "new-scope", used_bp: 5000 },
        { id: "bad-percentage", scope: "all", used_bp: 10_001 },
      ] },
      paid_service_access: { total_usable_credits: 0 },
    });
  }) as typeof fetch;
  const report = await usage(jwt());
  assert.deepEqual(report.gauges.map(gauge => gauge.id), ["day", "top_tier"]);
  assert.partialDeepStrictEqual(report.gauges[0], { used: 37.5, resetsAt: now + 60_000, status: "ok" });
  assert.partialDeepStrictEqual(report.gauges[1], { topTier: true, status: "exhausted" });
  const text = formatUsage(report);
  assert.match(text, /Daily: 37\.5% used/);
  assert.match(text, /Large models \(top-tier models\): 100% used.*exhausted/);
  assert.match(text, /Continue on credits: off\.\nCredits remaining: 0\./);
});
