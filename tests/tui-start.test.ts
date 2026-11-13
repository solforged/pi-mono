import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { noModel, root, temporary } from "./helpers.ts";

// Print-mode smokes never draw a frame, so a footer, widget or editor that
// throws while rendering passes them and then crashes every interactive start.
// BSD `script` supplies the terminal. It accepts only a pipe or a terminal as
// stdin, so keys go into a FIFO that `cat` pipes on.
test("interactive Pi draws its first frames with the extensions loaded", { skip: process.platform !== "darwin" && "needs BSD script" }, async (t) => {
  if (spawnSync("pi", ["--version"]).error) return t.skip("Pi is not installed");
  const dir = await temporary(t);
  const keysFile = join(dir, "keys");
  execFileSync("mkfifo", [keysFile]);
  // herdr-title is left out: it runs a pane manager's CLI at start.
  const extensions = readdirSync(join(root, "extensions")).filter((name) => name !== "herdr-title" && existsSync(join(root, "extensions", name, "index.ts")))
    .flatMap((name) => ["-e", join(root, "extensions", name, "index.ts")]);
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color", PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SANDBOX: "off", KEYS: keysFile };
  for (const key of Object.keys(env)) if (/^(REX_|HERDR_|PI_REX_|PI_WORKFLOW_|PI_SANDBOX_FROM$)/.test(key)) delete env[key];
  const args = ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", ...extensions, ...noModel];
  const child = spawn("sh", ["-c", `cat "$KEYS" | script -q /dev/null sh -c 'stty rows 40 cols 140; exec "$@"' sh pi "$@"`, "sh", ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const keys = createWriteStream(keysFile);
  keys.on("error", () => {});
  let output = "";
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  // Ending `script` hangs up the terminal, which ends a Pi that did not quit.
  t.after(() => { keys.destroy(); try { process.kill(-child.pid!, "SIGKILL"); } catch {} });
  const drawn = new Promise<void>((resolve) => {
    const read = (chunk: Buffer) => {
      output += chunk;
      // The status line's model segment; Pi's own footer shows the model's ID instead.
      if (/No model · |To report this crash/.test(plain(output))) resolve();
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    void exited.then(() => resolve());
  });
  await Promise.race([drawn, new Promise((resolve) => setTimeout(resolve, 40_000).unref())]);
  // One more frame, so a widget that draws after the footer has its turn.
  await new Promise((resolve) => setTimeout(resolve, 500));
  // ctrl+d on an empty editor quits; repeated, because a key sent while Pi is still setting up is lost.
  const quit = setInterval(() => keys.write("\x04"), 500);
  const status = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 15_000).unref())]);
  clearInterval(quit);
  const text = plain(output);
  assert.doesNotMatch(text, /To report this crash|TypeError|ReferenceError/, text.slice(-3000));
  assert.match(text, /No model · /, text.slice(-3000));
  assert.equal(status, 0, text.slice(-3000));
});

const plain = (text: string) => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?<>=]*[A-Za-z~]/g, "");
