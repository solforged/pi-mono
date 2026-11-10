// Turns probed host facts into a container plan: same-path mounts, read-only
// guards over Git and Pi configuration, Linux build-output overlays, and the
// guest environment. Pure, so the policy is testable without a container.
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { isInside, type Settings } from "./settings.ts";

export interface Probe {
  root: string;
  home: string;
  cacheRoot: string;
  commonDir?: string;
  wikiDir?: string;
  contextDirs: string[];
  identity: { name?: string; email?: string };
  kind: (path: string) => "file" | "dir" | undefined;
}
export interface Mount { source: string; target: string; readonly: boolean; label: string }
export interface Plan {
  name: string;
  root: string;
  image: string;
  cpus: number;
  memory: string;
  mounts: Mount[];
  readOnlyPaths: string[];
  hostDirs: string[];
  env: Record<string, string>;
  labels: Record<string, string>;
  wiki?: string;
  wikiBuild: boolean;
}

export const GUEST_CACHE = "/cache";
const OVERLAYS: Array<[manifest: string, dir: string]> = [["package.json", "node_modules"], ["Cargo.toml", "target"], ["pyproject.toml", ".venv"]];
const hash = (value: string, length = 10) => createHash("sha256").update(value).digest("hex").slice(0, length);

export function containerName(root: string) {
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "root";
  return `pi-sbx-${slug}-${hash(root)}`;
}

function refuseBroad(path: string, home: string, what: string) {
  if (path === "/" || isInside(path, home)) throw new Error(`Refusing to mount ${path} as ${what}: it contains your home directory. Start Pi in a project directory, or turn the sandbox off.`);
  if (path.includes(",")) throw new Error(`Cannot mount ${path}: commas are not supported in sandbox mount paths`);
}

