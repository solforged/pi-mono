// Remembers the last on/off toggle per project root, in the agent directory,
// which the guest cannot see. An entry exists only while it differs from
// settings, so settings take over again once you toggle back.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteSync } from "../shared/system.ts";

export const togglesFile = (agentDir: string) => join(agentDir, "sandbox-toggles.json");

function read(file: string): Record<string, boolean> {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

export const savedToggle = (file: string, root: string): boolean | undefined => read(file)[root];

export function saveToggle(file: string, root: string, enabled: boolean, settingsDefault: boolean) {
  const toggles = read(file);
  if (enabled === settingsDefault) delete toggles[root];
  else toggles[root] = enabled;
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteSync(file, `${JSON.stringify(toggles, null, 2)}\n`);
}
