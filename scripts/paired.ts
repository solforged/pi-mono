// Paired live runs: the same tasks with and without an extension (docs/measuring.md). Each task is a
// past fix: the tree before it plus the tests it added, scored by those tests.
// PAID: every run is a real model session on the default model.
//   node scripts/paired.ts --with EXTENSION [--both EXTENSION] [--runs 3] [--budget 10] [--jobs 2] [--out DIR] [TASK]...
//   node scripts/paired.ts --check          build each task; its tests must fail before the fix and pass after
//   node scripts/paired.ts --report DIR     reprint the report from an earlier run
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS, type Task } from "./paired-tasks.ts";
import { mainBranch, parse, profile, sessionFiles, timeline } from "./profile.ts";

// Loaded in both arms from this checkout, so a run does not depend on what is installed or being edited.
// Left out on purpose: tools that reach other sessions, start children, ask the user, or search past
// sessions (which hold the original fixes).
const BASE = ["anthropic", "artifacts", "todo", "web-search"];
const TIMEOUT_MS = 20 * 60_000;
const root = fileURLToPath(new URL("../", import.meta.url));

export type Arm = "off" | "on";
export type Row = {
  task: string; run: number; arm: Arm; pass: boolean; cost: number; turns: number; calls: number; multi: number;
  batchable: number; promptTokens: number; seconds: number; note: string;
  delegated?: number; // Dollars of the cost spent by children and auxiliary calls. Absent in older results.
};