export function buildPlan(probe: Probe, settings: Settings, image: string): Plan {
  const { root, home, cacheRoot } = probe;
  refuseBroad(root, home, "the project");
  const mounts: Mount[] = [];
  const covered = (path: string, readonly: boolean) => mounts.some((m) => isInside(m.target, path) && (readonly || !m.readonly));
  const add = (source: string, readonly: boolean, label: string, target = source) => {
    if (target === source && covered(source, readonly)) return false;
    mounts.push({ source, target, readonly, label });
    return true;
  };

  add(root, false, "project");
  if (probe.commonDir && !isInside(root, probe.commonDir)) add(probe.commonDir, false, "Git metadata");
  let wiki: string | undefined;
  if (probe.wikiDir && settings.wiki !== "off") {
    refuseBroad(probe.wikiDir, home, "the wiki");
    add(probe.wikiDir, settings.wiki === "ro", "wiki");
    wiki = probe.wikiDir;
  }
  for (const extra of settings.mounts) {
    refuseBroad(extra.path, home, "a shared folder");
    if (!probe.kind(extra.path)) throw new Error(`Shared folder does not exist: ${extra.path}`);
    add(extra.path, extra.readonly, "shared");
  }
  for (const dir of probe.contextDirs) add(dir, true, "context");

  const hostDirs: string[] = [];
  const shared = join(cacheRoot, "shared");
  hostDirs.push(shared);
  mounts.push({ source: shared, target: GUEST_CACHE, readonly: false, label: "cache" });

  // Platform-specific build outputs get Linux-only directories per worktree,
  // so the guest never mixes its artifacts with the host's.
  const worktreeCache = join(cacheRoot, "worktrees", containerName(root));
  for (const [manifest, dir] of OVERLAYS) {
    if (probe.kind(join(root, manifest)) !== "file") continue;
    const source = join(worktreeCache, dir);
    hostDirs.push(source);
    mounts.push({ source, target: join(root, dir), readonly: false, label: "Linux build output" });
  }
  // The host's wiki binary is for macOS; a Linux build goes over its bin/.
  const wikiBuild = !!wiki && probe.kind(join(wiki, "cmd", "wiki")) === "dir";
  if (wiki && wikiBuild) {
    const source = join(cacheRoot, "wiki-bin");
    hostDirs.push(source);
    mounts.push({ source, target: join(wiki, "bin"), readonly: false, label: "Linux wiki binary" });
  }

  // Host Git and Pi act on these without the user running anything, so the
  // guest must not be able to change them: repository config and hooks, a
  // linked worktree's .git pointer, and project Pi resources.
  const readOnlyPaths: string[] = [];
  const writable = (path: string) => mounts.some((m) => !m.readonly && m.target === m.source && isInside(m.target, path))
    && !mounts.some((m) => m.target !== m.source && isInside(m.target, path));
  const guard = (path: string) => { if (writable(path) && !readOnlyPaths.includes(path)) readOnlyPaths.push(path); };
  const guardGitDir = (dir: string) => {
    if (probe.kind(join(dir, "config")) === "file") guard(join(dir, "config"));
    if (!probe.kind(join(dir, "hooks"))) hostDirs.push(join(dir, "hooks"));
    guard(join(dir, "hooks"));
  };
  if (probe.commonDir) guardGitDir(probe.commonDir);
  for (const mount of mounts.filter((m) => !m.readonly && m.target === m.source)) {
    const dotGit = join(mount.source, ".git");
    const kind = probe.kind(dotGit);
    if (kind === "file") guard(dotGit);
    else if (kind === "dir" && dotGit !== probe.commonDir) guardGitDir(dotGit);
    if (probe.kind(join(mount.source, ".pi")) === "dir") guard(join(mount.source, ".pi"));
  }

  const env: Record<string, string> = {
    HOME: home,
    LANG: "C.UTF-8",
    PI_SANDBOX_GUEST: "1",
    GIT_CONFIG_GLOBAL: "/etc/pi-sandbox/gitconfig",
    MISE_DATA_DIR: `${GUEST_CACHE}/mise`,
    MISE_CACHE_DIR: `${GUEST_CACHE}/mise-cache`,
    MISE_TRUSTED_CONFIG_PATHS: root,
    MISE_YES: "1",
    CARGO_HOME: `${GUEST_CACHE}/cargo`,
    RUSTUP_HOME: `${GUEST_CACHE}/rustup`,
    GOPATH: `${GUEST_CACHE}/go`,
    GOCACHE: `${GUEST_CACHE}/go-build`,
    npm_config_cache: `${GUEST_CACHE}/npm`,
    UV_CACHE_DIR: `${GUEST_CACHE}/uv`,
    PIP_CACHE_DIR: `${GUEST_CACHE}/pip`,
  };
  // Environment config outranks repository config, so a repository that turns
  // signing off still cannot commit in the guest without --no-gpg-sign.
  const gitConfig: Array<[string, string]> = [
    ["commit.gpgSign", "true"], ["tag.gpgSign", "true"], ["gpg.format", "ssh"],
    ["gpg.ssh.program", "/usr/local/libexec/pi-sandbox/refuse-sign"],
    ["user.signingKey", "key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPiSandboxSigningRefusedPlaceholderKeyAAAA pi-sandbox"],
  ];
  env.GIT_CONFIG_COUNT = String(gitConfig.length);
  gitConfig.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value; });
  if (wiki) env.LLM_WIKI_DIR = wiki;
  if (probe.identity.name) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = probe.identity.name;
  if (probe.identity.email) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = probe.identity.email;

  const plan: Plan = {
    name: containerName(root), root, image, cpus: settings.cpus, memory: settings.memory,
    mounts, readOnlyPaths, hostDirs, env, labels: {}, wiki, wikiBuild,
  };
  plan.labels = { "pi.sandbox": "1", "pi.sandbox.root": root, "pi.sandbox.config": configHash(plan) };
  return plan;
}

export function configHash(plan: Omit<Plan, "labels"> | Plan) {
  const { name, image, cpus, memory, mounts, readOnlyPaths, env } = plan;
  return hash(JSON.stringify({ name, image, cpus, memory, mounts, readOnlyPaths, env }), 16);
}

export function runArgs(plan: Plan): string[] {
  return [
    "run", "--detach", "--rm", "--init", "--name", plan.name,
    "--cpus", String(plan.cpus), "--memory", plan.memory, "--progress", "none",
    ...Object.entries(plan.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    ...plan.mounts.flatMap((m) => ["--mount", `type=bind,source=${m.source},target=${m.target}${m.readonly ? ",readonly" : ""}`]),
    ...plan.readOnlyPaths.flatMap((path) => ["--read-only-path", path]),
    ...Object.entries(plan.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    plan.image, "sleep", "infinity",
  ];
}

// The model sees host paths unchanged, so it only needs to know what exists.
export function promptNote(plan: Plan): string {
  const shown = plan.mounts.filter((m) => m.target === m.source && m.label !== "context");
  const lines = shown.map((m) => `- ${m.target} (${m.label}${m.readonly ? ", read-only" : ""})`);
  return [
    "Your tools (read, write, edit, bash, grep, find, ls) run in a Debian Linux arm64 container, not on the macOS host. Host paths keep their locations; only these are available:",
    ...lines,
    "Skills, Pi documentation, and Git configuration are readable. Other host paths, credentials, and the SSH agent are not. Install project toolchains with `mise install`; node_modules, target, and .venv are Linux-only per worktree.",
    "Commits are created on the host: stage changes with `git add`, then call git_commit. Git config and hooks are read-only here.",
  ].join("\n");
}
