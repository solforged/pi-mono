import assert from "node:assert/strict";
import test from "node:test";
import { consumeCodexEvents, extractAccountId, extractTextSources, resolveCodexUrl, shouldRetryCodexModel } from "../extensions/web-search/codex.ts";
import { buildExaBody, parseExaResponse, recencyStartDate, synthesizeAnswer } from "../extensions/web-search/exa.ts";
import { formatFailures, formatForLLM, hasRenderableSearchContent, ProviderError, searchOrder, withRecencyHint } from "../extensions/web-search/format.ts";
import { executeSearch, type SearchAuth } from "../extensions/web-search/search.ts";
import { sseText } from "../extensions/web-search/sse.ts";
import { buildXaiBody, parseXaiResponse } from "../extensions/web-search/xai.ts";

function jwt(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(events: unknown[], status = 200): Response {
  return new Response(sseText(events), { status, headers: { "content-type": "text/event-stream" } });
}

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

test("Codex JWT, URL, markdown fallback, and event parsing", () => {
  assert.equal(extractAccountId(jwt("acct_1")), "acct_1");
  assert.equal(extractAccountId("not-a-jwt"), undefined);
  assert.equal(resolveCodexUrl(), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(resolveCodexUrl("https://chatgpt.com/backend-api/codex"), "https://chatgpt.com/backend-api/codex/responses");
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
      codex: async () => ({ token: jwt("acct_1"), accountId: "acct_1" }),
      xai: async () => undefined,
      exa: async () => "exa-key",
    },
    fetchImpl: async (input) => {
      n += 1;
      if (String(input).includes("chatgpt.com")) return sseResponse([{ type: "error", code: "rate_limit", message: "slow down" }]);
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
  assert.deepEqual(searchOrder("openai-codex"), ["codex", "xai", "exa"]);
  assert.deepEqual(searchOrder("nous-portal"), ["codex", "xai", "exa"]);

  const calls: string[] = [];
  const auth: SearchAuth = {
    codex: async () => ({ token: jwt("acct_1"), accountId: "acct_1" }),
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
