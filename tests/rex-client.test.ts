import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PEEK_BOUNDS, RexClient, type RexExecutor, type RexExecutionOptions, type RexExecutionResult } from "../extensions/rex/client.ts";

const HOST = "11111111-1111-4111-8111-111111111111";
const INSTANCE = "22222222-2222-4222-8222-222222222222";
const SESSION = "session:33333333-3333-4333-8333-333333333333";
const PARENT = "block:44444444-4444-4444-8444-444444444444";
const BLOCK = "block:55555555-5555-4555-8555-555555555555";
const CREATED = "block:66666666-6666-4666-8666-666666666666";
const FLAVOR = "com.superlogical.terminal.shell";
const MUTATIONS = ["session.new_block", "session.move_block", "session.detach_block", "block.close"];
interface Call { command: string; args: string[]; options: RexExecutionOptions; words: string[]; method?: string; payload?: any }
function result(body: unknown): RexExecutionResult { return { stdout: JSON.stringify(body), stderr: "", code: 0 }; }

function harness() {
  const calls: Call[] = [];
  const who: any = { endpoint: "unix:///tmp/rex.sock", host_id: HOST, instance_id: INSTANCE };
  const view: any = { session_id: SESSION, revision: 0 };
  const blocks: any[] = [
    { block_id: PARENT, host_id: HOST, placement: "placed" },
    { block_id: BLOCK, host_id: HOST, placement: "detached" },
  ];
  const optionSchema: any = {
    type: "object", properties: {
      shell: { type: "string" }, command: { type: ["array", "null"], items: { type: "string" } }, cwd: { type: "string" },
      size: { type: ["object", "null"], properties: { columns: { type: "integer" }, rows: { type: "integer" } }, required: ["columns", "rows"] },
    },
  };
  const creators: any[] = [{ host_id: HOST, flavors: [{ flavor: FLAVOR, options_schema: optionSchema }] }];
  const descriptions: Record<string, any> = {};
  for (const [name, keys] of Object.entries({
    "session.new_block": ["session_id", "flavor", "label", "options"],
    "session.move_block": ["session_id", "block_id", "anchor_block_id"],
    "session.detach_block": ["session_id", "block_id"], "block.close": ["session_id", "block_id"],
    "session.view": ["session_id"], "session.list_blocks": ["session_id"], "block_creator.list": [],
  })) {
    descriptions[name] = { name, invoke: { method: name }, input_schema: { type: "object", properties: Object.fromEntries(keys.map((key) => [key, {}])) } };
  }
  const state = {
    calls, who, view, blocks, creators, optionSchema, descriptions,
    intercept: undefined as undefined | ((call: Call, body: any) => RexExecutionResult | Promise<RexExecutionResult> | undefined),
  };
  const executor: RexExecutor = async (command, args, options) => {
    const words = args.slice(3);
    const call: Call = { command, args, options, words };
    let body: any;
    if (words[0] === "whoami") body = who;
    else if (words[0] === "api" && words[1] === "describe") body = descriptions[words[2]];
    else {
      assert.equal(words[0], "api"); assert.equal(words[1], "call");
      assert.equal(words[2], "--session"); assert.equal(words[3], SESSION);
      call.method = words[4]; call.payload = JSON.parse(words[5]);
      assert.equal(call.payload.session_id, SESSION);
      switch (call.method) {
        case "session.view": body = view; break;
        case "session.list_blocks": body = { blocks }; break;
        case "block_creator.list": body = { creators }; break;
        case "session.new_block": body = { block_id: CREATED, revision: 0 }; break;
        case "block.close": body = { block_id: call.payload.block_id, revision: 1 }; break;
        case "session.move_block": body = { created_split_id: "split:test", revision: 1 }; break;
        case "session.detach_block": case "session.float_block": case "session.set_layer_state": case "session.raise_layer": body = { revision: 1 }; break;
        default: assert.fail(`Unexpected API call ${call.method}`);
      }
    }
    calls.push(call);
    return await state.intercept?.(call, body) ?? result(body);
  };
  return Object.assign(state, { executor, client: new RexClient(executor), mutations: () => calls.filter((call) => MUTATIONS.includes(call.method ?? "")) });
}

