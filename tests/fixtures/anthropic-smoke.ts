// Runs inside Pi so tests exercise its real bundled SDK and stream parser.
// Every HTTP request is intercepted; no credentials or network are needed.
import assert from "node:assert/strict";
import { normalizeContext } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import install from "../../extensions/anthropic/index.ts";
import { createVersionState, DEFAULT_VERSION, wrapAnthropicProvider } from "../../extensions/anthropic/compat.ts";

function sse(events: any[]): Response {
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
function events(tool = false, empty = false) {
  return [
    { type: "message_start", message: {
      id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 },
    } },
    ...(!empty ? tool ? [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_test", name: "Read", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"test.ts"}' } },
      { type: "content_block_stop", index: 0 },
    ] : [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello 🦊" } },
      { type: "content_block_stop", index: 0 },
    ] : []),
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

export default function (pi: ExtensionAPI) {
  install(pi);
  pi.registerCommand("anthropic-smoke", {
    description: "Test the Anthropic integration with Pi's bundled SDK; mocked HTTP only",
    handler: async () => {
      const registrations: any[] = [];
      install({
        registerProvider: (provider: unknown) => { registrations.push(provider); },
        registerCommand: () => assert.fail("The Anthropic integration must not register commands"),
      } as unknown as ExtensionAPI);
      assert.equal(registrations.length, 1);
      assert.equal(registrations[0].id, "anthropic");
      assert.equal(registrations[0].name, "Anthropic");
      const base = builtinProviders().find(provider => provider.id === "anthropic")!;
      const state = createVersionState();
      const provider = wrapAnthropicProvider(base, state);
      const model = { ...base.getModels()[0], id: "claude-opus-5-5", maxTokens: 128000, contextWindow: 1000000 };
      const context = normalizeContext({
        systemPrompt: "Keep it short.",
        tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } as any],
        messages: [{ role: "user", content: "Hello 🦊", timestamp: 1 }],
      });
      assert.equal(provider.auth, base.auth);
      for (const kind of ["text", "tool", "empty", "version", "api-key", "proxy"] as const) {
        const captured: { headers: Headers; payload: any }[] = [];
        let responses = 0;
        let rawEvents = 0;
        let payloadHooks = 0;
        const stream = provider.streamSimple(kind === "proxy" ? { ...model, baseUrl: "https://proxy.example" } : model, context, {
          apiKey: kind === "api-key" ? "sk-ant-api-test" : "sk-ant-oat-test",
          sessionId: "test-session",
          maxRetries: 0,
          onPayload(payload: any) { payloadHooks++; return { ...payload, test_hook: "kept" }; },
          onResponse() { responses++; },
          onProviderStreamEvent() { rawEvents++; },
          fetch: async (input, init) => {
            const req = new Request(input, init);
            const payload = JSON.parse(await req.text());
            captured.push({ headers: req.headers, payload });
            assert.equal(payload.test_hook, "kept");
            assert.equal(payload.max_tokens, 128000, "no subscription-specific 64k cap");
            if (kind === "version" && captured.length === 1) {
              return new Response(JSON.stringify({ error: { type: "claude_code_version_too_old", message: "Claude Code version 2.1.301 or newer is required" } }), { status: 400, headers: { "content-type": "application/json" } });
            }
            return sse(events(kind === "tool", kind === "empty"));
          },
        });
        const parsed = [];
        for await (const event of stream) parsed.push(event);
        const result = await stream.result();
        assert.notEqual(result.stopReason, "error", result.errorMessage);
        assert.equal(parsed.filter(event => event.type === "start").length, 1);
        assert.equal(parsed.filter(event => event.type === "done").length, 1);
        assert.equal(responses, 1);
        assert.equal(payloadHooks, 1);
        assert.ok(rawEvents >= 3);
        assert.equal(result.usage.input, 10);
        assert.equal(result.usage.output, 5);
        assert.equal(result.usage.cacheRead, 20);
        assert.equal(result.usage.cacheWrite, 30);
        if (kind === "tool") {
          assert.equal(result.content[0].type, "toolCall");
          assert.equal((result.content[0] as any).name, "read");
          assert.deepEqual((result.content[0] as any).arguments, { path: "test.ts" });
        } else if (kind !== "empty") assert.equal((result.content[0] as any).text, "Hello 🦊");
        if (kind === "api-key" || kind === "proxy") {
          assert.ok(!captured[0].payload.system?.[0]?.text.startsWith("x-anthropic-billing-header:"));
        } else {
          assert.match(captured[0].payload.system[0].text, /x-anthropic-billing-header:/);
          assert.equal(captured[0].headers.get("user-agent"), `claude-cli/${DEFAULT_VERSION} (external, cli)`);
        }
        if (kind === "version") {
          assert.equal(captured.length, 2);
          assert.match(captured[1].payload.system[0].text, /cc_version=2\.1\.301\./);
          assert.equal(state.version(), "2.1.301");
        }
      }
      console.log("Anthropic integration: bundled SDK, text, tools, empty output, usage, hooks, version retry, API keys, and proxies passed");
    },
  });
}
