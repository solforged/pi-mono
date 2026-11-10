import assert from "node:assert/strict";
import test from "node:test";
import { codexModels, consumeCodexEvents, extractTextSources, resolveCodexUrl, shouldRetryCodexModel } from "../extensions/web-search/codex.ts";
import { buildExaBody, parseExaResponse, recencyStartDate, synthesizeAnswer } from "../extensions/web-search/exa.ts";
import { errorDetail, formatFailures, formatForLLM, hasRenderableSearchContent, ProviderError, searchOrder, withRecencyHint } from "../extensions/web-search/format.ts";
import { executeSearch, orderByHealth, registryAuth, type SearchAuth } from "../extensions/web-search/search.ts";
import { sseText } from "../extensions/web-search/sse.ts";
import { buildXaiBody, parseXaiResponse, xaiModels } from "../extensions/web-search/xai.ts";

function jwt(): string {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { encrypted_auth_metadata: "opaque" } })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(events: unknown[], status = 200): Response {
  return new Response(sseText(events), { status, headers: { "content-type": "text/event-stream" } });
}

test("search defaults use current models and preserve explicit pins", (t) => {
  const keys = ["PI_CODEX_WEB_SEARCH_MODEL", "PI_XAI_WEB_SEARCH_MODEL"];
  for (const key of keys) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    delete process.env[key];
  }
  assert.deepEqual(codexModels(), ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"]);
  assert.deepEqual(xaiModels(), ["grok-4.7"]);
  assert.equal(codexModels("gpt-6.1-sol")[0], "gpt-6.1-sol");
  assert.equal(xaiModels("session-model")[0], "session-model");
  process.env.PI_CODEX_WEB_SEARCH_MODEL = "pinned-openai";
  process.env.PI_XAI_WEB_SEARCH_MODEL = "pinned-xai";
  assert.deepEqual(codexModels("session-model"), ["pinned-openai"]);
  assert.deepEqual(xaiModels("session-model"), ["pinned-xai"]);
});

