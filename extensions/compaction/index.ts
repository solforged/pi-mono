import { compact, estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { register } from "./controller.ts";

export default function (pi: ExtensionAPI) {
  register(pi, { compact: compact as any, estimateTokens: estimateTokens as any });
}