function nativeHarness() {
  const h = harness();
  const tiled = { layer_id: "layer:77777777-7777-4777-8777-777777777777", kind: "tiled", blocks: [{ block_id: PARENT }] };
  const floating = { layer_id: "layer:88888888-8888-4888-8888-888888888888", kind: "floating", blocks: [{ block_id: BLOCK }], state: "normal" };
  const window = { window_id: "window:test", focused_block_id: PARENT, layers: [tiled] as any[] };
  h.view.windows = [window]; h.view.active_window_id = window.window_id;
  for (const [method, keys] of Object.entries({
    "session.float_block": ["session_id", "block_id", "bounds"], "session.raise_layer": ["session_id", "layer_id"],
    "session.set_layer_state": ["session_id", "layer_id", "state", "focus"],
  })) h.descriptions[method] = { name: method, invoke: { method }, input_schema: { type: "object", properties: Object.fromEntries(keys.map(k => [k, {}])) } };
  const float = () => {
    h.blocks[1].placement = "placed"; tiled.blocks = tiled.blocks.filter(b => b.block_id !== BLOCK);
    window.layers = [tiled, floating];
  };
  h.intercept = call => {
    if (call.method === "session.move_block") {
      h.blocks[1].placement = "placed";
      window.layers = [tiled]; tiled.blocks = [{ block_id: PARENT }, { block_id: BLOCK }];
    } else if (call.method === "session.float_block") float();
    else if (call.method === "session.set_layer_state") floating.state = call.payload.state;
    return undefined;
  };
  return { ...h, tiled, floating, window, float, nativeMutations: () => h.calls.filter(c => [...MUTATIONS, "session.float_block", "session.set_layer_state", "session.raise_layer"].includes(c.method ?? "")) };
}

test("native peek places once, floats the actual child, and restores without focusing", async () => {
  const h = nativeHarness();
  await h.client.peek(SESSION, BLOCK, PARENT);
  assert.deepEqual(h.nativeMutations().map(c => c.method), ["session.move_block", "session.float_block"]);
  assert.deepEqual(h.nativeMutations()[1].payload.bounds, PEEK_BOUNDS);
  assert(PEEK_BOUNDS[0] + PEEK_BOUNDS[2] <= 1 && PEEK_BOUNDS[1] + PEEK_BOUNDS[3] <= 1 && PEEK_BOUNDS[2] < 0.6);
  await h.client.minimize(SESSION, BLOCK); assert.equal(h.floating.state, "minimized");
  await h.client.peek(SESSION, BLOCK, PARENT); assert.equal(h.floating.state, "normal");
  assert.deepEqual(h.nativeMutations().slice(-2).map(c => c.method), ["session.set_layer_state", "session.raise_layer"]);
  assert(h.nativeMutations().filter(c => c.method === "session.set_layer_state").every(c => c.payload.focus === false));
});
test("toggle floats a detached child, minimizes a visible float, restores it, and leaves tiles alone", async () => {
  const h = nativeHarness();
  assert.equal(await h.client.toggle(SESSION, BLOCK, PARENT), "floating");
  assert.equal(await h.client.toggle(SESSION, BLOCK, PARENT), "minimized"); assert.equal(h.floating.state, "minimized");
  assert.equal(await h.client.toggle(SESSION, BLOCK, PARENT), "floating"); assert.equal(h.floating.state, "normal");
  await h.client.keep(SESSION, BLOCK, PARENT); const count = h.nativeMutations().length;
  assert.equal(await h.client.toggle(SESSION, BLOCK, PARENT), "tiled"); assert.equal(h.nativeMutations().length, count);
  assert(h.nativeMutations().filter(c => c.method === "session.set_layer_state").every(c => c.payload.focus === false));
});
test("native keep promotes a floating child; peek and keep respect an existing tiled pane", async () => {
  const h = nativeHarness(); h.float();
  await h.client.keep(SESSION, BLOCK, PARENT);
  assert.deepEqual(h.nativeMutations().map(c => c.method), ["session.move_block"]);
  await h.client.keep(SESSION, BLOCK, PARENT); await h.client.peek(SESSION, BLOCK, PARENT);
  assert.equal(h.nativeMutations().length, 1);
  await assert.rejects(h.client.minimize(SESSION, BLOCK), /only this child/);
});
test("native operations refuse shared layers and respect user window placement", async () => {
  const h = nativeHarness(); h.float(); h.floating.blocks.push({ block_id: CREATED });
  await assert.rejects(h.client.peek(SESSION, BLOCK, PARENT), /shared/);
  await assert.rejects(h.client.minimize(SESSION, BLOCK), /only this child/);
  assert.equal(h.nativeMutations().length, 0);
  h.window.layers = [h.tiled];
  h.view.windows.push({ window_id: "window:other", focused_block_id: BLOCK, layers: [h.floating] });
  await assert.rejects(h.client.keep(SESSION, BLOCK, PARENT), /another window/);
  assert.equal(h.nativeMutations().length, 0);
});
test("native peek checks optional capabilities before mutation and refuses layout races", async () => {
  const h = nativeHarness(); delete h.descriptions["session.float_block"].input_schema.properties.bounds;
  await assert.rejects(h.client.peek(SESSION, BLOCK, PARENT), /capability/); assert.equal(h.nativeMutations().length, 0);
  const moved = nativeHarness(), original = moved.executor;
  // Simulate a user moving the child between the two peek mutations.
  const client = new RexClient(async (command, args, options) => {
    const result = await original(command, args, options);
    if (args.includes("session.move_block") && args.includes("call")) moved.float();
    return result;
  });
  await assert.rejects(client.peek(SESSION, BLOCK, PARENT), /Layout changed/);
  assert.deepEqual(moved.nativeMutations().map(c => c.method), ["session.move_block"]);
});

