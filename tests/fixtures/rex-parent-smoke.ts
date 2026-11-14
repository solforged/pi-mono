// Explicit live test of a real parent Pi and two real children: the Agents tab
// beside an untouched parent window, the widget, and typing into the children's
// panes. A fixed-response provider in an isolated agent directory: no
// credentials or model requests.
// Run from Rex: node tests/fixtures/rex-parent-smoke.ts [--open] [--keep]
// --open also checks ← from the parent to the child that most needs a look and
//   ← back. It switches the Rex app to the test tabs briefly, then back.
// --keep leaves the test tabs and files for inspection.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RexClient } from "../../extensions/rex/client.ts";
import { cells } from "../../extensions/rex/grid.ts";
import { atomicWrite } from "../../extensions/shared/system.ts";
import { privateDir, scopeRoot } from "../../extensions/workflows/state.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const session = process.env.REX_SESSION, me = process.env.REX_BLOCK;
if (!session || !me) throw new Error("Run this test from a Rex terminal");
const open = process.argv.includes("--open"), keep = process.argv.includes("--keep");
const rex = new RexClient(); await rex.probe(session, me);
const dir = await realpath(await mkdtemp("/tmp/pi-rex-parent-smoke-")), agentDir = join(dir, "agent");
await privateDir(agentDir);
const role = { provider: "rex-smoke", model: "fixture", thinking: "off", maxTokens: 512, timeoutMs: 300_000 };
const provider = resolve(root, "tests/fixtures/rex-parent-provider.ts");
await atomicWrite(join(agentDir, "roles.json"), JSON.stringify({ version: 1,
  profiles: { personal: { autoname: false, roles: { advisor: role, task: role } } },
  subagents: { concurrency: 2, maxTasks: 4, maxTurns: 4, outputBytes: 4096, sandbox: "inherit", childExtensions: [provider] },
  learning: { maxInputChars: 8000, maxChunks: 1, maxCandidates: 1, auto: { enabled: false, minSessions: 2, maxSkills: 0 } } }));
const pi = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const command = ["/usr/bin/env", `PATH=${process.env.PATH}`, `PI_CODING_AGENT_DIR=${agentDir}`, pi, "--offline",
  "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes",
  "-e", provider, "-e", resolve(root, "extensions/rex/index.ts"), "--provider", "rex-smoke", "--model", "rex-smoke/fixture"];

const api = (method: string, args: object) => JSON.parse(execFileSync("rex", ["--autostart=false", "api", "call", "--session", session, method, JSON.stringify({ session_id: session, ...args })], { encoding: "utf8" }));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const type = async (block: string, data: string) => { api("block.method", { block_id: block, method: "write", args: { data } }); await sleep(350); };
const screen = (block: string) => execFileSync("rex", ["--autostart=false", "capture", "-s", session, "-b", block, "--trim"], { encoding: "utf8" });
async function until(block: string, test: (text: string) => boolean, what: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let text = "";
  while (Date.now() < deadline) { text = screen(block); if (test(text)) return text; await sleep(250); }
  throw new Error(`Timed out waiting for ${what}. Screen:\n${text.split("\n").slice(-40).join("\n")}`);
}
const stateDir = join(await scopeRoot(agentDir, "personal", process.cwd()), "rex");
async function childRuns() {
  const dirs = await readdir(stateDir, { withFileTypes: true }).catch(() => []);
  const runs = await Promise.all(dirs.filter(d => d.isDirectory()).map(async d => {
    try { return JSON.parse(await readFile(join(stateDir, d.name, "run.json"), "utf8")); } catch { return undefined; }
  }));
  return runs.filter(r => r?.rexSession === session && r.parentBlock === created[0]);
}
const windowOf = (block: string) => api("session.view", {}).windows.find((w: any) => w.layers.some((l: any) => l.blocks.some((b: any) => b.block_id === block)));

