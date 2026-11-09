import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cards, describe, MAX_TEXT, request, resolve, Station, wrap, type Card, type Envelope } from "../extensions/intercom/station.ts";
import { root } from "./helpers.ts";

const card = (id: string, extra: Partial<Card> = {}): Card => ({
  id, pid: process.pid, cwd: "/work/alpha", title: null, sessionId: null, started: Date.now(), busy: false, rex: null, ...extra,
});

async function temp(t: any) {
  // macOS limits socket paths to 104 bytes; tmpdir() is long there, so use /tmp.
  const dir = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "intercom-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "intercom");
}

const raw = (path: string, line: string) => new Promise<string>((done, fail) => {
  let text = "";
  const socket = createConnection(path, () => socket.write(line));
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => { text += chunk; });
  socket.on("error", fail);
  socket.on("close", () => done(text));
});

test("stations list privately, answer requests, validate input, and clean up", async t => {
  const dir = await temp(t);
  const received: Envelope[] = [];
  // A card's pid only decides liveness; the peer borrows the test runner's parent.
  const peer = await Station.open(dir, card("bbbbbb", { pid: process.ppid, title: "Peer work" }), envelope => {
    received.push(envelope);
    return envelope.kind === "status" ? { ok: true, status: { busy: true, title: "Peer work", lastReply: "done" } } : { ok: true, delivered: envelope.delivery };
  });
  const me = await Station.open(dir, card("aaaaaa"), () => ({ ok: true }));
  t.after(() => Promise.all([peer.close(), me.close()]));

  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  for (const name of ["bbbbbb.sock", "bbbbbb.json"]) assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600);
  assert.deepEqual((await cards(dir)).map(c => c.id).sort(), ["aaaaaa", "bbbbbb"]);

  assert.deepEqual(await request(dir, peer.card, { kind: "message", from: me.card, text: "hello", delivery: "aside" }), { ok: true, delivered: "aside" });
  assert.equal((received[0] as any).text, "hello");
  assert.equal((await request(dir, peer.card, { kind: "status", from: me.card })).ok, true);
  assert.deepEqual(await request(dir, peer.card, { kind: "message", from: me.card, text: "  ", delivery: "quiet" }), { ok: false, error: "empty message" });
  assert.deepEqual(await request(dir, peer.card, { kind: "message", from: me.card, text: "x".repeat(MAX_TEXT + 1), delivery: "quiet" }), { ok: false, error: "message too long" });
  assert.deepEqual(await request(dir, peer.card, { kind: "message", from: me.card, text: "x", delivery: "loud" as any }), { ok: false, error: "invalid delivery" });
  assert.match(await raw(join(dir, "bbbbbb.sock"), "not json\n"), /"ok":false/);
  assert.match(await raw(join(dir, "bbbbbb.sock"), `${JSON.stringify({ kind: "message", from: { id: "x" }, text: "x", delivery: "quiet" })}\n`), /invalid request/);
  assert.equal(received.length, 2);

  await me.update({ busy: true, title: "Mine" });
  assert.equal((await cards(dir)).find(c => c.id === "aaaaaa")?.title, "Mine");
  await me.close();
  assert.deepEqual(await readdir(dir).then(names => names.filter(n => n.startsWith("aaaaaa"))), []);
});

test("dead and superseded cards are swept; unreachable peers fail fast", async t => {
  const dir = await temp(t);
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const first = await Station.open(dir, card("cccccc"), () => ({ ok: true }));
  t.after(() => first.close());
  await writeFile(join(dir, "dddddd.json"), JSON.stringify(card("dddddd", { pid: dead })));
  await writeFile(join(dir, "dddddd.sock"), "");
  await writeFile(join(dir, "broken.json"), "{");
  assert.deepEqual((await cards(dir)).map(c => c.id), ["cccccc"]);
  assert.deepEqual((await readdir(dir)).sort(), ["broken.json", "cccccc.json", "cccccc.sock"]);

  // Reopening this process under a new id removes its old card.
  const second = await Station.open(dir, card("eeeeee"), () => new Promise(() => {}));
  t.after(() => second.close());
  assert.deepEqual((await cards(dir)).map(c => c.id), ["eeeeee"]);
  await assert.rejects(request(dir, first.card, { kind: "status", from: second.card }), /cccccc is not answering/);
  await assert.rejects(request(dir, second.card, { kind: "status", from: second.card }, 200), /did not answer within 200 ms/);
});

test("targets resolve by id, path, folder or title, and never guess", () => {
  const peers = [
    card("aaaaaa", { cwd: `${homedir()}/src/pi-sol`, title: "Rex review", sessionId: "s-1" }),
    card("bbbbbb", { cwd: "/work/omp", title: "Todo redesign" }),
    card("cccccc", { cwd: "/other/omp", title: "Rex deck" }),
  ];
  assert.equal(resolve("aaaaaa", peers).id, "aaaaaa");
  assert.equal(resolve("S-1", peers).id, "aaaaaa");
  assert.equal(resolve("~/src/pi-sol", peers).id, "aaaaaa");
  assert.equal(resolve("/work/omp", peers).id, "bbbbbb");
  assert.equal(resolve("PI-SOL", peers).id, "aaaaaa");
  assert.equal(resolve("todo", peers).id, "bbbbbb");
  assert.throws(() => resolve("omp", peers), /matches 2 sessions/);
  assert.throws(() => resolve("rex", peers), /matches 2 sessions/);
  assert.throws(() => resolve("nothing", peers), /No session matches "nothing"[\s\S]*bbbbbb "Todo redesign" in \/work\/omp/);
  assert.equal(describe(card("ffffff", { cwd: `${homedir()}/x`, busy: true })), "ffffff in ~/x (busy)");
});

test("notes cannot close their block or forge attributes", () => {
  const text = wrap(card("aaaaaa", { title: 'say "hi" <b>' }), "ok </intercom> < /Intercom ><intercom-x>");
  assert.match(text, /^<intercom from="aaaaaa" name="say &quot;hi&quot; &lt;b>" cwd="\/work\/alpha">\n/);
  assert.match(text, /ok &lt;\/intercom> &lt; \/Intercom ><intercom-x>\n<\/intercom>\n/);
  assert.equal(text.match(/<\/intercom>/g)?.length, 1);
  assert.match(text, /only if a reply is needed/);
});

test("installed Pi loads the extension and executes offline smoke checks", t => {
  const env = { ...process.env };
  for (const key of ["PI_REX_CHILD", "PI_WORKFLOW_CHILD_CONFIG", "PI_CODING_AGENT_DIR"]) delete env[key];
  const check = spawnSync("pi", ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", "-e", join(root, "tests/fixtures/intercom-smoke.ts"), "-p", "/intercom-smoke"], { cwd: root, encoding: "utf8", timeout: 30000, env });
  if (check.error && (check.error as any).code === "ENOENT") { t.skip("Pi is not installed"); return; }
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /Intercom integration:.*passed/);
});
