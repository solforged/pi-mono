// Builds Pi Open.app, the macOS handler for pi-open:// links, from open.sh and
// open.applescript beside this file, and registers it with Launch Services.
// Run by `pm-install`; rebuilds only when the sources change.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SOURCES = ["open.sh", "open.applescript"].map((name) => join(import.meta.dirname, name));
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const ID = "dev.pi.open";

/** A digest of the sources, kept in the app to tell whether it is current. */
export function sourceDigest(): string {
  const hash = createHash("sha256");
  for (const file of SOURCES) hash.update(readFileSync(file));
  return hash.digest("hex").slice(0, 16);
}

export type HandlerStatus = "ok" | "build" | "skip";

/** Builds the app at `app` unless it is current; `dryRun` only reports. */
export function buildHandler(app: string, dryRun = false): HandlerStatus {
  if (process.platform !== "darwin") return "skip";
  const digest = sourceDigest();
  const stamp = join(app, "Contents", "Resources", "source-digest");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === digest) return "ok";
  if (dryRun) return "build";
  mkdirSync(dirname(app), { recursive: true });
  const temporary = `${app}.${process.pid}.tmp.app`;
  rmSync(temporary, { recursive: true, force: true });
  const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  run("osacompile", ["-o", temporary, SOURCES[1]]);
  const plist = join(temporary, "Contents", "Info.plist");
  const buddy = (command: string) => run("/usr/libexec/PlistBuddy", ["-c", command, plist]);
  try { buddy(`Set :CFBundleIdentifier ${ID}`); } catch { buddy(`Add :CFBundleIdentifier string ${ID}`); }
  try { buddy("Set :CFBundleName Pi Open"); } catch { buddy("Add :CFBundleName string Pi Open"); }
  buddy("Add :LSUIElement bool true");
  buddy("Add :CFBundleURLTypes array");
  buddy("Add :CFBundleURLTypes:0 dict");
  buddy(`Add :CFBundleURLTypes:0:CFBundleURLName string ${ID}`);
  buddy("Add :CFBundleURLTypes:0:CFBundleURLSchemes array");
  buddy("Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string pi-open");
  copyFileSync(SOURCES[0], join(temporary, "Contents", "Resources", "open.sh"));
  writeFileSync(join(temporary, "Contents", "Resources", "source-digest"), `${digest}\n`);
  // Editing the bundle breaks osacompile's ad hoc signature; sign it again.
  run("codesign", ["--force", "--sign", "-", temporary]);
  if (existsSync(app)) {
    try { run(LSREGISTER, ["-u", app]); } catch {}
    rmSync(app, { recursive: true, force: true });
  }
  renameSync(temporary, app);
  run(LSREGISTER, ["-f", app]);
  return "build";
}
