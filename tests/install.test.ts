import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");
const script = join(repo, "scripts", "install.ts");

async function install(agentDir: string, ...args: string[]) {
  try {
    const { stdout } = await run(process.execPath, [script, ...args], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
    return { code: 0, stdout };
  } catch (error: any) {
    return { code: error.code as number, stdout: error.stdout as string };
  }
}

async function extensionNames() {
  const names = [];
  for (const entry of await readdir(join(repo, "extensions"), { withFileTypes: true })) {
    if (entry.isDirectory() && (await lstat(join(repo, "extensions", entry.name, "index.ts")).catch(() => null))) names.push(entry.name);
  }
  return names.sort();
}

test("install links every extension and roles.json idempotently", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-sol-install-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const real = await realpath(repo);

  const first = await install(agentDir);
  assert.equal(first.code, 0, first.stdout);
  const defaults = (await extensionNames()).filter((name) => name !== "herdr-title");
  assert.deepEqual((await readdir(join(agentDir, "extensions"))).sort(), defaults);
  assert.match(first.stdout, /skip \(opt-in\)\s+\S+herdr-title/);
  assert.equal(await readlink(join(agentDir, "extensions", "workflows")), join(real, "extensions", "workflows"));
  assert.equal(await readlink(join(agentDir, "roles.json")), join(real, "roles.json"));

  const second = await install(agentDir);
  assert.equal(second.code, 0);
  assert.doesNotMatch(second.stdout, /^link/m);
});

test("install links opt-in extensions only with --with and keeps them after", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-sol-install-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const target = join(agentDir, "extensions", "herdr-title");

  assert.equal((await install(agentDir, "--with", "herdr-title")).code, 0);
  assert.ok((await lstat(target)).isSymbolicLink());
  const rerun = await install(agentDir);
  assert.equal(rerun.code, 0);
  assert.match(rerun.stdout, /^ok\s+\S+herdr-title/m);
  assert.ok((await lstat(target)).isSymbolicLink());

  assert.equal((await install(agentDir, "--with=workflows")).code, 2);
});

test("install leaves foreign paths alone and removes stale links", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-sol-install-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const real = await realpath(repo);
  await mkdir(join(agentDir, "extensions"));
  await writeFile(join(agentDir, "roles.json"), "{}");
  await symlink(join(real, "extensions", "removed-extension"), join(agentDir, "extensions", "removed-extension"));
  await symlink("/nonexistent/elsewhere", join(agentDir, "extensions", "unrelated"));

  const dry = await install(agentDir, "--dry-run");
  assert.equal(dry.code, 1);
  assert.match(dry.stdout, /would remove stale/);
  assert.deepEqual((await readdir(join(agentDir, "extensions"))).sort(), ["removed-extension", "unrelated"]);

  const result = await install(agentDir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /review\s+\S+roles\.json\s+\(not a symlink\)/);
  assert.ok((await lstat(join(agentDir, "roles.json"))).isFile());
  const names = await readdir(join(agentDir, "extensions"));
  assert.ok(!names.includes("removed-extension"));
  assert.ok(names.includes("unrelated"), "links outside the checkout are not touched");
});

test("install keeps links to external extension variants without failing", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-sol-install-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const variant = join(agentDir, "variant", "sandbox");
  await mkdir(variant, { recursive: true });
  await writeFile(join(variant, "index.ts"), "export default () => {};\n");
  await mkdir(join(agentDir, "extensions"));
  await symlink(variant, join(agentDir, "extensions", "sandbox"));

  const result = await install(agentDir);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /^external\s+\S+sandbox\s+\(kept; points to /m);
  assert.equal(await readlink(join(agentDir, "extensions", "sandbox")), variant);

  // A link to a directory without an entry point is still a conflict.
  await rm(join(variant, "index.ts"));
  const broken = await install(agentDir);
  assert.equal(broken.code, 1);
  assert.match(broken.stdout, /^review\s+\S+sandbox/m);
});

test("install rejects unknown options", async () => {
  const result = await install(join(tmpdir(), "pi-sol-unused"), "--force");
  assert.equal(result.code, 2);
});
