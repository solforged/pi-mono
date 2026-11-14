// Explicit live test of the agent hub: a real parent Pi, a peer Pi and two real
// children in a background Rex window, driven with keystrokes. A fixed-response
// provider in an isolated agent directory: no credentials or model requests.
// Run from Rex: node tests/fixtures/rex-hub-smoke.ts [--open] [--keep]
// --open also checks → (zoom into a child) and ← back. It briefly switches the
//   Rex app to the test window, then back to the window that was active.
// --keep leaves the test window and files for inspection.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RexClient } from "../../extensions/rex/client.ts";
import { atomicWrite } from "../../extensions/shared/system.ts";
import { privateDir, scopeRoot } from "../../extensions/workflows/state.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const session = process.env.REX_SESSION, me = process.env.REX_BLOCK;
if (!session || !me) throw new Error("Run this test from a Rex terminal");
const open = process.argv.includes("--open"), keep = process.argv.includes("--keep");
const rex = new RexClient(); await rex.probe(session, me);
const dir = await realpath(await mkdtemp("/tmp/pi-rex-hub-smoke-")), agentDir = join(dir, "agent");
await privateDir(agentDir);
const role = { provider: "rex-smoke", model: "fixture", thinking: "off", maxTokens: 512, timeoutMs: 300_000 };
const provider = resolve(root, "tests/fixtures/rex-hub-provider.ts");
await atomicWrite(join(agentDir, "roles.json"), JSON.stringify({ version: 1,
  profiles: { personal: { autoname: false, roles: { advisor: role, task: role } } },
  subagents: { concurrency: 2, maxTasks: 4, maxTurns: 4, outputBytes: 4096, sandbox: "inherit", childExtensions: [provider] },
  learning: { maxInputChars: 8000, maxChunks: 1, maxCandidates: 1, auto: { enabled: false, minSessions: 2, maxSkills: 0 } } }));
const pi = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const command = ["/usr/bin/env", `PATH=${process.env.PATH}`, `PI_CODING_AGENT_DIR=${agentDir}`, pi, "--offline",
  "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes",
  "-e", provider, "-e", resolve(root, "extensions/rex/index.ts"), "-e", resolve(root, "extensions/intercom/index.ts"),
  "--provider", "rex-smoke", "--model", "rex-smoke/fixture"];