test("probe checks the local identity, full targets, and every mutation capability without mutating", async () => {
  const h = harness();
  assert.deepEqual(await h.client.probe(SESSION, PARENT), { hostId: HOST, instanceId: INSTANCE, sessionId: SESSION, parentBlock: PARENT });
  assert.equal(h.mutations().length, 0);
  assert.deepEqual(h.calls.filter((call) => call.words[1] === "describe").map((call) => call.words[2]), Object.keys(h.descriptions));
  for (const call of h.calls) {
    assert.equal(call.command, "rex");
    assert.deepEqual(call.args.slice(0, 3), ["--autostart=false", "--timeout=5s", "--color=never"]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.timeoutMs, 5000);
    assert.equal(call.options.maxBytes, 2 * 1024 * 1024);
    assert.equal(call.options.cwd, process.cwd());
    assert.ok(call.options.signal instanceof AbortSignal);
    if (call.words[0] === "whoami" || call.words[1] === "describe") assert.equal(call.words.at(-1), "--json");
  }
});

test("inherited routing and pane selection cannot reach even the first CLI invocation", async (t) => {
  const keys = ["REX_SERVER", "REX_CLIENT", "REX_SESSION", "REX_BLOCK"];
  for (const key of keys) {
    const old = process.env[key];
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    process.env[key] = key === "REX_SERVER" ? "https://remote.example" : "unrelated-target";
  }
  const h = harness();
  await h.client.probe(SESSION, PARENT);
  for (const call of h.calls) {
    for (const key of keys) assert.equal(Object.hasOwn(call.options.env, key), false);
    assert.equal(call.options.env.PATH, process.env.PATH);
    assert.equal(call.args.some((arg) => arg === "-S" || arg.startsWith("--server") || arg === "-C"), false);
  }
});

test("create sends exact labels and argv as JSON, detached and without a shell", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "rex client spaces "));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = harness();
  const command = ["/usr/bin/printf", "a b", "$(touch /tmp/not-executed); 'quoted'", "--server=remote", "", "猫\nline"];
  const label = "  Results: 'quoted' $(not-a-command) 猫  ";
  assert.equal(await h.client.create(SESSION, label, command, cwd), CREATED);
  const [created] = h.mutations();
  assert.equal(h.mutations().length, 1);
  assert.equal(h.calls.at(-1), created);
  assert.deepEqual(created.payload, {
    session_id: SESSION, flavor: FLAVOR, label,
    options: { shell: "none", command, cwd, size: { columns: 100, rows: 30 } },
  });
  assert.equal(created.words.length, 6);
  assert.equal(created.options.shell, false);
  assert.equal(Object.hasOwn(created.payload.options, "keep_open"), false);
  assert.ok(h.calls.findIndex((call) => call.words[1] === "describe" && call.words[2] === "session.new_block") < h.calls.indexOf(created));
});

test("keep_open is sent only when the terminal explicitly advertises boolean support", async () => {
  for (const schema of [undefined, { type: "string" }, { type: "boolean", enum: [false] }, { type: "boolean" }]) {
    const h = harness();
    if (schema) h.optionSchema.properties.keep_open = schema;
    await h.client.create(SESSION, "Logs", ["echo", "ok"], process.cwd());
    assert.equal(h.mutations()[0].payload.options.keep_open, schema?.type === "boolean" && !schema.enum ? true : undefined);
  }
});

