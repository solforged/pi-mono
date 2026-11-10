// Explicitly loaded only by the regression suite, after builtin:tool-search and
// the sessions and deferred-tools extensions. No model or network calls.
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SEARCH, section } from "../../extensions/deferred-tools/index.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("deferred-tools-smoke", {
    description: "Check that deferred tools are reachable through tool_search and listed",
    handler: async () => {
      const active = pi.getActiveTools();
      assert.ok(active.includes(SEARCH), `${SEARCH} was not turned on: ${active.join(", ")}`);
      assert.ok(!active.includes("session_search"), "session_search is declared before it was searched for");
      assert.match(section(pi.getAllTools()) ?? "", /^- sessions: Search and read earlier Pi sessions/m);
      console.log("Deferred tools integration: passed");
    },
  });
}
