// Links every extension directory with an index.ts, plus roles.json, into the
// Pi agent directory. Safe to rerun: correct links are kept, foreign paths are
// reported and left alone, and dangling links into this checkout are removed.
// A symlink to another extension directory (one with an index.ts), such as a
// machine-specific variant from a different checkout, is kept without failing.
// Opt-in extensions are linked only when named with --with.
import { lstat, mkdir, readdir, readlink, realpath, rm, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const OPT_IN = new Set(["herdr-title"]);

const usage = `Usage: mise run install -- [--dry-run] [--with <${[...OPT_IN].join("|")}>]...`;
const fail = (message: string): never => {
  console.error(`${message}\n${usage}`);
  process.exit(2);
};
let dryRun = false;
const requested = new Set<string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--with" || arg.startsWith("--with=")) {
    const name = arg === "--with" ? argv[++i] : arg.slice("--with=".length);
    if (!name || !OPT_IN.has(name)) fail(`Not an opt-in extension: ${name ?? "(missing)"}`);
    requested.add(name);
  } else fail(`Unknown option: ${arg}`);
}

const repo = await realpath(resolve(import.meta.dirname, ".."));
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
const extensionsDir = join(agentDir, "extensions");

const exists = (path: string) => stat(path).then(() => true, () => false);
const lexists = (path: string) => lstat(path).then(() => true, () => false);

const resources: Array<{ source: string; target: string; optional: boolean }> = [];
for (const entry of (await readdir(join(repo, "extensions"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  if (entry.isDirectory() && (await exists(join(repo, "extensions", entry.name, "index.ts")))) {
    const optional = OPT_IN.has(entry.name) && !requested.has(entry.name);
    resources.push({ source: join(repo, "extensions", entry.name), target: join(extensionsDir, entry.name), optional });
  }
}
resources.push({ source: join(repo, "roles.json"), target: join(agentDir, "roles.json"), optional: false });

let conflicts = 0;
const prefix = dryRun ? "would " : "";
const report = (status: string, target: string, detail = "") =>
  console.log(`${status.padEnd(16)} ${target}${detail ? `  (${detail})` : ""}`);

if (!dryRun) await mkdir(extensionsDir, { recursive: true });

for (const { source, target, optional } of resources) {
  if (optional) {
    // Never link by default; an existing link is the user's choice and is kept.
    const linked = (await realpath(target).catch(() => undefined)) === source;
    report(linked ? "ok" : "skip (opt-in)", target, linked ? "" : "add with --with");
    continue;
  }
  if (!(await lexists(target))) {
    if (!dryRun) await symlink(source, target);
    report(`${prefix}link`, target);
    continue;
  }
  const resolved = await realpath(target).catch(() => undefined);
  const isLink = (await lstat(target)).isSymbolicLink();
  if (resolved === source) {
    report("ok", target);
  } else if (isLink && resolved && target.startsWith(extensionsDir + "/") && (await exists(join(resolved, "index.ts")))) {
    report("external", target, `kept; points to ${await readlink(target)}`);
  } else {
    conflicts++;
    report("review", target, isLink ? `points to ${await readlink(target)}` : "not a symlink");
  }
}

// Remove dangling links into this checkout, e.g. after an extension is renamed.
if (await exists(extensionsDir)) {
  for (const name of await readdir(extensionsDir)) {
    const target = join(extensionsDir, name);
    if (!(await lstat(target)).isSymbolicLink()) continue;
    const pointer = resolve(dirname(target), await readlink(target));
    if (pointer.startsWith(join(repo, "extensions") + "/") && !(await exists(pointer))) {
      if (!dryRun) await rm(target);
      report(`${prefix}remove stale`, target);
    }
  }
}

if (conflicts) {
  console.log(`\n${conflicts} existing path(s) left untouched; review them, then rerun.`);
  process.exitCode = 1;
} else if (!dryRun) {
  console.log("\nRun /reload in Pi or start a new session.");
}