function mulberry(seed: number) {
  return () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// Mean of on minus off across tasks, each task first averaged over its runs, with a 95% bootstrap
// interval from resampling tasks. Tasks missing an arm are left out.
export function paired(rows: readonly Row[], metric: (row: Row) => number, resamples = 10_000) {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const tasks = [...new Set(rows.map(r => r.task))].flatMap(task => {
    const of = (arm: Arm) => rows.filter(r => r.task === task && r.arm === arm).map(metric);
    return of("off").length && of("on").length ? [{ task, off: mean(of("off")), on: mean(of("on")) }] : [];
  });
  if (!tasks.length) return { tasks, off: 0, on: 0, diff: 0, low: 0, high: 0 };
  const diffs = tasks.map(t => t.on - t.off), random = mulberry(1), means: number[] = [];
  for (let i = 0; i < resamples; i++) means.push(mean(diffs.map(() => diffs[Math.floor(random() * diffs.length)])));
  means.sort((a, b) => a - b);
  return { tasks, off: mean(tasks.map(t => t.off)), on: mean(tasks.map(t => t.on)), diff: mean(diffs), low: means[Math.floor(resamples * 0.025)], high: means[Math.ceil(resamples * 0.975) - 1] };
}

export function report(rows: readonly Row[]): string {
  const metrics: [string, (row: Row) => number, (n: number) => string][] = [
    ["tests pass", r => Number(r.pass), n => `${Math.round(n * 100)}%`],
    ["cost", r => r.cost, n => `$${n.toFixed(3)}`],
    ["…of it delegated", r => r.delegated ?? 0, n => `$${n.toFixed(3)}`],
    ["turns", r => r.turns, n => n.toFixed(1)],
    ["tool calls", r => r.calls, n => n.toFixed(1)],
    ["turns with 2+ calls", r => r.multi, n => n.toFixed(1)],
    ["read-only turns that could have batched", r => r.batchable, n => n.toFixed(1)],
    ["prompt tokens, all turns", r => r.promptTokens, n => `${(n / 1000).toFixed(0)}k`],
    ["seconds", r => r.seconds, n => n.toFixed(0)],
  ];
  const signed = (text: string) => text.startsWith("-") ? `−${text.slice(1)}` : `+${text}`;
  const lines = metrics.map(([name, metric, show]) => {
    const p = paired(rows, metric);
    return [name, show(p.off), show(p.on), signed(show(p.diff).replace("$-", "-$")), `${signed(show(p.low).replace("$-", "-$"))} to ${signed(show(p.high).replace("$-", "-$"))}`];
  });
  const table = [["per task", "off", "on", "on − off", "95% interval"], ...lines];
  const widths = table[0].map((_, i) => Math.max(...table.map(r => r[i].length)));
  const count = (arm: Arm) => rows.filter(r => r.arm === arm).length;
  const perTask = paired(rows, r => r.cost).tasks.map(t => `  ${t.task}: $${t.off.toFixed(2)} → $${t.on.toFixed(2)}`);
  return [`${new Set(rows.map(r => r.task)).size} tasks, ${count("off")} runs off and ${count("on")} on, $${rows.reduce((a, r) => a + r.cost, 0).toFixed(2)} spent.`, "",
    ...table.map(r => r.map((cell, i) => i ? cell.padStart(widths[i]) : cell.padEnd(widths[i])).join("  ")), "", "Cost by task", ...perTask].join("\n");
}

const run = (command: string, args: string[], cwd: string, env = process.env) => spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 1 << 28 });
const git = (args: string[], cwd = root) => { const r = run("git", args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`); return r.stdout; };
const changed = (task: Task) => git(["show", "--name-only", "--format=", "--diff-filter=AM", task.commit]).split("\n").filter(Boolean);
const testsOf = (task: Task) => changed(task).filter(file => /^tests\/[^/]+\.test\.ts$/.test(file));
const overlay = (task: Task, dir: string, files: string[]) => { for (const file of files) { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), git(["show", `${task.commit}:${file}`])); } };
const passes = (dir: string, tests: string[]) => run("node", ["--test", ...tests], dir).status === 0;

// The tree before the fix, with the fix's tests, as a repository with no later history to read.
function build(task: Task, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  git(["archive", "-o", join(dir, ".tree.tar"), `${task.commit}~1`]);
  if (run("tar", ["-xf", ".tree.tar"], dir).status !== 0 || run("rm", [".tree.tar"], dir).status !== 0) throw new Error(`could not unpack ${task.id}`);
  const tests = testsOf(task);
  overlay(task, dir, tests);
  // A throwaway repository: the user's hooks and identity stay out of it, as in the sandbox smoke check.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=paired", "-c", "user.email=paired@localhost", "commit", "-qm", "base"]]) {
    if (run("git", args, dir, env).status !== 0) throw new Error(`could not create a repository for ${task.id}`);
  }
  return tests;
}

// The workflows extension keeps state per working directory under the agent directory (state.ts names it
// by this hash). A run's directory is never used again, so its state would only pile up there.
function forgetState(cwd: string) {
  const state = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "workflow-state");
  const scope = createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 20);
  for (const profile of existsSync(state) ? readdirSync(state) : []) rmSync(join(state, profile, scope), { recursive: true, force: true });
}

function measure(sessions: string): Pick<Row, "cost" | "delegated" | "turns" | "calls" | "multi" | "batchable" | "promptTokens"> {
  const files = existsSync(sessions) ? sessionFiles(sessions).map(file => parse(readFileSync(file, "utf8"))) : [];
  const turns = files.flatMap(entries => timeline(mainBranch(entries)).turns), totals = profile(files);
  return {
    cost: totals.total, delegated: totals.auxiliary, turns: turns.length, calls: turns.reduce((a, t) => a + t.calls.length, 0), multi: turns.filter(t => t.calls.length > 1).length,
    batchable: totals.sizings.find(s => s.candidate.startsWith("Batch read-only"))?.count ?? 0, promptTokens: turns.reduce((a, t) => a + t.prompt, 0),
  };
}

function runArm(task: Task, tests: string[], template: string, out: string, n: number, arm: Arm, shared: string[], extensions: string[]): Promise<Row> {
  const dir = join(out, "runs", `${task.id}-${n}-${arm}`), cwd = join(dir, "cwd"), sessions = join(dir, "sessions"), started = Date.now();
  cpSync(template, cwd, { recursive: true });
  const loaded = [...BASE.map(name => join(root, "extensions", name, "index.ts")), ...shared, ...(arm === "on" ? extensions : [])];
  const prompt = `${task.prompt}\n\nThe tests in ${tests.join(", ")} describe the expected behavior and currently fail. Make them pass without editing the tests.`;
  // Rex variables would register each run as a pane of the session this was started from.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("REX_")));
  return new Promise(done => {
    // stdin must be closed, or print mode waits on it.
    const child = spawn("pi", ["--mode", "json", "-p", "--no-extensions", ...loaded.flatMap(path => ["-e", path]), "--session-dir", sessions, prompt], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "", hung = false;
    const timer = setTimeout(() => { hung = true; child.kill("SIGKILL"); }, TIMEOUT_MS);
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on("close", code => {
      clearTimeout(timer);
      forgetState(cwd);
      const untouched = tests.every(file => existsSync(join(cwd, file)) && readFileSync(join(cwd, file), "utf8") === readFileSync(join(template, file), "utf8"));
      const note = hung ? "timed out" : code !== 0 ? `exit ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}` : untouched ? "" : "edited the tests";
      done({ task: task.id, run: n, arm, pass: untouched && passes(cwd, tests), ...measure(sessions), seconds: (Date.now() - started) / 1000, note });
    });
  });
}

if (import.meta.main) {
  const usage = "Usage: pm-paired --with <extension> [--both <extension>] [--runs 3] [--budget 10] [--jobs 2] [--out <dir>] [task]...\n       pm-paired --check | --report <dir>";
  const fail = (message: string): never => { console.error(`${message}\n${usage}`); process.exit(2); };
  const argv = process.argv.slice(2), extensions: string[] = [], shared: string[] = [], names: string[] = [];
  let runs = 3, budget = 10, jobs = 2, out = "", check = false, reportDir = "";
  for (let i = 0; i < argv.length; i++) {
    const value = () => argv[++i] ?? fail(`${argv[i - 1]} needs a value`);
    if (argv[i] === "--with") extensions.push(resolve(value())); else if (argv[i] === "--both") shared.push(resolve(value())); else if (argv[i] === "--runs") runs = Number(value());
    else if (argv[i] === "--budget") budget = Number(value()); else if (argv[i] === "--jobs") jobs = Number(value());
    else if (argv[i] === "--out") out = resolve(value()); else if (argv[i] === "--check") check = true;
    else if (argv[i] === "--report") reportDir = resolve(value()); else if (argv[i].startsWith("-")) fail(`Unknown option: ${argv[i]}`); else names.push(argv[i]);
  }
  const rowsIn = (dir: string): Row[] => existsSync(join(dir, "results.jsonl")) ? parse(readFileSync(join(dir, "results.jsonl"), "utf8")) as Row[] : [];
  if (reportDir) { console.log(report(rowsIn(reportDir))); process.exit(0); }
  const unknown = names.filter(name => !TASKS.some(t => t.id === name));
  if (unknown.length) fail(`Unknown task: ${unknown.join(", ")}\nKnown: ${TASKS.map(t => t.id).join(", ")}`);
  const tasks = TASKS.filter(t => !names.length || names.includes(t.id));

  if (check) {
    const scratch = mkdtempSync(join(tmpdir(), "paired-check-"));
    let bad = 0;
    for (const task of tasks) {
      const dir = join(scratch, task.id), tests = build(task, dir), before = tests.length > 0 && passes(dir, tests);
      overlay(task, dir, changed(task));
      const after = passes(dir, tests), ok = tests.length > 0 && !before && after;
      if (!ok) bad++;
      console.log(`${ok ? "ok " : "BAD"} ${task.id.padEnd(28)} ${task.commit}  ${tests.join(" ") || "no tests"}  before: ${before ? "pass" : "fail"}, after: ${after ? "pass" : "fail"}`);
    }
    run("rm", ["-rf", scratch], tmpdir());
    process.exit(bad ? 1 : 0);
  }

  if (!extensions.length || !(runs > 0) || !(budget > 0) || !(jobs > 0)) fail("Name the extension under test with --with.");
  for (const path of [...extensions, ...shared]) if (!existsSync(path)) fail(`No such extension: ${path}`);
  out ||= mkdtempSync(join(tmpdir(), "paired-"));
  mkdirSync(join(out, "tasks"), { recursive: true });
  const rows = rowsIn(out), templates = new Map<string, { dir: string; tests: string[] }>();
  for (const task of tasks) { const dir = join(out, "tasks", task.id); templates.set(task.id, { dir, tests: existsSync(dir) ? testsOf(task) : build(task, dir) }); }
  // Whole rounds first, so stopping at the budget leaves every task with the same number of runs.
  const queue = Array.from({ length: runs }, (_, n) => tasks.map(task => ({ task, n: n + 1 }))).flat()
    .filter(({ task, n }) => !rows.some(r => r.task === task.id && r.run === n));
  let spent = rows.reduce((a, r) => a + r.cost, 0);
  console.error(`${queue.length} pairs to run, $${spent.toFixed(2)} spent of $${budget}; results in ${out}`);
  await Promise.all(Array.from({ length: jobs }, async () => {
    for (let job = queue.shift(); job && spent < budget; job = queue.shift()) {
      const { dir, tests } = templates.get(job.task.id)!;
      const pair = await Promise.all((["off", "on"] as const).map(arm => runArm(job!.task, tests, dir, out, job!.n, arm, shared, extensions)));
      for (const row of pair) {
        rows.push(row); spent += row.cost;
        appendFileSync(join(out, "results.jsonl"), JSON.stringify(row) + "\n");
        console.error(`${row.task} #${row.run} ${row.arm.padEnd(3)} ${row.pass ? "pass" : "FAIL"}  $${row.cost.toFixed(2)}  ${row.turns} turns, ${row.calls} calls  ${Math.round(row.seconds)}s  ${row.note}`);
      }
    }
  }));
  if (queue.length) console.error(`Stopped at the budget with ${queue.length} pairs not run.`);
  console.log(report(rows));
}
