import { compact, estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { register } from "./controller.ts";

export default function (pi: ExtensionAPI) {
  // Pi's compact() is called by position and untyped. Run `mise run compaction:smoke`
  // after a Pi upgrade: it fails when the call no longer produces the summary.
  register(pi, { compact: compact as any, estimateTokens: estimateTokens as any });
}
