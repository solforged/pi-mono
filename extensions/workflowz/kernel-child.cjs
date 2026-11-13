// The workflow kernel's own process. Pi starts it with `-e` (Bun, Node, or
// Node inside the sandbox guest), so it is plain CommonJS with no imports
// from the repo. It speaks JSON lines: requests from Pi on stdin, prints,
// calls and results on stdout. Workflow state (pools, agents, judges) lives in
// Pi; the handles here are proxies that call back over the pipe.
"use strict";
const vm = require("node:vm");
const { inspect } = require("node:util");
const { AsyncLocalStorage } = require("node:async_hooks");

const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const custom = inspect.custom;
// Handles print as tokens that Pi replaces with their live status.
const token = (kind, id) => `\u0001${kind}:${id}\u0001`;
const show = (value) => typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 110, maxArrayLength: 60, maxStringLength: 20000 });
const AGENTS = new Set(["advisor", "scout", "worker", "researcher"]);

let syncTimeoutMs = 10000;
let counters = {};
// The cell whose code is running, carried across awaits and timers, so a
// detached cell's output and failures stay its own.
const cells = new AsyncLocalStorage();
const current = () => cells.getStore();
let nextCall = 0;
const calls = new Map();
const tools = new Map(); // name -> function registered with tool()

function nextId(prefix) { counters[prefix] = (counters[prefix] || 0) + 1; return `${prefix}-${counters[prefix]}`; }

function describeError(error) {
  if (!(error && typeof error === "object" && "message" in error)) return `Uncaught ${show(error)}`;
  const frames = String(error.stack || "").split("\n").filter((line) => /^\s+at /.test(line) && /cell-\d+\.js/.test(line)).slice(0, 6);
  return [`${error.name || "Error"}: ${error.message}`, ...frames].join("\n");
}

function print(text) { const cell = current(); send({ t: "print", text, ...(cell ? { cell: cell.n } : {}) }); }

/** Calls Pi; the result is plain JSON. */
function call(fn, ...args) {
  const id = ++nextCall;
  return new Promise((resolve, reject) => {
    calls.set(id, { resolve, reject });
    send({ t: "call", id, fn, args });
  });
}
function errorFrom(error) { const e = new Error(error && error.message || String(error)); if (error && error.name) e.name = error.name; return e; }

/** Starts a creation call whose handle is returned before it lands; failures surface when the cell ends. */
function track(promise) {
  const cell = current();
  const tracked = promise.then(() => undefined, (error) => { print(`[start failed] ${error.message}`); throw error; });
  tracked.catch(() => {});
  if (cell) cell.pending.add(tracked);
  return tracked;
}

const ms = (options) => options && options.timeout !== undefined ? Number(options.timeout) * 1000 : undefined;

function itemHandle(id, kind, label, created) {
  return {
    id, handle: `agent://${id}`, label,
    wait: async (options) => { await created; return call("itemWait", id, ms(options)); },
    status: async () => { await created; return call("itemStatus", id); },
    send: async (message, options) => {
      await created;
      const next = nextId("agent");
      const sent = await call("agentSend", id, String(message), { ...plain(options || {}), id: next });
      return itemHandle(sent.id, "agent", sent.label, Promise.resolve());
    },
    [custom]: () => token(kind, id),
  };
}

function poolHandle(name, created) {
  const after = async (fn, ...args) => { await created; return call(fn, name, ...args); };
  return {
    name,
    push: async (...items) => after("poolPush", items.length === 1 && Array.isArray(items[0]) ? items[0] : items),
    status: () => after("poolStatus"),
    peek: () => after("poolPeek"),
    results: () => after("poolResults"),
    wait: (options) => after("poolWait", ms(options)),
    close: () => after("poolClose"),
    [custom]: () => token("pool", name),
  };
}

function batchHandle(id, created) {
  const after = async (fn, ...args) => { await created; return call(fn, id, ...args); };
  return {
    id,
    drain: (options) => after("batchDrain", ms(options)),
    drainIter: async function* (options) {
      while (true) {
        const fresh = await after("batchDrain", ms(options));
        for (const entry of fresh) yield entry;
        const status = await after("batchStatus");
        if (status.done && status.drainedAll) return;
      }
    },
    status: () => after("batchStatus"),
    results: () => after("batchResults"),
    failed: () => after("batchFailed"),
    close: () => after("batchClose"),
    [custom]: () => token("judge", id),
  };
}

