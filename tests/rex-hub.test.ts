import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { root } from "./helpers.ts";

test("the hub fits Pi's native frame, preserves its editor cursor and uses transient hints", t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rex-hub-check-"));
  try {
    const check = spawnSync("pi", ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session",
      "-e", join(root, "tests/fixtures/rex-hub-check.ts"), "-p", "/rex-hub-check"], {
      cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, PI_CODING_AGENT_DIR: dir },
    });
    if (check.error && (check.error as any).code === "ENOENT") { t.skip("Pi is not installed"); return; }
    assert.equal(check.status, 0, check.stderr || check.stdout);
    assert.match(check.stdout, /Rex hub: \d+ native layout checks and the transient editor hint passed/, check.stderr || check.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