test("formatForLLM lists answer, sources, and citations", () => {
  const text = formatForLLM({
    provider: "codex",
    answer: "Grok has hosted web search.",
    sources: [{ title: "xAI docs", url: "https://docs.x.ai/search", snippet: "Live Search is gone; use web_search." }],
    citations: [{ title: "xAI docs", url: "https://docs.x.ai/search", citedText: "tools: [{ type: \"web_search\" }]" }],
  });
  assert.match(text, /Grok has hosted web search/);
  assert.match(text, /## Sources/);
  assert.match(text, /1 source\n/);
  assert.match(text, /https:\/\/docs.x.ai\/search/);
  assert.match(text, /## Citations/);
  assert.equal(hasRenderableSearchContent({ provider: "exa", sources: [] }), false);
  assert.equal(formatFailures([]), "Error: No web search provider configured.");
  assert.match(formatFailures([{ provider: "codex", message: "boom" }, { provider: "xai", message: "nope" }]), /All web search providers failed/);
  assert.equal(withRecencyHint("pi extensions", "week"), "pi extensions (focus on the past week)");
});

test("OpenAI Responses URL, markdown fallback, and event parsing", () => {
  assert.equal(resolveCodexUrl(), "https://api.openai.com/v1/responses");
  assert.equal(resolveCodexUrl("https://gateway.example/v1/"), "https://gateway.example/v1/responses");
  assert.equal(resolveCodexUrl("https://gateway.example/v1/responses"), "https://gateway.example/v1/responses");
  const sources = extractTextSources("See [Docs](https://example.com/a) and https://example.com/b).");
  assert.equal(sources[0]?.url, "https://example.com/a");
  assert.equal(sources[1]?.url, "https://example.com/b");
  const parsed = consumeCodexEvents([
    { type: "response.web_search_call.in_progress" },
    {
      type: "response.output_item.done",
      item: {
        type: "web_search_call",
        action: { sources: [{ title: "Result", url: "https://example.com?utm_source=openai" }] },
      },
    },
    {
      type: "response.output_item.done",
      item: { type: "message", content: [{ type: "output_text", text: "Found it.", annotations: [{ type: "url_citation", url: "https://example.com", title: "Example", start_index: 0, end_index: 5 }] }] },
    },
  ], "gpt-5.6-luna");
  assert.equal(parsed.provider, "codex");
  assert.equal(parsed.answer, "Found it.");
  assert.equal(parsed.sources[0]?.url, "https://example.com/");
  assert.throws(() => consumeCodexEvents([{ type: "response.output_text.delta", delta: "no search" }], "gpt-5.6-luna"), /without running web search/);
  assert.equal(shouldRetryCodexModel(new ProviderError("codex", "model is not supported", 400)), true);
  assert.equal(shouldRetryCodexModel(new ProviderError("xai", "nope", 400)), false);
});

test("Codex search resolves OAuth without an account-id claim through openai", async () => {
  const token = jwt();
  const baseUrl = "https://api.openai.com/v1";
  const headers = { "X-Test": "value" };
  const calls: string[] = [];
  const auth = registryAuth({
    async getProviderAuth(id) {
      calls.push(id);
      return id === "openai" ? { auth: { apiKey: token, baseUrl, headers } } : undefined;
    },
  });
  assert.deepEqual(await auth.codex!(), { token, baseUrl, headers });
  assert.deepEqual(calls, ["openai"]);

  const apiKeyAuth = registryAuth({
    async getProviderAuth() { return { auth: { apiKey: "sk-proj-test" } }; },
  });
  assert.equal((await apiKeyAuth.codex!())?.token, "sk-proj-test");

  const missingAuth = registryAuth({ async getProviderAuth() { return undefined; } });
  assert.equal(await missingAuth.codex!(), undefined);
});

test("ChatGPT search uses OpenAI Responses without legacy Codex headers", async () => {
  const token = jwt();
  const result = await executeSearch({ query: "pi docs", sessionProvider: "openai", sessionModel: "gpt-6.1-sol" }, {
    auth: registryAuth({ async getProviderAuth() { return { auth: { apiKey: token } }; } }),
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://api.openai.com/v1/responses");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${token}`);
      assert.equal(headers.has("chatgpt-account-id"), false);
      assert.equal(headers.has("OpenAI-Beta"), false);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "gpt-6.1-sol");
      assert.deepEqual(body.tools, [{ type: "web_search", search_context_size: "high" }]);
      assert.equal(body.max_output_tokens, undefined);
      return sseResponse([
        { type: "response.web_search_call.completed" },
        { type: "response.output_text.delta", delta: "See https://pi.dev" },
      ]);
    },
  });
  assert.equal(result.response?.provider, "codex");
  assert.match(result.text, /https:\/\/pi.dev/);
});

test("xAI and Exa parsers keep sources and synthesize answers", () => {
  const xai = parseXaiResponse({
    id: "resp",
    model: "grok-4.6",
    output_text: "Use hosted web_search.",
    output: [
      { type: "web_search_call", action: { sources: [{ title: "Docs", url: "https://docs.x.ai" }] } },
      { type: "message", content: [{ type: "output_text", text: "Use hosted web_search.", annotations: [{ type: "url_citation", url: "https://docs.x.ai", title: "Docs" }] }] },
    ],
  });
  assert.equal(xai.provider, "xai");
  assert.equal(xai.sources.length, 1);
  assert.equal(xai.sources[0]?.url, "https://docs.x.ai/");
  assert.throws(() => parseXaiResponse({ output_text: "I guessed." }), /without running web search/);
  assert.deepEqual(buildXaiBody("query", "grok-4.6").tools, [{ type: "web_search" }]);
  assert.equal(recencyStartDate("week", new Date("2026-09-09T00:00:00Z")), "2026-09-02");
  const body = buildExaBody("pi web search", { limit: 5, recency: "day", now: new Date("2026-09-09T00:00:00Z") });
  assert.equal(body.numResults, 5);
  assert.equal(body.startPublishedDate, "2026-09-08");
  assert.equal(synthesizeAnswer([{ title: "One", url: "https://a", summary: "First" }, { title: "Two", url: "https://b" }]), "**One**: First");
  const exa = parseExaResponse({ results: [{ title: "A", url: "https://a.example", summary: "Hello" }] });
  assert.equal(exa.provider, "exa");
  assert.match(exa.answer ?? "", /Hello/);
});