const activeWindow = api("session.view", {}).active_window_id as string;
const created: string[] = [];
let failed = false;
try {
  const { blockId: parent, windowId: home } = await rex.newWindow(session, "parent smoke", "smoke parent", command, process.cwd());
  created.push(parent);
  // A second pane beside the parent, as a diff would be: it must keep its space.
  const side = await rex.create(session, "side pane", ["/bin/sleep", "900"], process.cwd());
  created.push(side); await rex.place(session, side, parent, "horizontal", 0.67);
  api("block.method", { block_id: parent, method: "resize", args: { columns: 120, rows: 40 } });
  await until(parent, t => t.includes("fixture"), "the parent prompt", 30_000);

  await type(parent, "Spawn parent fixture\r");
  const widget = await until(parent, t => /● birch/.test(t) && /✓ cedar/.test(t) && t.includes("← open"), "one running and one finished child", 60_000);
  console.log(widget.split("\n").find(l => l.includes("← open")));
  const runs = await childRuns();
  const birch = runs.find(r => r.name === "birch")?.block, cedar = runs.find(r => r.name === "cedar")?.block;
  assert(birch && cedar); created.push(birch, cedar);
  await until(birch, t => t.includes("type here to steer it or start a follow-up"), "the child header");
  await until(parent, () => windowOf(birch)?.label === "Agents · 2" && windowOf(cedar)?.window_id === windowOf(birch)?.window_id, "both children in one Agents tab");
  const tab = windowOf(birch);
  assert.notEqual(tab.window_id, home);
  assert.deepEqual(cells(windowOf(parent).layers[0].layout).map(c => c.block), [parent, side], "the parent's window is untouched");
  const order = api("session.view", {}).windows.map((w: any) => w.window_id);
  assert.equal(order[order.indexOf(home) + 1], tab.window_id, "the Agents tab follows the parent's");

  // Typing into the running child steers its task; nothing is refused.
  await type(birch, "steer from the pane\r");
  let text = await until(birch, t => t.includes("steer from the pane"), "the typed steer in birch");
  assert.doesNotMatch(text, /Managed child/);
  // Typing into the idle child starts a follow-up that the parent records and reports.
  await type(cedar, "Typed follow-up\r");
  await until(cedar, t => t.includes("▸ Task from you"), "the typed follow-up in cedar", 30_000);
  // Its receipt waits for the parent's next turn; the parent's records and notice show it now.
  await until(parent, t => t.includes("Rex: cedar succeeded"), "the parent's notice for the typed follow-up", 30_000);
  const cedarDir = runs.find(r => r.name === "cedar").dir, tasks = await readdir(join(cedarDir, "tasks"));
  const typed = (await Promise.all(tasks.map(async id => JSON.parse(await readFile(join(cedarDir, "tasks", id, "task.json"), "utf8"))))).find(t => t.from === "user");
  assert.equal(typed?.task, "Typed follow-up"); assert.equal(typed.status, "succeeded"); assert.equal(typed.background, true);

  if (open) {
    await sleep(1200); // ← right after the prompt was emptied only arms.
    await type(parent, "\x1b[D");
    // cedar has a result the parent has not read; birch is only working.
    await until(parent, () => api("session.view", {}).windows.find((w: any) => w.window_id === tab.window_id)?.focused_block_id === cedar
      && api("session.view", {}).active_window_id === tab.window_id, "← to focus cedar in the Agents tab");
    await sleep(1200);
    await type(cedar, "\x1b[D");
    await until(parent, () => api("session.view", {}).active_window_id === home
      && api("session.view", {}).windows.find((w: any) => w.window_id === home)?.focused_block_id === parent, "← in cedar to return to the parent");
  }
  console.log(`Passed: one Agents tab beside an untouched parent window, the widget, typing into a working and an idle child${open ? ", ← to the child and back" : ""}. No model requests.`);
} catch (error) {
  failed = true; throw error;
} finally {
  try { api("session.focus_window", { window_id: activeWindow }); } catch {}
  if (!keep) {
    for (const block of created.reverse()) await rex.close(session, block).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  } else console.log(`Kept for inspection: ${dir}`);
  if (failed) console.error("Smoke failed; test tabs were cleaned up unless --keep.");
}