test("show, hide, and close use explicit session/block IDs and never focus or select a window", async () => {
  const h = harness();
  await h.client.show(SESSION, BLOCK, PARENT);
  await h.client.hide(SESSION, BLOCK);
  await h.client.close(SESSION, BLOCK);
  assert.deepEqual(h.mutations().map(({ method, payload }) => ({ method, payload })), [
    { method: "session.move_block", payload: { session_id: SESSION, block_id: BLOCK, anchor_block_id: PARENT } },
    { method: "session.detach_block", payload: { session_id: SESSION, block_id: BLOCK } },
    { method: "block.close", payload: { session_id: SESSION, block_id: BLOCK } },
  ]);
  assert.equal(h.calls.some((call) => /focus|select|new_window|window_id/.test(call.args.join(" "))), false);
});

test("show refuses an already placed block rather than risk moving focus with it", async () => {
  const h = harness();
  h.blocks[1].placement = "placed";
  await assert.rejects(h.client.show(SESSION, BLOCK, PARENT), /detached block to preserve focus/);
  assert.equal(h.mutations().length, 0);
});

test("remote endpoints, invalid identities, and mismatched location IDs fail before mutation", async (t) => {
  const cases = [
    { endpoint: "https://remote.example" }, { endpoint: "tcp://localhost:9999" }, { endpoint: "unix://" },
    { host_id: "bad" }, { instance_id: "bad" }, { host_id: "00000000-0000-0000-0000-000000000000" },
    { session_id: "session:77777777-7777-4777-8777-777777777777" }, { block_id: BLOCK },
  ];
  for (const patch of cases) await t.test(JSON.stringify(patch), async () => {
    const h = harness(); Object.assign(h.who, patch);
    await assert.rejects(h.client.probe(SESSION, PARENT), /local|UUID|match/);
    assert.equal(h.mutations().length, 0);
  });
});

test("a changed local server identity is refused on the next operation", async () => {
  const h = harness();
  await h.client.probe(SESSION, PARENT);
  h.who.instance_id = HOST;
  await assert.rejects(h.client.close(SESSION, BLOCK), /identity changed/);
  assert.equal(h.mutations().length, 0);
});

test("session and local block membership must match, including a placed anchor", async (t) => {
  for (const change of ["session", "parent missing", "parent remote", "parent detached", "block remote", "creator remote", "creator absent"]) {
    await t.test(change, async () => {
      const h = harness();
      if (change === "session") h.view.session_id = "unrelated";
      if (change === "parent missing") h.blocks.splice(0, 1);
      if (change === "parent remote") h.blocks[0].host_id = INSTANCE;
      if (change === "parent detached") h.blocks[0].placement = "detached";
      if (change === "block remote") h.blocks[1].host_id = INSTANCE;
      if (change === "creator remote") h.creators[0].host_id = INSTANCE;
      if (change === "creator absent") h.creators.splice(0);
      await assert.rejects(h.client.show(SESSION, BLOCK, PARENT), /match|missing|remote|unavailable/);
      assert.equal(h.mutations().length, 0);
    });
  }
});

test("unsupported APIs and terminal schemas fail closed before creating a block", async (t) => {
  for (const change of ["name", "invoke", "argument", "new required argument", "options", "shell", "command", "size"]) {
    await t.test(change, async () => {
      const h = harness();
      if (change === "name") h.descriptions["session.new_block"].name = "different";
      if (change === "invoke") h.descriptions["block.close"].invoke.method = "different";
      if (change === "argument") delete h.descriptions["session.move_block"].input_schema.properties.anchor_block_id;
      if (change === "new required argument") h.descriptions["session.new_block"].input_schema.required = ["unexpected"];
      if (change === "options") delete h.optionSchema.properties.cwd;
      if (change === "shell") h.optionSchema.properties.shell.enum = ["/bin/sh"];
      if (change === "command") h.optionSchema.properties.command.type = "string";
      if (change === "size") delete h.optionSchema.properties.size.properties.columns;
      await assert.rejects(h.client.create(SESSION, "test", ["echo", "ok"], process.cwd()), /match|capability|unsupported|direct argv/);
      assert.equal(h.mutations().length, 0);
    });
  }
});

test("invalid arguments are rejected without invoking Rex", async () => {
  const h = harness();
  await assert.rejects(h.client.probe("work", PARENT), /full session/);
  await assert.rejects(h.client.probe(SESSION, "4444"), /full block/);
  await assert.rejects(h.client.show(SESSION, BLOCK, BLOCK), /distinct anchor/);
  await assert.rejects(h.client.create(SESSION, "", ["echo"], process.cwd()), /label/);
  await assert.rejects(h.client.create(SESSION, "x".repeat(129), ["echo"], process.cwd()), /label/);
  await assert.rejects(h.client.create(SESSION, "ok", [], process.cwd()), /argv/);
  await assert.rejects(h.client.create(SESSION, "ok", ["echo", "a\0b"], process.cwd()), /argv/);
  await assert.rejects(h.client.create(SESSION, "ok", ["echo"], "relative"), /absolute directory/);
  assert.equal(h.calls.length, 0);
});

