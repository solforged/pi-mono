// Explicit live check: runs real Pi against scripted provider faults. No model, network or credentials.
// node tests/fixtures/fault-smoke.ts [--with EXTENSION]... [--json] [--keep] [SCENARIO]...
// One row per scenario reports what Pi did on its own; --with reruns the same faults with a recovery
// extension loaded. Findings never fail the run: only a broken harness exits nonzero.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, type Scenario } from "./fault-scenarios.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const argv = process.argv.slice(2), extra: string[] = [], names: string[] = [];
let json = false, keep = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--with") extra.push(resolve(argv[++i] ?? "")); else if (argv[i] === "--json") json = true;
  else if (argv[i] === "--keep") keep = true; else names.push(argv[i]);
}
const unknown = names.filter(name => !SCENARIOS.some(s => s.name === name));
if (unknown.length) { console.error(`Unknown scenario: ${unknown.join(", ")}\nKnown: ${SCENARIOS.map(s => s.name).join(", ")}`); process.exit(2); }
if (spawnSync("pi", ["--version"]).error) { console.error("Pi is not installed"); process.exit(2); }
const TIMEOUT_MS = 30_000;

type Outline = { role: string; stop?: string; error?: string; text?: string; id?: string; isError?: boolean; calls?: { id: string; name: string }[] };
type Run = { events: any[]; hung: boolean; code: number | null; stderr: string };
const textOf = (message: any) => (message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");

function runPi(dir: string, env: Record<string, string>, args: string[]): Promise<Run> {
  return new Promise(done => {
    // stdin must be closed, or print mode waits on it.
    const child = spawn("pi", args, { cwd: join(dir, "cwd"), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", stderr = "", hung = false;
    const timer = setTimeout(() => { hung = true; child.kill("SIGKILL"); }, TIMEOUT_MS);
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => {
      clearTimeout(timer);
      const events = out.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      done({ events, hung, code, stderr });
    });
  });
}

// History is valid when every call id is unique and has exactly one result after it, and no result is orphaned.
function historyProblems(messages: Outline[]) {
  const problems: string[] = [], calls = new Map<string, number>(), results = new Map<string, number>();
  for (const m of messages) {
    for (const call of m.calls ?? []) calls.set(call.id, (calls.get(call.id) ?? 0) + 1);
    if (m.role === "toolResult") {
      if (!calls.has(m.id!)) problems.push(`orphan result ${m.id}`);
      results.set(m.id!, (results.get(m.id!) ?? 0) + 1);
    }
  }
  for (const [id, count] of calls) {
    if (count > 1) problems.push(`call id ${id} used ${count} times`);
    const seen = results.get(id) ?? 0;
    if (seen !== count) problems.push(`call ${id} has ${seen} result${seen === 1 ? "" : "s"}`);
  }
  const failed = messages.filter(m => m.role === "assistant" && (m.stop === "error" || m.stop === "aborted")).length;
  if (failed) problems.push(`${failed} failed turn${failed === 1 ? "" : "s"} replayed`);
  if (messages.at(-1)?.role === "assistant") problems.push("ends with an assistant turn");
  return problems;
}
// What Pi's built-in API converters would send. A custom provider receives the context before that
// step, so this mirrors the two repairs in Pi 1.5.0's transformMessages: failed turns are dropped and
// calls without a result get one. It is read from Pi's code, not observed.
function converted(messages: Outline[]) {
  const out: Outline[] = [];
  let pending: { id: string; name: string }[] = [], seen = new Set<string>();
  const close = () => {
    for (const call of pending) if (!seen.has(call.id)) out.push({ role: "toolResult", id: call.id, isError: true, text: "No result provided" });
    pending = []; seen = new Set();
  };
  for (const m of messages) {
    if (m.role === "assistant") {
      close();
      if (m.stop === "error" || m.stop === "aborted") continue;
      if (m.calls?.length) pending = m.calls;
    } else if (m.role === "toolResult") seen.add(m.id!);
    else if (m.role === "user") close();
    out.push(m);
  }
  close();
  return out;
}
// One assistant text repeating or extending another: the model or the user sees the same words twice.
function repeated(texts: string[]) {
  const seen = texts.map(t => t.trim()).filter(t => t.length >= 8);
  return seen.some((a, i) => seen.some((b, j) => i !== j && b.startsWith(a)));
}

async function cutAfterToolCall(sessions: string) {
  const file = join(sessions, (await readdir(sessions, { recursive: true })).find(name => name.endsWith(".jsonl"))!);
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  const index = lines.findLastIndex(line => { const m = JSON.parse(line).message; return m?.role === "assistant" && m.content?.some((c: any) => c.type === "toolCall"); });
  if (index < 0) throw new Error("No tool call to cut after");
  await writeFile(file, `${lines.slice(0, index + 1).join("\n")}\n`);
}

async function check(scenario: Scenario) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-fault-")));
  try {
    const agentDir = join(dir, "agent"), sessions = join(dir, "sessions"), log = join(dir, "requests.jsonl");
    for (const path of [agentDir, sessions, join(dir, "cwd")]) await mkdir(path, { recursive: true });
    // Short backoff keeps the matrix fast; attempt counts stay at Pi's defaults.
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 20, maxAgentDelayMs: 50 }, ...scenario.settings }));
    const events: any[] = [], ends: string[] = [], needs: string[] = [];
    let hung = false, stderr = "";
    for (const [phase, { prompt, cut }] of scenario.phases.entries()) {
      const args = ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-builtin-tools",
        "--session-dir", sessions, ...(phase ? ["--continue"] : []), "-e", join(root, "tests/fixtures/fault-provider.ts"), ...extra.flatMap(path => ["-e", path]),
        "--provider", "fault", "--model", "fault/fixture", "--mode", "json", "-p", prompt];
      const run = await runPi(dir, { PI_CODING_AGENT_DIR: agentDir, PI_FAULT_SCENARIO: scenario.name, PI_FAULT_PHASE: String(phase), PI_FAULT_LOG: log }, args);
      events.push(...run.events); hung ||= run.hung; stderr = run.stderr;
      // A phase needs the user when it did not end in a completed answer.
      const reply = run.events.filter(e => e.type === "message_end" && e.message?.role === "assistant").at(-1)?.message;
      const need = run.hung ? "hung" : !run.events.some(e => e.type === "agent_settled") ? `exited ${run.code} unsettled`
        : reply?.stopReason !== "stop" ? `ended ${reply?.stopReason ?? "with no reply"}` : !textOf(reply).trim() ? "ended with no text" : "";
      ends.push(reply?.stopReason ?? "none");
      if (need) needs.push(scenario.phases.length > 1 ? `run ${phase + 1} ${need}` : need);
      if (cut === "after-tool-call") await cutAfterToolCall(sessions);
      if (run.hung) break;
    }
    const records = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const requests = records.filter(r => r.t === "request" && r.n >= 0), executed = records.filter(r => r.t === "exec");
    const last: Outline[] = requests.at(-1)?.messages ?? [];
    const finals = events.filter(e => e.type === "message_end" && e.message?.role === "assistant").map(e => e.message);
    const final = finals.at(-1), shown = finals.map(textOf);
    const toolErrors = events.filter(e => e.type === "tool_execution_end" && e.isError).length;
    let streak = 0, longest = 0;
    for (const [i, e] of executed.entries()) { streak = i && e.value === executed[i - 1].value ? streak + 1 : 1; longest = Math.max(longest, streak); }
    return {
      scenario: scenario.name, about: scenario.about, settled: !hung && needs.every(need => !need.includes("unsettled")), ends, finalText: (shown.at(-1) ?? "").slice(0, 60), error: final?.errorMessage?.slice(0, 80),
      retries: events.filter(e => e.type === "auto_retry_start").length, retryOutcome: events.filter(e => e.type === "auto_retry_end").at(-1)?.success,
      compactions: events.filter(e => e.type === "compaction_start").map(e => e.reason), compactionErrors: events.filter(e => e.type === "compaction_end" && e.errorMessage).map(e => e.errorMessage),
      requests: requests.length, summaries: records.filter(r => r.t === "request" && r.n < 0).length, executed: executed.map(e => e.value), toolErrors,
      history: historyProblems(last), converted: historyProblems(converted(last)), omitted: events.filter(e => e.type === "entry_appended" && e.entry?.type === "context_edit").length,
      identicalCalls: longest, contextRepeats: repeated(last.filter(m => m.role === "assistant").map(m => m.text ?? "")), shownRepeats: repeated(shown),
      needsUser: needs.join("; "), stderr: stderr.trim().slice(0, 300) || undefined, lastContext: last, dir: keep ? dir : undefined,
    };
  } finally { if (!keep) await rm(dir, { recursive: true, force: true }); }
}

