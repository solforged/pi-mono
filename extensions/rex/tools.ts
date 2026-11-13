// One delegation tool per session. Rex children need a Rex pane, so outside Rex
// the Rex tools are dropped; inside Rex they replace the headless subagent tool.
// Only tools this switch removed are ever restored, so --tools, /tools and
// settings choices are left alone.
export const REX_TOOLS = ["rex_agent", "rex_send", "rex_result"];
export const TOOLS_ENTRY = "rex-tools";

export function switchTools(active: string[], registered: string[], inRex: boolean, removedBefore: string[]) {
  const drop = (inRex ? ["subagent"] : REX_TOOLS).filter(n => registered.includes(n));
  const restore = (inRex ? REX_TOOLS : ["subagent"]).filter(n => removedBefore.includes(n));
  const next = new Set(active);
  for (const name of restore) next.add(name);
  const dropped = drop.filter(n => next.delete(n));
  const removed = [...new Set([...removedBefore.filter(n => !restore.includes(n)), ...dropped])].sort();
  const changed = next.size !== active.length || [...next].some(n => !active.includes(n));
  return { active: [...next], removed, changed, recordChanged: removed.join() !== [...removedBefore].sort().join() };
}

/** Rex children open only from an interactive Pi in a Rex pane; print, JSON and RPC runs there keep `subagent`. */
export const canUseRex = (env: Record<string, string | undefined>, mode: string) => !!(env.REX_SESSION && env.REX_BLOCK) && mode === "tui";