test("CLI startup, exit, JSON, and API errors remain clear and do not trigger mutations", async () => {
  const cases: RexExecutor[] = [
    async () => { throw Object.assign(new Error("spawn rex ENOENT"), { code: "ENOENT" }); },
    async () => ({ stdout: "", stderr: "permission denied", code: 7 }),
    async () => ({ stdout: "not json", stderr: "", code: 0 }),
    async () => result(null), async () => result({ error: { message: "unavailable" } }),
  ];
  for (const [index, executor] of cases.entries()) {
    await assert.rejects(new RexClient(executor).probe(SESSION, PARENT), [/ENOENT/, /exited 7.*permission denied/, /invalid JSON/, /JSON object/, /API error.*unavailable/][index]);
  }
});

test("combined stdout/stderr is bounded even when an injected executor ignores its limit", async () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const executor: RexExecutor = async (_command, _args, options) => ({ ...result({}), [stream]: "x".repeat(options.maxBytes + 1) });
    await assert.rejects(new RexClient(executor).probe(SESSION, PARENT), /combined output limit/);
  }
  const combined: RexExecutor = async (_command, _args, options) => ({
    stdout: "x".repeat(options.maxBytes / 2 + 1), stderr: "x".repeat(options.maxBytes / 2), code: 0,
  });
  await assert.rejects(new RexClient(combined).probe(SESSION, PARENT), /combined output limit/);
});

test("mutation timeout is bounded and never retried, even if the executor does not settle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let executionSignal: AbortSignal | undefined;
  h.intercept = (call) => {
    if (call.method !== "session.new_block") return;
    executionSignal = call.options.signal;
    started();
    return new Promise(() => {});
  };
  const creating = h.client.create(SESSION, "test", ["echo", "test"], process.cwd());
  const rejected = assert.rejects(creating, /outcome may be unknown.*timed out after 5000 ms/);
  await ready;
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(executionSignal?.aborted, true);
  assert.equal(h.mutations().length, 1);
});

test("pre-aborted and midflight cancellation reach the executor without a retry", async () => {
  const h = harness();
  const cancelled = AbortSignal.abort(new Error("cancelled before start"));
  await assert.rejects(h.client.probe(SESSION, PARENT, cancelled), /cancelled before start/);
  assert.equal(h.calls.length, 0);
  const controller = new AbortController();
  h.intercept = (call) => {
    if (call.method !== "session.move_block") return;
    controller.abort(new Error("cancelled during move"));
    assert.equal(call.options.signal.aborted, true);
    return new Promise(() => {});
  };
  await assert.rejects(h.client.show(SESSION, BLOCK, PARENT, controller.signal), /outcome may be unknown.*cancelled during move/);
  assert.equal(h.mutations().length, 1);
});

test("every mutation fails once without retrying when Rex reports an error", async () => {
  for (const method of MUTATIONS) {
    const h = harness();
    h.intercept = (call) => call.method === method ? { stdout: "", stderr: "request timed out", code: 1 } : undefined;
    const operation = method === "session.new_block" ? h.client.create(SESSION, "test", ["echo"], process.cwd())
      : method === "session.move_block" ? h.client.show(SESSION, BLOCK, PARENT)
      : method === "session.detach_block" ? h.client.hide(SESSION, BLOCK) : h.client.close(SESSION, BLOCK);
    await assert.rejects(operation, /outcome may be unknown.*request timed out/);
    assert.equal(h.mutations().length, 1);
  }
});

test("mutation failure or malformed returned IDs never cause an automatic retry", async () => {
  for (const response of [
    { stdout: "", stderr: "request timed out", code: 1 },
    result({ block_id: "suffix" }), result({ block_id: null }), result({ error: "conflict" }),
  ]) {
    const h = harness();
    h.intercept = (call) => call.method === "session.new_block" ? response : undefined;
    await assert.rejects(h.client.create(SESSION, "test", ["echo"], process.cwd()), /outcome may be unknown/);
    assert.equal(h.mutations().length, 1);
  }
  const h = harness();
  h.intercept = (call) => call.method === "block.close" ? result({ block_id: PARENT }) : undefined;
  await assert.rejects(h.client.close(SESSION, BLOCK), /different block ID/);
  assert.equal(h.mutations().length, 1);
});
