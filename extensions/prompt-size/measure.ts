// What the fixed part of every request costs: the system prompt by section and
// the active tool declarations by the extension that registered them.
import { basename, dirname } from "node:path";

export interface ToolInfo { name: string; description?: string; parameters?: unknown; sourceInfo?: { path?: string; source?: string } }
export interface Row { name: string; chars: number }

/** Characters of the JSON a provider receives for one tool. */
export const declarationSize = (t: ToolInfo) =>
  JSON.stringify({ name: t.name, description: t.description ?? "", parameters: t.parameters ?? {} }).length;

/** `rex` for `.../extensions/rex/index.ts`, `pi` for Pi's own tools. */
export function owner(t: ToolInfo) {
  const path = t.sourceInfo?.path ?? "";
  if (t.sourceInfo?.source === "builtin" || path.startsWith("builtin:")) return "pi";
  if (!path) return "unknown";
  return /^index\.[cm]?[jt]s$/.test(basename(path)) ? basename(dirname(path)) : basename(path).replace(/\.[cm]?[jt]s$/, "");
}

/** Top-level `<tag>…</tag>` sections of the prompt; untagged text is `other`. */
export function sections(prompt: string): Row[] {
  const rows: Row[] = [];
  let rest = prompt.length;
  for (const m of prompt.matchAll(/<([a-z][a-z0-9_-]*)>[\s\S]*?<\/\1>/g)) { rows.push({ name: m[1], chars: m[0].length }); rest -= m[0].length; }
  if (rest > 0) rows.push({ name: "other", chars: rest });
  return rows.sort((a, b) => b.chars - a.chars);
}

export function measure(prompt: string, tools: ToolInfo[]) {
  const toolRows = tools.map(t => ({ name: t.name, owner: owner(t), chars: declarationSize(t) })).sort((a, b) => b.chars - a.chars);
  const owners = new Map<string, number>();
  for (const t of toolRows) owners.set(t.owner, (owners.get(t.owner) ?? 0) + t.chars);
  const toolChars = toolRows.reduce((s, t) => s + t.chars, 0);
  return { sections: sections(prompt), tools: toolRows, owners: [...owners].map(([name, chars]) => ({ name, chars })).sort((a, b) => b.chars - a.chars),
    promptChars: prompt.length, toolChars, total: prompt.length + toolChars };
}

const kb = (n: number) => `${(n / 1000).toFixed(1)} KB`.padStart(8);

export function report(m: ReturnType<typeof measure>) {
  const lines = [`Fixed prompt: ${kb(m.total).trim()} (~${Math.round(m.total / 4).toLocaleString("en")} tokens) = system prompt ${kb(m.promptChars).trim()} + ${m.tools.length} tool declarations ${kb(m.toolChars).trim()}`, "", "System prompt sections:"];
  for (const s of m.sections) lines.push(`${kb(s.chars)}  ${s.name}`);
  lines.push("", "Tool declarations by extension:");
  for (const o of m.owners) lines.push(`${kb(o.chars)}  ${o.name}: ${m.tools.filter(t => t.owner === o.name).map(t => `${t.name} ${t.chars}`).join(", ")}`);
  lines.push("", "Sizes are characters of JSON or text; tokens are estimated at 4 characters each.");
  return lines.join("\n");
}
