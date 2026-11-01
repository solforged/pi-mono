import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wrapAnthropicProvider } from "./compat.ts";

export default function (pi: ExtensionAPI) {
  const provider = builtinProviders().find(provider => provider.id === "anthropic");
  if (!provider) throw new Error("Anthropic integration requires Pi's built-in Anthropic provider");
  pi.registerProvider(wrapAnthropicProvider(provider));
}