test("search chain skips missing backends, then falls through failures", async () => {
  const auth: SearchAuth = {
    codex: async () => undefined,
    xai: async () => ({ token: "xai-token" }),
    exa: async () => "exa-key",
  };
  const calls: string[] = [];
  const result = await executeSearch({ query: "current grok search api" }, {
    auth,
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("api.x.ai")) {
        return jsonResponse({
          output_text: "Hosted web_search replaced Live Search.",
          output: [{ type: "web_search_call", action: { sources: [{ title: "xAI", url: "https://docs.x.ai" }] } }],
        });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal(result.response?.provider, "xai");
  assert.match(result.text, /Hosted web_search/);
  assert.equal(calls.length, 1);

  const failed = await executeSearch({ query: "none" }, {
    auth: { codex: async () => undefined, xai: async () => undefined, exa: async () => undefined },
    fetchImpl: async () => { throw new Error("network"); },
  });
  assert.equal(failed.error, "Error: No web search provider configured.");

  let n = 0;
  const fallback = await executeSearch({ query: "exa after codex" }, {
    auth: {
      codex: async () => ({ token: jwt() }),
      xai: async () => undefined,
      exa: async () => "exa-key",
    },
    fetchImpl: async (input) => {
      n += 1;
      if (String(input).includes("api.openai.com")) return sseResponse([{ type: "error", code: "rate_limit", message: "slow down" }]);
      return jsonResponse({ results: [{ title: "Exa hit", url: "https://exa.ai", summary: "Fallback worked." }] });
    },
  });
  assert.equal(fallback.response?.provider, "exa");
  assert.match(fallback.text, /Fallback worked/);
  assert.equal(n, 2);
});

test("Grok and Codex sessions prefer their own backend first", async () => {
  assert.deepEqual(searchOrder("xai"), ["xai", "codex", "exa"]);
  assert.deepEqual(searchOrder("grok"), ["xai", "codex", "exa"]);
  assert.deepEqual(searchOrder("openai"), ["codex", "xai", "exa"]);
  assert.deepEqual(searchOrder("openai-codex"), ["codex", "xai", "exa"]);
  assert.deepEqual(searchOrder("nous-portal"), ["codex", "xai", "exa"]);

  const calls: string[] = [];
  const auth: SearchAuth = {
    codex: async () => ({ token: jwt() }),
    xai: async () => ({ token: "xai-token" }),
    exa: async () => undefined,
  };
  const result = await executeSearch({
    query: "prefer grok",
    sessionProvider: "xai",
    sessionModel: "grok-4.6",
  }, {
    auth,
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("api.x.ai")) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "grok-4.6");
        return jsonResponse({
          output_text: "Grok searched.",
          output: [{ type: "web_search_call", action: { sources: [{ title: "xAI", url: "https://docs.x.ai" }] } }],
        });
      }
      throw new Error(`codex should not run first: ${url}`);
    },
  });
  assert.equal(result.response?.provider, "xai");
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /api.x.ai/);
});

