// Tools registered with `exposure: "deferred"` stay out of every request until
// `tool_search` loads them. Models search reliably once they know a tool might
// exist, but small ones rarely guess that it does (docs/deferred-tools.md), so
// this turns `tool_search` on and lists the deferred groups in the prompt.
// MCP tools are left out: Pi lists their servers in its own section.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SEARCH = "tool_search";
export const SECTION = "deferred_tools";
export const ENTRY = "deferred-tools";

type Tool = { name: string; description?: string; exposure?: string; namespace?: { name: string; description?: string } };

// A tool selection on the command line is deliberate (children get theirs this
// way too), so tool_search is not added to it.
export const explicitSelection = (argv: readonly string[]) =>
  argv.some(arg => ["--tools", "-t", "--no-tools", "-nt", "--no-builtin-tools", "-nbt"].includes(arg.split("=")[0]));

export function groups(tools: readonly Tool[]): [string, string][] {
  const found = new Map<string, string>();
  for (const tool of tools) {
    if (tool.exposure !== "deferred" || tool.name.startsWith("mcp__")) continue;
    const name = tool.namespace?.name ?? tool.name;
    const text = tool.namespace?.description ?? tool.description?.split(/(?<=\.)\s/)[0] ?? "";
    if (!found.has(name)) found.set(name, text.replace(/\s+/g, " ").trim());
  }
  return [...found].sort(([a], [b]) => a.localeCompare(b));
}

// The list stays the same as groups are loaded, so the prompt section changes
// only when the deferred tools themselves do.
export function section(tools: readonly Tool[]): string | undefined {
  const listed = groups(tools);
  if (!listed.length) return;
  return [
    `Tool groups available on demand, not declared until loaded. Load the ones a task needs with \`${SEARCH}\`:`,
    ...listed.map(([name, text]) => `- ${name}${text ? `: ${text}` : ""}`),
  ].join("\n");
}

export function register(pi: ExtensionAPI, argv: readonly string[]) {
  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getAllTools(), active = pi.getActiveTools();
    if (explicitSelection(argv) || !groups(tools).length || !tools.some(tool => tool.name === SEARCH)) return;
    // Decided once per branch, so turning tool_search off with /tools sticks.
    if (active.includes(SEARCH) || ctx.sessionManager.getBranch().some(e => e.type === "custom" && (e as { customType?: string }).customType === ENTRY)) return;
    pi.setActiveTools([...active, SEARCH]);
    pi.appendEntry(ENTRY, { activated: SEARCH });
  });
  pi.on("before_agent_start", event => {
    const options = event.systemPromptOptions;
    if (!options.sections) return;
    const text = options.selectedTools?.includes(SEARCH) ? section(pi.getAllTools()) : undefined;
    if (text) options.sections[SECTION] = text;
    else delete options.sections[SECTION];
  });
}

export default function (pi: ExtensionAPI) {
  register(pi, process.argv);
}
