import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { paneTitle, REFRESH_INTERVAL_MS, registerHerdrTitle, TITLE_SOURCE, TITLE_TTL_MS } from "../extensions/herdr-title/index.ts";

const environment = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p5", HERDR_BIN_PATH: "/tools/herdr" };
type Report = Parameters<typeof registerHerdrTitle>[2];

function harness(env: NodeJS.ProcessEnv = environment, report?: Report) {
  const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
  const calls: { binary: string; pane: string; title: string | undefined; signal: AbortSignal }[] = [];
  const intervals: number[] = [];
  let stops = 0;
  let refresh: (() => void) | undefined;
  let name: string | undefined;
  const ctx = { mode: "tui", cwd: "/src/dotfiles" };
  const pi = { on: (event: string, fn: any) => { handlers[event] = fn; }, getSessionName: () => name } as any;
  registerHerdrTitle(pi, env, report ?? (async (binary, pane, title, signal) => { calls.push({ binary, pane, title, signal }); }), (callback, intervalMs) => {
    refresh = callback;
    intervals.push(intervalMs);
    return () => { stops++; };
  });
  return {
    calls, ctx, handlers, intervals,
    get stops() { return stops; },
    async emit(type: string, event = {}) { await handlers[type]?.(event, ctx); },
    async start(value?: string, reason = "startup") { name = value; await handlers.session_start?.({ reason }, ctx); },
    async title(value: string | undefined) { name = value; await handlers.session_info_changed?.({ name: value }, ctx); },
    async tick() { refresh?.(); await setImmediate(); },
    name(value: string | undefined) { name = value; },
  };
}

test("the factory does not start timers or report before a TUI session starts", async () => {
  const h = harness();
  await h.title("Too early");
  await h.emit("agent_settled");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.intervals, []);
});

test("startup, resume, fork and reload publish to the captured pane without a tab ID", async () => {
  const h = harness();
  for (const reason of ["startup", "resume", "fork", "reload"]) await h.start(`Task on ${reason}`, reason);
  assert.deepEqual(h.calls.map(({ binary, pane, title }) => [binary, pane, title]),
    ["startup", "resume", "fork", "reload"].map((reason) => ["/tools/herdr", "w1:p5", `Task on ${reason}`]));
  assert.deepEqual(h.intervals, [REFRESH_INTERVAL_MS]);
});

test("autonames and manual names publish; unnamed sessions clear instead of using cwd", async () => {
  const h = harness();
  await h.start();
  await h.title("Automatic session name");
  await h.title("My manual name");
  await h.start(undefined, "new");
  await h.title("Another task");
  await h.title(undefined);
  assert.deepEqual(h.calls.map((call) => call.title), [undefined, "Automatic session name", "My manual name", undefined, "Another task", undefined]);
});

test("unchanged event titles are skipped but heartbeat renews the latest title", async () => {
  const h = harness();
  await h.start("A task title");
  await h.title("A task title");
  await h.emit("agent_settled");
  assert.equal(h.calls.length, 1);
  await h.tick();
  await h.title("Latest title");
  await h.tick();
  assert.deepEqual(h.calls.map((call) => call.title), ["A task title", "A task title", "Latest title", "Latest title"]);
  assert.ok(REFRESH_INTERVAL_MS < TITLE_TTL_MS);
});

test("cleared titles are not repeatedly cleared by heartbeat", async () => {
  const h = harness();
  await h.start();
  await h.tick();
  await h.tick();
  assert.deepEqual(h.calls.map((call) => call.title), [undefined]);
});

test("noninteractive children never write, start heartbeat, or clear the parent's metadata", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const h = harness();
    h.ctx.mode = mode;
    await h.start("Child task");
    await h.title("Another child task");
    await h.emit("agent_settled");
    await h.emit("session_shutdown", { reason: "quit" });
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.intervals, []);
    assert.equal(h.stops, 0);
  }
});

test("missing Herdr context disables reporting; legacy tab ownership is irrelevant", async () => {
  for (const env of [{ ...environment, HERDR_ENV: "0" }, { ...environment, HERDR_PANE_ID: "" }]) {
    assert.deepEqual(harness(env).handlers, {});
  }
  const h = harness({ ...environment, HERDR_TITLE_OWNER: "off" });
  await h.start("Independent pane title");
  assert.equal(h.calls.length, 1);
});

test("quiet report failures retry on heartbeat or settled events", async () => {
  const titles: (string | undefined)[] = [];
  const h = harness(environment, async (_binary, _pane, title) => {
    titles.push(title);
    if (titles.length === 1) throw new Error("Herdr unavailable");
  });
  await h.start();
  await h.tick();
  await h.tick();
  assert.deepEqual(titles, [undefined, undefined]);
  await h.title("Retry this title");
  await h.emit("agent_settled");
  assert.deepEqual(titles, [undefined, undefined, "Retry this title"]);
});

