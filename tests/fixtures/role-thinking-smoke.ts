// Runs inside Pi so the test sees what its real providers send for a role's
// thinking level. Every HTTP request is intercepted and answered with an error;
// no credentials or network are needed.
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeRole } from "../../extensions/workflows/requests.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("role-thinking-smoke", {
    description: "Check the request Pi's bundled providers build for a role; mocked HTTP only",
    handler: async (_args, ctx) => {
      const real = ctx.modelRegistry as any;
      const catalog = (provider: string) => {
        const model = real.getAll().find((item: any) => item.provider === provider && item.reasoning);
        assert.ok(model, `Pi's catalog has a ${provider} reasoning model`);
        return model;
      };
      /** The request body completeRole sends for `model` when the role thinks at `thinking`. */
      async function sent(model: any, thinking: string): Promise<any> {
        let payload: any;
        const modelRegistry = {
          find: () => model, hasConfiguredAuth: () => true,
          streamSimple: (target: any, context: any, options: any) => real.streamSimple(target, context, {
            ...options, apiKey: "sk-test-not-a-credential", maxRetries: 0,
            fetch: async (input: any, init: any) => {
              payload = JSON.parse(await new Request(input, init).text());
              return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "role-thinking-smoke intercepted" } }), { status: 400, headers: { "content-type": "application/json" } });
            },
          }),
        };
        const config = { profile: "smoke", roles: { tiny: { provider: model.provider, model: model.id, thinking, maxTokens: 2048, timeoutMs: 20000 } } };
        await assert.rejects(completeRole({ modelRegistry } as any, config as any, "tiny", "Keep it short.", "Hello", new AbortController().signal), /^Error: tiny: /);
        assert.ok(payload, "the request reached the intercepted fetch");
        return payload;
      }

      const anthropic = catalog("anthropic");
      const variant = (compat: object, thinkingLevelMap: object = {}) => ({ ...anthropic, thinkingLevelMap, compat: { ...anthropic.compat, supportsMidConvoEffort: false, ...compat } });

      const adaptive = await sent(variant({ forceAdaptiveThinking: true }), "low");
      assert.equal(adaptive.thinking?.type, "adaptive");
      assert.deepEqual(adaptive.output_config, { effort: "low" });

      const budget = await sent(variant({ forceAdaptiveThinking: false }), "medium");
      assert.equal(budget.thinking?.type, "enabled");
      assert.ok(budget.thinking.budget_tokens >= 1024);
      assert.equal(budget.max_tokens - budget.thinking.budget_tokens, 2048, "the role's limit stays the answer's");

      const off = await sent(variant({ forceAdaptiveThinking: false }), "off");
      assert.deepEqual(off.thinking, { type: "disabled" });
      assert.equal(off.max_tokens, 2048);

      const openai = await sent(catalog("openai"), "low");
      assert.equal(openai.reasoning?.effort, "low");

      console.log("Role thinking: adaptive, budget, off and OpenAI requests passed");
    },
  });
}