const rows = [];
for (const scenario of SCENARIOS.filter(s => !names.length || names.includes(s.name))) rows.push(await check(scenario));
if (json) console.log(JSON.stringify(rows, null, 2));
else {
  const cells = rows.map(r => [r.scenario, r.settled ? "yes" : "NO", r.ends.join(" → "), r.retries ? `${r.retries}${r.retryOutcome === false ? " failed" : ""}` : "-", String(r.requests),
    r.identicalCalls > 2 ? `${r.executed[0]} ×${r.executed.length}` : r.executed.join(",") || "-", r.omitted ? String(r.omitted) : "-",
    r.history.join("; ") || "ok", r.converted.join("; ") || "ok", r.contextRepeats ? "context" : r.shownRepeats ? "shown" : "-", r.needsUser || "-"]);
  const head = ["scenario", "settled", "ended", "retries", "requests", "executed", "omitted", "history sent last", "after built-in repair", "repeats", "needs user"];
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map(c => c[i].length)));
  for (const line of [head, ...cells]) console.log(line.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd());
  for (const r of rows) {
    const notes = [r.compactions.length && `compaction: ${r.compactions.join(",")}`, ...r.compactionErrors, r.toolErrors && `${r.toolErrors} tool error result${r.toolErrors === 1 ? "" : "s"}`,
      r.identicalCalls >= 5 && `${r.identicalCalls} identical calls ran${r.toolErrors ? `, ${r.toolErrors} refused` : ", never interrupted"}`, r.error && `error: ${r.error}`, r.stderr && `stderr: ${r.stderr}`].filter(Boolean);
    if (notes.length) console.log(`  ${r.scenario}: ${notes.join(" · ")}`);
  }
}
