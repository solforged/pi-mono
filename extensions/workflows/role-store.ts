import { lstat } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  profileName, readConfigFiles, resolveConfig, resolveRole, roleNames,
  supportedThinking, type Config, type Role, type RoleName,
} from "./roles.ts";
import { saveJson, withLock } from "./state.ts";

export type RoleEdit = Role | null | "reset";
export interface RoleDraft {
  files: Awaited<ReturnType<typeof readConfigFiles>>;
  config: Config;
  edits: Partial<Record<RoleName, RoleEdit>>;
}

// Drafts are disconnected from live settings. Cancel means dropping the draft.
function editedDocument(draft: RoleDraft) {
  const local = structuredClone(draft.files.local);
  for (const name of roleNames) {
    const edit = draft.edits[name];
    if (edit === undefined) continue;
    local.profiles ??= {};
    const profile = local.profiles[draft.config.profile] ??= {};
    const roles = profile.roles ??= {};
    if (edit === "reset") delete roles[name];
    else roles[name] = edit === null ? null : { ...roles[name], ...edit };
  }
  return local;
}

export function previewRoles(draft: RoleDraft): Config {
  return resolveConfig(
    draft.files.base, editedDocument(draft), draft.config.profile, draft.files.sources,
  );
}

export class RoleStore {
  private root: string;
  private agentDir: string;
  private current: Config;

  private constructor(root: string, agentDir: string, config: Config) {
    this.root = root;
    this.agentDir = agentDir;
    this.current = config;
  }

  static async create(root: string, agentDir: string, profile = profileName()) {
    const files = await readConfigFiles(root, agentDir);
    const config = resolveConfig(files.base, files.local, profile, files.sources);
    return new RoleStore(root, agentDir, config);
  }

  snapshot(): Config { return structuredClone(this.current); }

  async begin(): Promise<RoleDraft> {
    const files = await readConfigFiles(this.root, this.agentDir);
    return {
      files,
      config: resolveConfig(files.base, files.local, this.current.profile, files.sources),
      edits: {},
    };
  }

  async save(
    draft: RoleDraft,
    registry: ExtensionContext["modelRegistry"],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (draft.config.profile !== this.current.profile) throw new Error("Profile changed; reopen /roles");
    const next = previewRoles(draft);
    for (const name of roleNames) {
      // Preserve unavailable existing roles; validate newly chosen models locally.
      const edit = draft.edits[name];
      if (edit == null || edit === "reset") continue;
      const { role, model } = resolveRole(next, name, registry);
      if (!supportedThinking(model).includes(role.thinking)) {
        throw new Error(`Unsupported thinking level for ${name}: ${role.thinking}`);
      }
      if (role.maxTokens > model.maxTokens) {
        throw new Error(`${name} output limit exceeds the model's ${model.maxTokens} tokens`);
      }
    }
    await withLock(this.agentDir, "roles-edit", async () => {
      const latest = await readConfigFiles(this.root, this.agentDir);
      if (latest.basePath !== draft.files.basePath || latest.baseText !== draft.files.baseText || latest.localText !== draft.files.localText) {
        throw new Error("Role files changed while this panel was open; reopen /roles rather than overwrite them");
      }
      signal.throwIfAborted();
      if (Object.keys(draft.edits).length) {
        try {
          if ((await lstat(latest.localPath)).isSymbolicLink()) {
            throw new Error("roles.local.json is a symlink; edit its target manually rather than replace the link");
          }
        } catch (error: any) { if (error.code !== "ENOENT") throw error; }
        signal.throwIfAborted();
        await saveJson(latest.localPath, editedDocument(draft));
      }
      // Only roles are hot-swapped. Resource/limit changes still require /reload.
      this.current = {
        ...this.current,
        roles: structuredClone(next.roles),
        sources: Object.keys(draft.edits).length
          ? [latest.basePath, latest.localPath] : latest.sources,
      };
    });
  }
}
