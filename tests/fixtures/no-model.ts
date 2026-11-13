// Loaded explicitly by smoke runs through `noModel` in tests/helpers.ts. Never
// deploy this fixture as an extension. `--offline` does not stop prompts, so a
// smoke command that is missing would otherwise reach the default model; this
// provider fails every request instead, which makes Pi exit nonzero.
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "../../extensions/workflows/process.ts";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("no-model", {
    baseUrl: "https://invalid.example", apiKey: "test-only-not-a-credential", api: "no-model",
    models: [{ id: "none", name: "No model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const error: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
        timestamp: Date.now(), stopReason: "error", errorMessage: "A smoke run reached the model; is its command registered?",
        content: [], usage: emptyUsage() };
      queueMicrotask(() => stream.push({ type: "error", reason: "error", error }));
      return stream;
    },
  });
}
