import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { print, report } from "../extensions/shared/context.ts";
import { atomicWrite, atomicWriteSync } from "../extensions/shared/system.ts";
import { noModel, root, temporary } from "./helpers.ts";

/** Runs `fn` and returns what it wrote through console.log and console.error. */
function captured(fn: () => void) {
  const out: string[] = [], err: string[] = [], { log, error } = console;
  console.log = (text: string) => { out.push(text); };
  console.error = (text: string) => { err.push(text); };
  try { fn(); } finally { console.log = log; console.error = error; }
  return { out, err };
}

test("text outside the UI stays off standard output wherever that is a protocol stream", () => {
  assert.deepEqual(captured(() => { print({ mode: "print" }, "a"); print({}, "b"); }), { out: ["a", "b"], err: [] });
  assert.deepEqual(captured(() => { print({ mode: "json" }, "a"); print({ mode: "rpc" }, "b"); }), { out: [], err: ["a", "b"] });
});

test("a report is a notification where there is a UI and printed text otherwise", () => {
  const notes: unknown[][] = [];
  const ui = { notify: (...args: unknown[]) => { notes.push(args); } };
  const shown = captured(() => { report({ hasUI: true, mode: "rpc", ui }, "saved"); report({ hasUI: true, mode: "tui", ui }, "failed", "error"); });
  assert.deepEqual([notes, shown], [[["saved", "info"], ["failed", "error"]], { out: [], err: [] }]);
  assert.deepEqual(captured(() => report({ hasUI: false, mode: "print", ui }, "saved", "error")), { out: ["saved"], err: [] });
  assert.deepEqual(captured(() => report({ hasUI: false, mode: "json", ui }, "saved")), { out: [], err: ["saved"] });
  assert.equal(notes.length, 2);
});

test("atomic writes replace a file privately and leave no temporary file, even when they fail", async (t) => {
  const dir = await temporary(t), file = join(dir, "state.json");
  writeFileSync(file, "old", { mode: 0o644 });
  await atomicWrite(file, "first");
  assert.deepEqual([readFileSync(file, "utf8"), statSync(file).mode & 0o777], ["first", 0o600]);
  atomicWriteSync(file, "second");
  assert.deepEqual([readFileSync(file, "utf8"), statSync(file).mode & 0o777], ["second", 0o600]);
  // One process writing one file many times at once: a temporary file named by PID would be shared.
  await Promise.all(Array.from({ length: 20 }, (_, i) => atomicWrite(file, `write ${i}`)));
  assert.match(readFileSync(file, "utf8"), /^write \d+$/);
  // A folder cannot be replaced by a file, and a missing folder is not made.
  mkdirSync(join(dir, "taken", "inside"), { recursive: true });
  await assert.rejects(atomicWrite(join(dir, "taken"), "text"));
  assert.throws(() => atomicWriteSync(join(dir, "taken"), "text"));
  await assert.rejects(atomicWrite(join(dir, "missing", "file"), "text"), { code: "ENOENT" });
  assert.throws(() => atomicWriteSync(join(dir, "missing", "file"), "text"), { code: "ENOENT" });
  assert.deepEqual(readdirSync(dir).sort(), ["state.json", "taken"]);
});

test("commands run by Pi in JSON mode leave standard output as JSON lines", async (t) => {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: join(await temporary(t), "agent") };
  for (const key of ["PI_REX_CHILD", "PI_WORKFLOW_CHILD_CONFIG", "REX_SESSION", "REX_BLOCK"]) delete env[key];
  // artifacts and sessions used to say nothing in this mode; prompt-size wrote its text into the event stream.
  const commands = { "prompt-size": "/prompt-size", artifacts: "/artifacts check", sessions: "/sessions check" };
  const extensions = Object.keys(commands).flatMap((name) => ["-e", join(root, "extensions", name, "index.ts")]);
  const check = spawnSync("pi", ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", ...extensions, ...noModel, "--mode", "json", "-p", ...Object.values(commands)],
    { cwd: root, encoding: "utf8", timeout: 30000, env, stdio: ["ignore", "pipe", "pipe"] });
  if (check.error && (check.error as any).code === "ENOENT") { t.skip("Pi is not installed"); return; }
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const lines = check.stdout.split("\n").filter(Boolean);
  assert.ok(lines.length > 0);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), `not JSON: ${line.slice(0, 200)}`);
  for (const text of [/^Fixed prompt: /m, /^Output artifacts: on/m, /^Session search: local/m]) assert.match(check.stderr, text);
});
