import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const roleNames = ["advisor", "task", "commit", "tiny", "learn"] as const;
export type RoleName = (typeof roleNames)[number];
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export interface Role {
  provider: string;
  model: string;
  thinking: (typeof thinkingLevels)[number];
  maxTokens: number;
  timeoutMs: number;
}
export interface Config {
  profile: string;
  sources: string[];
  autoname: boolean;
  roles: Record<RoleName, Role | null>;
  subagents: {
    concurrency: number;
    maxTasks: number;
    maxTurns: number;
    outputBytes: number;
    sandbox: "inherit" | "required";
    childExtensions: string[];
  };
  learning: { maxInputChars: number; maxChunks: number; maxCandidates: number };
}

type ObjectValue = Record<string, any>;
function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as ObjectValue;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${label}`);
  return Number(value);
}
export function expandHome(value: string): string {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}
export function profileName(env: NodeJS.ProcessEnv = process.env): string {
  const profile = env.PI_WORKFLOW_PROFILE ?? "personal";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(profile)) throw new Error("Invalid PI_WORKFLOW_PROFILE");
  return profile;
}

// Merge only the selected profile. In particular, work never inherits personal roles.
export function resolveConfig(base: unknown, local: unknown, profile: string, sources: string[] = []): Config {
  const b = object(base, "roles.json");
  const l = object(local, "roles.local.json");
  if (b.version !== 1 || (l.version !== undefined && l.version !== 1)) throw new Error("Unsupported roles config version");
  const bp = b.profiles?.[profile];
  const lp = l.profiles?.[profile];
  if (!bp && !lp) throw new Error(`Unknown workflow profile: ${profile}`);
  const p = { ...bp, ...lp };
  const roles = {} as Config["roles"];
  for (const name of roleNames) {
    const override = lp?.roles?.[name];
    const raw = override === undefined ? bp?.roles?.[name] : override === null ? null : { ...bp?.roles?.[name], ...object(override, `role ${name}`) };
    if (raw == null) { roles[name] = null; continue; }
    const r = object(raw, `role ${name}`);
    for (const key of ["provider", "model"]) {
      if (typeof r[key] !== "string" || !r[key].trim() || /\s/.test(r[key])) throw new Error(`Invalid ${name}.${key}`);
    }
    if (r.provider.includes("/")) throw new Error(`Invalid ${name}.provider`);
    if (!thinkingLevels.includes(r.thinking)) throw new Error(`Invalid ${name}.thinking`);
    roles[name] = {
      provider: r.provider, model: r.model, thinking: r.thinking,
      maxTokens: integer(r.maxTokens, 64, 32768, `${name}.maxTokens`),
      timeoutMs: integer(r.timeoutMs, 1000, 1800000, `${name}.timeoutMs`),
    };
  }
  const s = { ...b.subagents, ...l.subagents, ...bp?.subagents, ...lp?.subagents };
  if (!["inherit", "required"].includes(s.sandbox)) throw new Error("Invalid subagents.sandbox");
  if (!Array.isArray(s.childExtensions) || !s.childExtensions.every((x: unknown) => typeof x === "string" && (x.startsWith("/") || x.startsWith("~/")))) {
    throw new Error("childExtensions must contain explicit absolute local paths");
  }
  const learning = { ...b.learning, ...l.learning, ...bp?.learning, ...lp?.learning };
  if (typeof p.autoname !== "boolean") throw new Error("Invalid autoname setting");
  return {
    profile, sources, roles, autoname: p.autoname,
    subagents: {
      concurrency: integer(s.concurrency, 1, 8, "concurrency"),
      maxTasks: integer(s.maxTasks, 1, 16, "maxTasks"),
      maxTurns: integer(s.maxTurns, 1, 64, "maxTurns"),
      outputBytes: integer(s.outputBytes, 1024, 50000, "outputBytes"),
      sandbox: s.sandbox, childExtensions: s.childExtensions.map(expandHome),
    },
    learning: {
      maxInputChars: integer(learning.maxInputChars, 8000, 200000, "maxInputChars"),
      maxChunks: integer(learning.maxChunks, 1, 20, "maxChunks"),
      maxCandidates: integer(learning.maxCandidates, 1, 10, "maxCandidates"),
    },
  };
}

export async function readConfigFiles(root: string, agentDir: string) {
  let basePath = join(agentDir, "roles.json");
  let baseText: string;
  try { baseText = await readFile(basePath, "utf8"); }
  catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    basePath = join(root, "roles.json");
    baseText = await readFile(basePath, "utf8");
  }
  const localPath = join(agentDir, "roles.local.json");
  let localText: string | undefined;
  try { localText = await readFile(localPath, "utf8"); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  return {
    basePath, baseText, localPath, localText,
    base: object(JSON.parse(baseText), "roles.json"),
    local: object(localText === undefined ? {} : JSON.parse(localText), "roles.local.json"),
    sources: localText === undefined ? [basePath] : [basePath, localPath],
  };
}

export async function loadConfig(root: string, agentDir: string): Promise<Config> {
  const files = await readConfigFiles(root, agentDir);
  return resolveConfig(files.base, files.local, profileName(), files.sources);
}

export type ConfigSource = Config | (() => Config);
export function configSnapshot(source: ConfigSource): Config {
  return structuredClone(typeof source === "function" ? source() : source);
}

export interface ThinkingModel {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<Role["thinking"], string | null>>;
}
export function supportedThinking(model: ThinkingModel): Role["thinking"][] {
  if (!model.reasoning) return ["off"];
  return thinkingLevels.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level !== "xhigh" && level !== "max" || typeof mapped === "string";
  });
}

export function resolveRole(config: Config, name: RoleName, registry: ExtensionContext["modelRegistry"]) {
  const role = config.roles[name];
  if (!role) throw new Error(`Configure ${config.profile}.${name} in roles.local.json; no fallback is allowed`);
  const model = registry.find(role.provider, role.model);
  if (!model) throw new Error(`Model not registered: ${role.provider}/${role.model}`);
  if (!registry.hasConfiguredAuth(model)) throw new Error(`No configured authentication: ${role.provider}/${role.model}`);
  return { role, model };
}
