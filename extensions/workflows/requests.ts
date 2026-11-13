import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveRole, type Config, type RoleName } from "./roles.ts";

export function responseText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();
}
export async function completeRole(ctx: ExtensionContext, config: Config, name: RoleName, systemPrompt: string, text: string, signal: AbortSignal) {
  const { role, model } = resolveRole(config, name, ctx.modelRegistry);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(role.timeoutMs)]);
  deadline.throwIfAborted();
  const response = await ctx.modelRegistry.complete(model, {
    systemPrompt,
    messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
  }, {
    signal: deadline, maxTokens: role.maxTokens,
    reasoningEffort: role.thinking === "off" ? undefined : role.thinking,
    cacheRetention: "none", sessionId: randomUUID(),
  });
  deadline.throwIfAborted();
  if (["error", "aborted", "length"].includes(response.stopReason)) {
    // Failed calls can still cost tokens; callers that count spend read them here.
    throw Object.assign(new Error(`${name}: ${response.errorMessage ?? response.stopReason}`), { usage: response.usage });
  }
  return { text: responseText(response), usage: response.usage, provider: role.provider, model: role.model };
}
