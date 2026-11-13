import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../extensions/workflows/roles.ts";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const base = JSON.parse(await readFile(join(root, "roles.json"), "utf8"));
export const config = resolveConfig(base, {}, "personal");
/** Pi arguments for smoke runs: any prompt that reaches a model fails instead of calling the default one. */
export const noModel = ["-e", join(root, "tests/fixtures/no-model.ts"), "--provider", "no-model", "--model", "no-model/none"];
export async function temporary(t: { after: (fn: () => Promise<unknown>) => unknown }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-workflows-test-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
export function registry(complete?: (...args: any[]) => Promise<any>) {
  return {
    find: (provider: string, id: string) => ({ provider, id, maxTokens: 8192 }),
    hasConfiguredAuth: () => true,
    complete: complete ?? (async () => { throw new Error("Unexpected model call"); }),
  };
}
export const skill = (name = "test-skill", body = "Run a repeatable check. Verify its output.") => `---\nname: ${name}\ndescription: "A reusable testing procedure"\n---\n\n# Test procedure\n\n${body}\n`;