const api = (method: string, args: object) => JSON.parse(execFileSync("rex", ["--autostart=false", "api", "call", "--session", session, method, JSON.stringify({ session_id: session, ...args })], { encoding: "utf8" }));
const type = async (block: string, data: string) => { api("block.method", { block_id: block, method: "write", args: { data } }); await sleep(350); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const screen = (block: string) => rex.tail(session, block, 12_000);
async function until(block: string, test: (text: string) => boolean, what: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let text = "";
  while (Date.now() < deadline) { text = await screen(block); if (test(text)) return text; await sleep(250); }
  throw new Error(`Timed out waiting for ${what}. Screen:\n${text.split("\n").slice(-40).join("\n")}`);
}
const show = (label: string, text: string, from: string) => {
  const lines = text.split("\n"), at = lines.findLastIndex(l => l.includes(from));
  console.log(`\n── ${label}\n${lines.slice(at < 0 ? -20 : at).join("\n")}`);
};
const stateDir = join(await scopeRoot(agentDir, "personal", process.cwd()), "rex");
// Read this fixture's records, not display labels (which can carry a colour mark).
async function childRuns() {
  const dirs = await readdir(stateDir, { withFileTypes: true }).catch(() => []);
  const runs = await Promise.all(dirs.filter(d => d.isDirectory()).map(async d => {
    try { return JSON.parse(await readFile(join(stateDir, d.name, "run.json"), "utf8")); } catch { return undefined; }
  }));
  return runs.filter(r => r?.rexSession === session && r.parentBlock === created[0]);
}

const activeWindow = api("session.view", {}).active_window_id as string;
const created: string[] = [], existing = new Set(api("session.list_blocks", {}).blocks.map((b: any) => b.block_id));
let failed = false;
try {
  const { blockId: parent } = await rex.newWindow(session, "hub smoke", "hub parent", command, process.cwd());
  created.push(parent);
  const peer = await rex.create(session, "hub peer", command, process.cwd()); created.push(peer);
  // An unviewed window keeps 80×24; size the parent like a real pane, then check a small one at the end.
  const resize = (columns: number, rows: number) => api("block.method", { block_id: parent, method: "resize", args: { columns, rows } });
  resize(120, 40);
  await until(parent, t => t.includes("fixture"), "the parent prompt", 30_000);
  await until(peer, t => t.includes("fixture"), "the peer prompt", 30_000);

  await type(parent, "Spawn hub fixture\r");
  await until(parent, t => /● birch/.test(t) && /✓ cedar/.test(t) && t.includes("← open"), "one running and one finished child", 60_000);
  // A session without children does not carry rex_send and rex_result; the first child declares them.
  await until(parent, t => t.replace(/\s+/g, " ").includes("Rex tools before: rex_agent; after: rex_agent,rex_result,rex_send."), "the follow-up tools declared after the first child");
  const runs = await childRuns();
  const birch = runs.find(r => r.name === "birch")?.block, cedar = runs.find(r => r.name === "cedar")?.block;
  assert(birch && cedar); created.push(birch, cedar);
  await until(birch, t => t.includes("← on an empty prompt returns to it"), "the child header");
  await until(parent, () => {
    const grid = api("session.view", {}).windows.find((w: any) => w.layers.some((l: any) => l.blocks.some((b: any) => b.block_id === birch)));
    return grid?.label === "Agents · 2";
  }, "the compact Agents tab label");

  await sleep(1200); // ← right after the prompt was emptied only arms.
  await type(parent, "\x1b[D");
  let text = await until(parent, t => t.includes("Agents ·") && t.includes("Other Pi sessions"), "the hub");
  assert.match(text, /Working[\s\S]*birch[\s\S]*Done[\s\S]*cedar[\s\S]*Other Pi sessions[\s\S]*◇/);
  show("hub", text, "Agents ·");

  await type(parent, " ");
  text = await until(parent, t => t.includes("Task: Hold fixture") && /│ .*(Working|Task for birch)/.test(t), "birch's live screen in the peek");
  show("peek: running child", text, "Agents ·");
  await type(parent, "\x1b[B");
  text = await until(parent, t => t.includes("Fixture result"), "cedar's result in the peek");
  show("peek: finished child", text, "Agents ·");
  await type(parent, "\x1b[B");
  text = await until(parent, t => /│ /.test(t) && t.includes("pid "), "the peer's screen in the peek");
  assert.match(text, /Another session: → opens its pane/);
  await type(parent, "x");
  await until(parent, t => /Another session: → opens its pane/.test(t) && !t.includes("New task for"), "typing for a peer is refused, not hidden");
  await type(parent, "\x1b[A"); await type(parent, "\x1b[A");

  await type(parent, "keep going please");
  await until(parent, t => t.includes("Steer birch's task"), "the steer label");
  await type(parent, "\x1b[B"); // While drafting, ↓ stays in the draft: the recipient cannot change.
  await until(parent, t => t.includes("Steer birch's task") && /→ ● birch/.test(t), "the draft to keep its recipient");
  await type(parent, "\r");
  text = await until(parent, t => t.includes("Sent to birch"), "the steer receipt");
  // The child acknowledged it; it shows there at the child's next step, which a held fixture never reaches.
  await type(parent, "\x14");
  await until(parent, t => t.includes("birch pinned to the deck"), "pinning");

  if (open) {
    const before = api("session.view", {});
    await type(parent, "\x1b[C");
    await until(parent, t => t.includes("Opened birch"), "opening");
    let view = api("session.view", {});
    const win = view.windows.find((w: any) => w.focused_block_id === birch);
    assert(win, "birch has focus in its window");
    await type(birch, "\x1b[D");
    await sleep(1000);
    view = api("session.view", {});
    assert(view.windows.some((w: any) => w.focused_block_id === parent), "← in the child focuses the parent");
    assert(!view.windows.some((w: any) => w.layers.some((l: any) => l.kind === "floating" && l.blocks.some((b: any) => b.block_id === birch))), "no float left behind");
    text = await screen(parent); assert(text.includes("Agents ·"), "the hub is still open on return");
    // A detached child floats over the parent to open, and ← detaches only that float.
    await type(parent, "\x10");
    await until(parent, t => t.includes("birch parked"), "parking");
    await sleep(800);
    assert.equal(api("session.list_blocks", {}).blocks.find((b: any) => b.block_id === birch).placement, "detached");
    await type(parent, "\x1b[C");
    await until(parent, t => t.includes("Opened birch"), "opening a detached child");
    view = api("session.view", {});
    assert(view.windows.some((w: any) => w.layers.some((l: any) => l.kind === "floating" && l.blocks.some((b: any) => b.block_id === birch))), "floated over the parent");
    assert(view.windows.some((w: any) => w.focused_block_id === birch), "and focused");
    await type(birch, "\x1b[D");
    await sleep(1000);
    view = api("session.view", {});
    assert(view.windows.some((w: any) => w.focused_block_id === parent), "← focuses the parent");
    assert.equal(api("session.list_blocks", {}).blocks.find((b: any) => b.block_id === birch).placement, "detached", "the hub's float is undone");
    // Give the user back the window they were looking at.
    api("session.focus_window", { window_id: before.active_window_id });
    assert.equal(api("session.view", {}).active_window_id, before.active_window_id);
  }

  // In a small pane, peek and help together still leave the controls on screen.
  resize(80, 24); await sleep(800);
  text = await until(parent, t => t.includes("Task: Hold fixture") && t.includes("← back"), "the peek in a small pane, controls still on screen");
  show("small pane: peek", text, "Agents ·");
  await type(parent, "?");
  text = await until(parent, t => t.includes("back to the prompt") && t.includes("? close keys"), "the whole key list in a small pane");
  show("small pane: keys", text, "Agents ·");
  await type(parent, "?"); resize(120, 40); await sleep(500);

  await type(parent, "\x18");
  await until(parent, t => t.includes("Press ctrl+x again to cancel birch's task"), "the stop confirmation");
  await type(parent, "\x18");
  await until(parent, t => t.includes("Cancelled birch's task"), "cancelling", 30_000);
  await type(parent, "\x1b"); await type(parent, "\x1b"); await type(parent, "\x1b");
  await until(parent, t => !t.includes("Other Pi sessions") || t.lastIndexOf("Other Pi sessions") < t.lastIndexOf("Rex 2"), "the hub to close");
  console.log("\nRex hub smoke passed");
} catch (error) { failed = true; throw error; }
finally {
  // Whatever happened, give the user back the window they were looking at.
  try { if (api("session.view", {}).active_window_id !== activeWindow) api("session.focus_window", { window_id: activeWindow }); } catch {}
  if (!keep) {
    // Children first are retired by their parent; then the deck's roster and strip panes this run created.
    const children = (await childRuns()).map(r => r.block).filter(Boolean);
    for (const block of [...new Set([...created, ...children])].reverse()) await rex.close(session, block).catch(() => {});
    await sleep(500);
    for (const b of api("session.list_blocks", {}).blocks) if (!existing.has(b.block_id) && ["agents", "not in the deck"].includes(b.label)) await rex.close(session, b.block_id).catch(() => {});
    // The Pis closing with their panes write state on the way out: remove it again after them.
    if (!failed) { await rm(dir, { recursive: true, force: true }); await sleep(1500); await rm(dir, { recursive: true, force: true }); }
    else console.log(`Kept ${dir} for diagnosis`);
  } else console.log(`Kept the test window and ${dir}`);
}