function globals() {
  const out = (...args) => print(args.map(show).join(" "));
  const guard = (fn) => (...args) => {
    try { const r = fn(...args); if (r && typeof r.then === "function") r.then(undefined, (e) => print(`[timer] ${describeError(e)}`)); }
    catch (e) { print(`[timer] ${describeError(e)}`); }
  };
  const toolProxy = new Proxy({}, {
    get: (_target, name) => typeof name !== "string" || name === "then" ? undefined : (args = {}) => call("tool", name, args),
  });
  return {
    print: out, console: { log: out, info: out, warn: out, error: out, debug: out },
    log: (message) => { const line = String(message); print(`· ${line}`); void call("log", line).catch(() => {}); },
    phase: (title) => { print(`## ${String(title)}`); void call("phase", String(title)).catch(() => {}); },
    workpool: (agent, options) => {
      if (agent && typeof agent === "object") { options = agent; agent = undefined; }
      options = options || {};
      agent = agent === undefined ? "scout" : agent;
      if (typeof agent !== "string" || !AGENTS.has(agent)) throw new Error(`Unknown agent ${String(agent)}; use advisor, scout, researcher or worker`);
      const name = options.name === undefined ? nextId("pool") : String(options.name);
      return poolHandle(name, track(call("createPool", agent, { ...plain(options), name })));
    },
    pool: (name) => poolHandle(String(name), track(call("poolStatus", String(name)))),
    agent: (prompt, options) => {
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error("agent() needs a prompt");
      const id = nextId("agent");
      return itemHandle(id, "agent", prompt, track(call("agent", prompt, { ...plain(options || {}), id })));
    },
    completion: (prompt, options) => {
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error("completion() needs a prompt");
      const id = nextId("completion");
      return itemHandle(id, "completion", prompt, track(call("completion", prompt, { ...plain(options || {}), id })));
    },
    handle: (id) => itemHandle(String(id), "item", "", Promise.resolve()),
    judge: (state, questions) => call("judge", state, questions),
    judgeBatch: (states, questions, options) => {
      const id = nextId("judge");
      return batchHandle(id, track(call("judgeBatch", states, questions, { ...plain(options || {}), id })));
    },
    wait: async (handles, options) => {
      const list = Array.isArray(handles) ? handles : [handles];
      const settled = await Promise.allSettled(list.map((h) => {
        if (!h || typeof h.id !== "string" || typeof h.wait !== "function" || typeof h.push === "function") return Promise.reject(new Error("wait() takes agent/completion handles; use pool.wait() for pools"));
        return h.wait(options);
      }));
      if (!options || options.raiseErrors !== false) { const failed = settled.find((s) => s.status === "rejected"); if (failed) throw failed.reason; }
      const values = settled.map((s) => s.status === "fulfilled" ? s.value : s.reason);
      return Array.isArray(handles) ? values : values[0];
    },
    tool: (name, fn, options) => {
      if (typeof name !== "string" || !/^[a-z][a-z0-9_]{1,40}$/.test(name)) throw new Error("tool() names are lowercase letters, digits and underscores");
      if (typeof fn !== "function") throw new Error("tool() needs a function");
      tools.set(name, fn);
      return track(call("defineTool", name, plain(options || {}))).then(() => name);
    },
    budget: { total: () => call("budget", "total"), spent: () => call("budget", "spent"), remaining: () => call("budget", "remaining") },
    tools: toolProxy,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(milliseconds) || 0))),
    setTimeout: (fn, delay, ...args) => setTimeout(guard(fn), delay, ...args),
    setInterval: (fn, delay, ...args) => setInterval(guard(fn), delay, ...args),
    clearTimeout, clearInterval, structuredClone, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal, atob, btoa,
  };
}

/** Options cross to Pi as JSON; functions and handles do not. */
function plain(value) { return JSON.parse(JSON.stringify(value === undefined ? null : value)) ?? {}; }

// A cell's top-level `const pool = ...` becomes an assignment to a global, which
// would replace pool() for every later cell. The API therefore sits on
// accessors that refuse assignment; the transform catches plain declarations
// before the cell runs, and this stops destructuring and bare assignment.
function protect(api) {
  const target = {};
  for (const [name, value] of Object.entries(api)) {
    Object.defineProperty(target, name, { enumerable: true, get: () => value,
      set: () => { throw new Error(`"${name}" is a kernel function and cannot be assigned; use another variable name`); } });
  }
  return target;
}

const context = vm.createContext(protect(globals()));

async function run(message) {
  const cell = { n: message.cell, pending: new Set() };
  let script, candidate;
  for (const c of message.candidates) {
    try { script = new vm.Script(c.code, { filename: `cell-${message.cell}.js` }); candidate = c; break; }
    catch (error) { if (c === message.candidates[message.candidates.length - 1]) { send({ t: "done", cell: cell.n, error: describeError(error) }); return; } }
  }
  let promise;
  try { promise = cells.run(cell, () => Promise.resolve(script.runInContext(context, { timeout: syncTimeoutMs }))); }
  catch (error) { promise = Promise.reject(error); }
  let result;
  try {
    const value = await promise;
    result = { value: candidate.returnsValue && value !== undefined ? show(value) : undefined };
  } catch (error) { result = { error: describeError(error) }; }
  const failed = (await Promise.allSettled([...cell.pending])).filter((s) => s.status === "rejected");
  if (failed.length && !result.error) result.error = failed.map((s) => `Could not start: ${s.reason.message}`).join("\n");
  send({ t: "done", cell: cell.n, ...result, ...(candidate.note ? { note: candidate.note } : {}) });
}

async function invoke(message) {
  const fn = tools.get(message.name);
  try {
    if (!fn) throw new Error(`Kernel tool ${message.name} is not defined`);
    const value = await fn(message.args);
    send({ t: "invoked", id: message.id, ok: true, value: typeof value === "string" ? value : show(value) });
  } catch (error) { send({ t: "invoked", id: message.id, ok: false, error: describeError(error) }); }
}

process.on("uncaughtException", (error) => print(`[uncaught] ${describeError(error)}`));
process.on("unhandledRejection", (error) => print(`[unhandled rejection] ${describeError(error)}`));
setInterval(() => send({ t: "beat" }), 500);

function receive(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.t === "init") { counters = message.counters || {}; syncTimeoutMs = message.syncTimeoutMs || syncTimeoutMs; send({ t: "ready" }); }
  else if (message.t === "run") void run(message);
  else if (message.t === "reply") {
    const pending = calls.get(message.id);
    if (!pending) return;
    calls.delete(message.id);
    if (message.ok) pending.resolve(message.value); else pending.reject(errorFrom(message.error));
  } else if (message.t === "invoke") void invoke(message);
}

// Split on "\n" only: readline also breaks lines at U+2028 and U+2029, which JSON leaves raw inside strings.
let pending = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  const lines = (pending + chunk).split("\n");
  pending = lines.pop();
  for (const line of lines) receive(line);
}).on("end", () => process.exit(0)).on("close", () => process.exit(0));
