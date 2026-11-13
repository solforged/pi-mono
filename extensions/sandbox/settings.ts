// Sandbox settings come from the agent directory's settings.json only. Project
// .pi/settings.json is writable from inside the sandbox, so it never loosens
// the sandbox; per-project overrides live under `sandbox.projects` instead.
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface ExtraMount { path: string; readonly: boolean }
export interface Settings {
  enabled: boolean;
  cpus: number;
  memory: string;
  wiki: "rw" | "ro" | "off";
  mounts: ExtraMount[];
  image?: string;
}
// Off by default while sandboxing is still being tested; opt in with
// `"enabled": true`, `--sandbox on`, or `/sandbox on`.
export const DEFAULTS: Settings = { enabled: false, cpus: 6, memory: "8G", wiki: "rw", mounts: [] };

export const expandHome = (path: string, home = homedir()) =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
export const isInside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const object = (value: unknown, where: string): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
};

function layer(base: Settings, raw: Record<string, unknown>, where: string, home: string): Settings {
  const next = { ...base, mounts: [...base.mounts] };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "projects" && where === "sandbox") continue;
    if (key === "enabled") {
      if (typeof value !== "boolean") throw new Error(`${where}.enabled must be true or false`);
      next.enabled = value;
    } else if (key === "cpus") {
      if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${where}.cpus must be a positive integer`);
      next.cpus = value as number;
    } else if (key === "memory") {
      if (typeof value !== "string" || !/^\d+[KMGT]?$/i.test(value)) throw new Error(`${where}.memory must look like "8G"`);
      next.memory = value;
    } else if (key === "wiki") {
      if (value !== "rw" && value !== "ro" && value !== "off") throw new Error(`${where}.wiki must be "rw", "ro", or "off"`);
      next.wiki = value;
    } else if (key === "image") {
      if (typeof value !== "string" || !value.trim()) throw new Error(`${where}.image must be an image reference`);
      next.image = value.trim();
    } else if (key === "mounts") {
      if (!Array.isArray(value)) throw new Error(`${where}.mounts must be an array`);
      for (const [i, item] of value.entries()) {
        const entry = typeof item === "string" ? { path: item } : object(item, `${where}.mounts[${i}]`);
        if (typeof entry.path !== "string" || !entry.path) throw new Error(`${where}.mounts[${i}].path is required`);
        if (entry.readonly !== undefined && typeof entry.readonly !== "boolean") throw new Error(`${where}.mounts[${i}].readonly must be true or false`);
        const expanded = expandHome(entry.path, home);
        if (!isAbsolute(expanded)) throw new Error(`${where}.mounts[${i}].path must be absolute or start with ~/`);
        next.mounts.push({ path: resolve(expanded), readonly: entry.readonly !== false });
      }
    } else throw new Error(`Unknown setting ${where}.${key}`);
  }
  return next;
}

// Applies global sandbox settings, then every `projects` entry containing the
// root, shortest path first, so the closest project entry wins.
export function resolveSettings(raw: unknown, root: string, home = homedir()): Settings {
  const sandbox = object(raw, "sandbox");
  let settings = layer(DEFAULTS, sandbox, "sandbox", home);
  const projects = Object.entries(object(sandbox.projects, "sandbox.projects"))
    .map(([path, value]) => ({ path: resolve(expandHome(path, home)), key: path, value }))
    .filter(({ path }) => isInside(path, root))
    .sort((a, b) => a.path.length - b.path.length);
  for (const { key, value } of projects) settings = layer(settings, object(value, `sandbox.projects["${key}"]`), `sandbox.projects["${key}"]`, home);
  return settings;
}

export type Choice = { enabled: boolean; source: "flag" | "environment" | "saved" | "session" | "settings" };
const parseSwitch = (value: unknown, where: string) => {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "string" && /^(on|true|1)$/i.test(value)) return true;
  if (typeof value === "string" && /^(off|false|0)$/i.test(value)) return false;
  throw new Error(`${where} must be "on" or "off"`);
};
// --sandbox beats PI_SANDBOX, which carries a parent's choice into children;
// then the project's saved toggle, then settings. `carried` says this session
// just moved, inside one process, from another checkout of the same repository
// with the sandbox on: it stays on, since the model can make that move.
export function chooseEnabled(flag: unknown, env: string | undefined, saved: boolean | undefined, settings: Pick<Settings, "enabled">, carried = false): Choice {
  const fromFlag = parseSwitch(flag, "--sandbox");
  if (fromFlag !== undefined) return { enabled: fromFlag, source: "flag" };
  const fromEnv = parseSwitch(env, "PI_SANDBOX");
  if (fromEnv !== undefined) return { enabled: fromEnv, source: "environment" };
  if (saved !== undefined) return { enabled: saved, source: "saved" };
  if (carried && !settings.enabled) return { enabled: true, source: "session" };
  return { enabled: settings.enabled, source: "settings" };
}

// PI_SANDBOX set by this process is its own state for children, not an
// instruction from a parent; PI_SANDBOX_FROM names the process that set it.
export function inheritedSwitch(env: NodeJS.ProcessEnv, pid = process.pid) {
  return env.PI_SANDBOX_FROM === String(pid) ? undefined : env.PI_SANDBOX;
}
