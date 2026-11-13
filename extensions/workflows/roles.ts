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
/** A preset's main conversation model; only an explicit /modelpreset applies it. */
export interface MainModel {
  provider: string;
  model: string;
  thinking: Role["thinking"];
}
export interface Config {
  profile: string;
  sources: string[];
  autoname: boolean;
  /** Active preset, when the profile defines presets. */
  preset?: string;
  presets: string[];
  main: MainModel | null;
  roles: Record<RoleName, Role | null>;
  subagents: {
    concurrency: number;
    /** Live interactive Rex children (rex extension); separate from headless concurrency. */
    rexConcurrency: number;
    /** Concurrent eval-kernel children (workflowz extension); separate from the other limits. */
    evalConcurrency: number;
    maxTasks: number;
    maxTurns: number;
    outputBytes: number;
    sandbox: "inherit" | "required";
    childExtensions: string[];
    /** Classifier model for workflowz judges; null judges with the tiny role. */
    judge: { provider: string; model: string } | null;
  };
  learning: {
    maxInputChars: number; maxChunks: number; maxCandidates: number;
    /** Automatic learning: off unless enabled here or per project with /autolearn. */
    auto: { enabled: boolean; minSessions: number; maxSkills: number };
  };
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
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
export function profileName(env: NodeJS.ProcessEnv = process.env): string {
  const profile = env.PI_WORKFLOW_PROFILE ?? "personal";
  if (!NAME.test(profile)) throw new Error("Invalid PI_WORKFLOW_PROFILE");
  return profile;
}

// Later layers win field by field; null disables, and an object after null starts afresh.
function layered(layers: unknown[], label: string): ObjectValue | null | undefined {
  let raw: ObjectValue | null | undefined;
  for (const layer of layers) {
    if (layer === undefined) continue;
    raw = layer === null ? null : { ...raw, ...object(layer, label) };
  }
  return raw;
}
function modelRef(r: ObjectValue, name: string) {
  for (const key of ["provider", "model"]) {
    if (typeof r[key] !== "string" || !r[key].trim() || /\s/.test(r[key])) throw new Error(`Invalid ${name}.${key}`);
  }
  if (r.provider.includes("/")) throw new Error(`Invalid ${name}.provider`);
  if (!thinkingLevels.includes(r.thinking)) throw new Error(`Invalid ${name}.thinking`);
  return { provider: r.provider as string, model: r.model as string, thinking: r.thinking as Role["thinking"] };
}

// Merge only the selected profile. In particular, work never inherits personal roles.
// Within it, the active preset's roles override the profile's: base, local, base preset, local preset.
export function resolveConfig(base: unknown, local: unknown, profile: string, sources: string[] = [], preset?: string): Config {
  const b = object(base, "roles.json");
  const l = object(local, "roles.local.json");
  if (b.version !== 1 || (l.version !== undefined && l.version !== 1)) throw new Error("Unsupported roles config version");
  const bp = b.profiles?.[profile];
  const lp = l.profiles?.[profile];
  if (!bp && !lp) {
    const moved = b.profiles?.personal?.presets?.[profile] ? `; ${profile} is now a personal preset: run /modelpreset ${profile}` : "";
    throw new Error(`Unknown workflow profile: ${profile}${moved}`);
  }
  const p = { ...bp, ...lp };
  const presets = [...new Set([...Object.keys(bp?.presets ?? {}), ...Object.keys(lp?.presets ?? {})])];
  for (const name of presets) if (!NAME.test(name)) throw new Error(`Invalid preset name: ${name}`);
  const chosen = preset ?? (presets.length ? p.preset : undefined);
  if (presets.length && typeof chosen !== "string") throw new Error(`Set profiles.${profile}.preset to a default preset`);
  if (chosen !== undefined && !presets.includes(chosen)) throw new Error(`Unknown preset ${profile}.${chosen}; choose one with /modelpreset`);
  const bs = chosen === undefined ? undefined : bp?.presets?.[chosen];
  const ls = chosen === undefined ? undefined : lp?.presets?.[chosen];
  const rawMain = layered([bs?.main, ls?.main], "preset main");
  const main = rawMain ? modelRef(rawMain, "main") : null;
  const roles = {} as Config["roles"];
  for (const name of roleNames) {
    const raw = layered([bp?.roles?.[name], lp?.roles?.[name], bs?.roles?.[name], ls?.roles?.[name]], `role ${name}`);
    if (raw == null) { roles[name] = null; continue; }
    roles[name] = {
      ...modelRef(raw, name),
      maxTokens: integer(raw.maxTokens, 64, 32768, `${name}.maxTokens`),
      timeoutMs: integer(raw.timeoutMs, 1000, 1800000, `${name}.timeoutMs`),
    };
  }
  const s = { ...b.subagents, ...l.subagents, ...bp?.subagents, ...lp?.subagents };
  if (!["inherit", "required"].includes(s.sandbox)) throw new Error("Invalid subagents.sandbox");
  const judge = s.judge ?? null;
  if (judge !== null && !(typeof judge.provider === "string" && judge.provider && typeof judge.model === "string" && judge.model)) throw new Error("subagents.judge must be null or { provider, model }");
  if (!Array.isArray(s.childExtensions) || !s.childExtensions.every((x: unknown) => typeof x === "string" && (x.startsWith("/") || x.startsWith("~/")))) {
    throw new Error("childExtensions must contain explicit absolute local paths");
  }
  const learning = { ...b.learning, ...l.learning, ...bp?.learning, ...lp?.learning };
  const auto = { ...b.learning?.auto, ...l.learning?.auto, ...bp?.learning?.auto, ...lp?.learning?.auto };
  if (typeof auto.enabled !== "boolean") throw new Error("Invalid learning.auto.enabled");
  if (typeof p.autoname !== "boolean") throw new Error("Invalid autoname setting");
  return {
    profile, sources, roles, autoname: p.autoname, preset: chosen, presets, main,
    subagents: {
      concurrency: integer(s.concurrency, 1, 8, "concurrency"),
      rexConcurrency: integer(s.rexConcurrency ?? 6, 1, 16, "rexConcurrency"),
      evalConcurrency: integer(s.evalConcurrency ?? 6, 1, 16, "evalConcurrency"),
      maxTasks: integer(s.maxTasks, 1, 16, "maxTasks"),
      maxTurns: integer(s.maxTurns, 1, 64, "maxTurns"),
      outputBytes: integer(s.outputBytes, 1024, 50000, "outputBytes"),
      sandbox: s.sandbox, childExtensions: s.childExtensions.map(expandHome),
      judge: judge && { provider: judge.provider, model: judge.model },
    },
    learning: {
      maxInputChars: integer(learning.maxInputChars, 8000, 200000, "maxInputChars"),
      maxChunks: integer(learning.maxChunks, 1, 20, "maxChunks"),
      maxCandidates: integer(learning.maxCandidates, 1, 10, "maxCandidates"),
      auto: {
        enabled: auto.enabled,
        minSessions: integer(auto.minSessions, 2, 20, "learning.auto.minSessions"),
        maxSkills: integer(auto.maxSkills, 0, 200, "learning.auto.maxSkills"),
      },
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

/** Pass the session branch so callers outside the role store see its recorded preset. */
export async function loadConfig(root: string, agentDir: string, branch: readonly unknown[] = []): Promise<Config> {
  const files = await readConfigFiles(root, agentDir);
  const profile = profileName();
  return resolveConfig(files.base, files.local, profile, files.sources, branchPreset(branch, profile));
}

// The session branch records the active preset; sessions without one use the profile default.
export const presetEntry = "workflow-preset";
export function branchPreset(branch: readonly unknown[], profile: string): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: string; customType?: string; data?: { profile?: unknown; preset?: unknown } };
    if (entry?.type === "custom" && entry.customType === presetEntry && entry.data?.profile === profile && typeof entry.data.preset === "string") {
      return entry.data.preset;
    }
  }
}
// The last /modelpreset choice per profile; new sessions start with it.
export const rememberedPresetFile = (agentDir: string, profile: string) => join(agentDir, "workflow-state", profile, "preset.json");
export async function rememberedPreset(agentDir: string, profile: string): Promise<string | undefined> {
  try {
    const preset = JSON.parse(await readFile(rememberedPresetFile(agentDir, profile), "utf8"))?.preset;
    return typeof preset === "string" ? preset : undefined;
  } catch { return undefined; }
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

function available(registry: ExtensionContext["modelRegistry"], provider: string, id: string) {
  const model = registry.find(provider, id);
  if (!model) throw new Error(`Model not registered: ${provider}/${id}`);
  if (!registry.hasConfiguredAuth(model)) throw new Error(`No configured authentication: ${provider}/${id}`);
  return model;
}
export function resolveRole(config: Config, name: RoleName, registry: ExtensionContext["modelRegistry"]) {
  const role = config.roles[name];
  if (!role) throw new Error(`Configure ${config.profile}.${name} in roles.local.json; no fallback is allowed`);
  return { role, model: available(registry, role.provider, role.model) };
}
/** Checks a role against model metadata before it is saved or switched to. */
export function checkRole(config: Config, name: RoleName, registry: ExtensionContext["modelRegistry"]) {
  const { role, model } = resolveRole(config, name, registry);
  if (!supportedThinking(model).includes(role.thinking)) {
    throw new Error(`Unsupported thinking level for ${name}: ${role.thinking}`);
  }
  if (role.maxTokens > model.maxTokens) {
    throw new Error(`${name} output limit exceeds the model's ${model.maxTokens} tokens`);
  }
}
/** Checks every configured role and the main model; returns the main model, if any. */
export function checkLineup(config: Config, registry: ExtensionContext["modelRegistry"]) {
  for (const name of roleNames) if (config.roles[name]) checkRole(config, name, registry);
  if (!config.main) return undefined;
  const model = available(registry, config.main.provider, config.main.model);
  if (!supportedThinking(model).includes(config.main.thinking)) throw new Error(`Unsupported thinking level for main: ${config.main.thinking}`);
  return model;
}