test("a stalled backend times out on its own and the next one answers", async () => {
  const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });
  const auth: SearchAuth = { codex: async () => ({ token: jwt() }), xai: async () => undefined, exa: async () => "exa-key" };
  const fetchImpl = async (input: any, init?: RequestInit) => String(input).includes("api.openai.com")
    ? hang(init)
    : jsonResponse({ results: [{ title: "Exa hit", url: "https://exa.ai", summary: "Fallback worked." }] });
  const result = await executeSearch({ query: "slow codex" }, { auth, timeoutMs: 40, fetchImpl, cooldowns: new Map() });
  assert.equal(result.response?.provider, "exa");

  // Credential lookups take no signal; the limit still applies to them.
  const stuck = await executeSearch({ query: "stuck auth" }, {
    auth: { ...auth, codex: () => new Promise(() => {}) }, timeoutMs: 40, fetchImpl, cooldowns: new Map(),
  });
  assert.equal(stuck.response?.provider, "exa");

  const alone = await executeSearch({ query: "slow codex", provider: "codex" }, { auth, timeoutMs: 40, fetchImpl, cooldowns: new Map() });
  assert.equal(alone.error, "Error: codex timed out after 0 s");

  // The caller's cancellation ends the whole search instead of trying the next backend.
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(), 10);
  await assert.rejects(executeSearch({ query: "cancelled" }, { auth, signal: cancel.signal, fetchImpl, cooldowns: new Map() }), { name: "AbortError" });
});

test("API error bodies are reduced to their message and bounded", async () => {
  assert.equal(errorDetail(JSON.stringify({ error: { message: "The requested model is not supported." } })), "The requested model is not supported.");
  assert.equal(errorDetail(JSON.stringify({ detail: "No access" })), "No access");
  assert.equal(errorDetail("<html>\n  <body>Bad   gateway</body>\n</html>"), "<html> <body>Bad gateway</body> </html>");
  const result = await executeSearch({ query: "big error", provider: "exa" }, {
    auth: { exa: async () => "exa-key" },
    fetchImpl: async () => new Response("x".repeat(200_000), { status: 502 }),
  });
  assert(result.error && result.error.length < 600, `error was ${result.error?.length} characters`);
  assert.match(result.error!, /Exa API error \(502\)/);
});

test("a backend that timed out is tried last until it answers or its cooldown ends", async () => {
  const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });
  const auth: SearchAuth = { codex: async () => ({ token: jwt() }), xai: async () => undefined, exa: async () => "exa-key" };
  const cooldowns = new Map();
  let codexUp = false, exaUp = true;
  const calls: string[] = [];
  const fetchImpl = async (input: any, init?: RequestInit) => {
    const codex = String(input).includes("api.openai.com");
    calls.push(codex ? "codex" : "exa");
    if (codex) return codexUp ? sseResponse([{ type: "response.web_search_call.completed" }, { type: "response.output_text.delta", delta: "Codex is back: https://pi.dev" }]) : hang(init);
    return exaUp ? jsonResponse({ results: [{ title: "Exa hit", url: "https://exa.ai", summary: "Fallback worked." }] }) : jsonResponse({ error: "down" }, 500);
  };
  const search = () => executeSearch({ query: "q" }, { auth, timeoutMs: 40, fetchImpl, cooldowns });

  assert.equal((await search()).response?.provider, "exa");
  assert.deepEqual(calls.splice(0), ["codex", "exa"]);
  // The next search does not wait for the stalled backend again.
  assert.equal((await search()).response?.provider, "exa");
  assert.deepEqual(calls.splice(0), ["exa"]);
  // An ordinary failure does not start a cooldown.
  assert.equal(cooldowns.has("exa"), false);

  // It is still the last resort, and an answer restores its place.
  exaUp = false; codexUp = true;
  assert.equal((await search()).response?.provider, "codex");
  assert.deepEqual(calls.splice(0), ["exa", "codex"]);
  assert.equal(cooldowns.size, 0);
  exaUp = true;
  assert.equal((await search()).response?.provider, "codex");
  assert.deepEqual(calls.splice(0), ["codex"]);

  const until = new Map([["codex", 1000]]) as Map<any, number>;
  assert.deepEqual(orderByHealth(["codex", "xai", "exa"], until, 999), ["xai", "exa", "codex"]);
  assert.deepEqual(orderByHealth(["codex", "xai", "exa"], until, 1000), ["codex", "xai", "exa"]);
});
