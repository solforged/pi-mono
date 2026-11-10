// Registers the mock catalog of scripts/deferred-tools-tasks.ts for scripts/deferred-tools-eval.ts;
// loaded explicitly, never installed. EVAL_EXPOSURE picks deferred (default) or direct;
// EVAL_LOG receives one JSON line per tool call, mock execution and search result.
// Bash and file tools are kept inside the scratch directory: no installs, network or home.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GROUPS, MOCKS, type Args } from "../../scripts/deferred-tools-tasks.ts";

const OUTSIDE_COMMAND = /\b(brew|pip3?|npm|npx|pnpm|uv|gem|apt(-get)?|curl|wget|ssh|psql|open)\b|~|\$HOME|\/Users\//;
const OUTSIDE_PATH = /^~|\/Users\//;

export default function (pi: ExtensionAPI) {
  const exposure = process.env.EVAL_EXPOSURE === "direct" ? "direct" : "deferred";
  const logPath = process.env.EVAL_LOG;
  const log = (record: unknown) => { if (logPath) appendFileSync(logPath, `${JSON.stringify(record)}\n`); };
  for (const mock of MOCKS) {
    const parameters = Type.Object(Object.fromEntries(Object.entries(mock.params).map(([key, description]) => [key, Type.String({ description })])));
    pi.registerTool({
      name: mock.name, label: mock.name, description: mock.description, parameters, exposure,
      namespace: { name: mock.group, description: GROUPS[mock.group] },
      async execute(_id, params) {
        log({ ev: "mock_exec", tool: mock.name, params });
        return { content: [{ type: "text", text: JSON.stringify(mock.reply?.(params as Args) ?? { ok: true }, null, 2) }], details: {} };
      },
    });
  }
  pi.on("tool_call", event => {
    const input = event.input as Args;
    log({ ev: "tool_call", tool: event.toolName, input });
    const command = event.toolName === "bash" ? String(input.command ?? "") : "";
    const path = ["read", "edit", "write"].includes(event.toolName) ? String(input.path ?? "") : "";
    if (OUTSIDE_COMMAND.test(command) || OUTSIDE_PATH.test(path)) {
      log({ ev: "blocked", tool: event.toolName });
      return { block: true, reason: "Not permitted in this environment: no package installs, network access, or home-directory access." };
    }
  });
  pi.on("tool_result", event => {
    if (event.toolName !== "tool_search") return;
    log({ ev: "search_result", text: event.content.map(part => (part.type === "text" ? part.text : "")).join("").slice(0, 800) });
  });
}