test("an ambiguous failed update invalidates deduplication of the last applied title", async () => {
  const titles: (string | undefined)[] = [];
  const h = harness(environment, async (_binary, _pane, title) => {
    titles.push(title);
    if (title === "Failed title") throw new Error("response lost after applying title");
  });
  await h.start("First title");
  await h.title("Failed title");
  await h.title("First title");
  assert.deepEqual(titles, ["First title", "Failed title", "First title"]);
});

test("writes serialize and coalesce pending changes to the latest title", async () => {
  const titles: (string | undefined)[] = [];
  let release!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const h = harness(environment, async (_binary, _pane, title) => {
    titles.push(title);
    if (titles.length === 1) { started(); await blocked; }
  });
  const first = h.start("First title");
  await firstStarted;
  const second = h.title("Obsolete title");
  const third = h.title("Latest title");
  assert.deepEqual(titles, ["First title"]);
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(titles, ["First title", "Latest title"]);
});

test("quit and every runtime replacement stop heartbeat and clear exactly once", async () => {
  for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
    const h = harness();
    await h.start("A task title");
    await h.emit("session_shutdown", { reason });
    await h.emit("session_shutdown", { reason });
    await h.tick();
    await h.title("Ignored after shutdown");
    await h.start("Ignored restarted runtime");
    assert.deepEqual(h.calls.map((call) => call.title), ["A task title", undefined]);
    assert.equal(h.stops, 1);
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.calls[1].signal.aborted, false);
  }
});

test("shutdown aborts in-flight writes, discards pending writes, then clears with a fresh signal", async () => {
  const titles: (string | undefined)[] = [];
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const h = harness(environment, async (_binary, _pane, title, signal) => {
    titles.push(title);
    if (title === undefined) { assert.equal(signal.aborted, false); return; }
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      started();
    });
  });
  const first = h.start("First title");
  await firstStarted;
  const pending = h.title("Pending title");
  await h.emit("session_shutdown", { reason: "resume" });
  await Promise.all([first, pending]);
  assert.deepEqual(titles, ["First title", undefined]);
});

test("failed shutdown cleanup stays quiet and never restarts heartbeat", async () => {
  const h = harness(environment, async (_binary, _pane, title) => {
    if (title === undefined) throw new Error("server unavailable");
  });
  await h.start("Will expire after TTL");
  await h.emit("session_shutdown");
  await h.tick();
  assert.equal(h.stops, 1);
});

test("the subprocess runner uses guarded, expiring metadata and a source-scoped clear", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-herdr-title-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, "herdr.mjs");
  const captured = join(dir, "arguments.jsonl");
  await writeFile(binary, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)) + "\\n", { flag: "a" });\n`, { mode: 0o700 });
  const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
  const title = "--help $(touch /tmp/nope); 'quoted'";
  const pi = { on: (event: string, fn: any) => { handlers[event] = fn; }, getSessionName: () => title } as any;
  registerHerdrTitle(pi, { ...environment, HERDR_BIN_PATH: binary }, undefined, () => () => {});
  const ctx = { mode: "tui" };
  await handlers.session_start({ reason: "startup" }, ctx);
  await handlers.session_shutdown({ reason: "quit" }, ctx);
  const commands = (await readFile(captured, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const prefix = ["pane", "report-metadata", "w1:p5", "--source", TITLE_SOURCE, "--agent", "pi"];
  assert.deepEqual(commands, [
    [...prefix, "--title", title, "--ttl-ms", String(TITLE_TTL_MS)],
    [...prefix, "--clear-title"],
  ]);
});

test("the real timer starts at session_start, refreshes, and stops on shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
  const titles: (string | undefined)[] = [];
  const pi = { on: (event: string, fn: any) => { handlers[event] = fn; }, getSessionName: () => "Idle task title" } as any;
  registerHerdrTitle(pi, environment, async (_binary, _pane, title) => { titles.push(title); });
  t.mock.timers.tick(REFRESH_INTERVAL_MS);
  assert.deepEqual(titles, []);
  await handlers.session_start({}, { mode: "tui" });
  t.mock.timers.tick(REFRESH_INTERVAL_MS);
  await setImmediate();
  assert.deepEqual(titles, ["Idle task title", "Idle task title"]);
  await handlers.session_shutdown({}, { mode: "tui" });
  t.mock.timers.tick(TITLE_TTL_MS);
  await setImmediate();
  assert.deepEqual(titles, ["Idle task title", "Idle task title", undefined]);
});

test("titles are single-line, bounded and Unicode-safe; empty names mean clear", () => {
  assert.equal(paneTitle(" hello\nworld\x1b\x7f\x9f "), "hello world");
  assert.equal(paneTitle("\x00\n"), undefined);
  assert.equal(paneTitle(undefined), undefined);
  assert.equal(paneTitle("🙂".repeat(81)), "🙂".repeat(80));
  assert.equal(paneTitle("--help $(touch /tmp/nope)"), "--help $(touch /tmp/nope)");
});
