// Do models find deferred tools when a task needs them? (docs/deferred-tools.md)
// PAID: every run is a real one-turn session. Each task runs against a mock tool catalog in three arms:
//   deferred  only tool_search is declared
//   index     the same, plus extensions/deferred-tools listing the groups in the prompt
//   direct    every mock tool declared up front, as the baseline
//   node scripts/deferred-tools-eval.ts [--models provider/model[:thinking],...] [--arms deferred,index,direct]
//     [--tasks id,...] [--runs 1] [--jobs 8] [--budget 15] [--out DIR] [--keep]
//   node scripts/deferred-tools-eval.ts --report DIR
// Models default to every main and role model of the presets in roles.json.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS, WORKSPACE, type Task } from "./deferred-tools-tasks.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const CATALOG = join(root, "tests/fixtures/deferred-tools-catalog.ts");
const INDEX = join(root, "extensions/deferred-tools/index.ts");
const TIMEOUT_MS = 6 * 60_000;
export const ARMS = ["deferred", "index", "direct"] as const;
export type Arm = (typeof ARMS)[number];
export type Model = { id: string; thinking?: string };
export type Row = {
  model: string; arm: Arm; task: string; run: number; pass: boolean; found: boolean; searches: string[];
  ran: string[]; cost: number; seconds: number; error?: string;
};
type Log = { ev: string; tool?: string; input?: Record<string, unknown>; params?: Record<string, unknown>; text?: string };

export function presetModels(roles: any): Model[] {
  const found = new Map<string, Model>();
  for (const profile of Object.values<any>(roles.profiles ?? {}))
    for (const preset of Object.values<any>(profile.presets ?? {}))
      for (const role of [preset.main, ...Object.values<any>(preset.roles ?? {})]) {
        const id = role?.provider && role?.model ? `${role.provider}/${role.model}` : undefined;
        if (id && !found.has(id)) found.set(id, { id, thinking: role.thinking });
      }
  return [...found.values()];
}

export function parseModel(text: string): Model {
  const [id, thinking] = text.split(":");
  if (!id.includes("/")) throw new Error(`Name models as provider/model[:thinking]: ${text}`);
  return { id, thinking };
}

// Discovery: every expected tool ran. A pass also needs the reply, files and arguments to hold what the mocks returned.
export function grade(task: Task, log: Log[], reply: string, files: Record<string, string>) {
  const ran = log.filter(r => r.ev === "mock_exec").map(r => r.tool!);
  const found = task.expect.every(tool => ran.includes(tool));
  const answered = (task.answer ?? []).every(text => reply.toLowerCase().includes(text.toLowerCase()));
  const written = Object.entries(task.files ?? {}).every(([file, needles]) => needles.every(n => (files[file] ?? "").includes(n)));
  const argued = Object.entries(task.args ?? {}).every(([tool, want]) => log.some(r => r.ev === "mock_exec" && r.tool === tool
    && Object.entries(want).every(([key, text]) => String(r.params?.[key] ?? "").includes(text))));
  const searches = log.filter(r => r.ev === "tool_call" && r.tool === "tool_search").map(r => String(r.input?.query ?? ""));
  return { found, pass: found && answered && written && argued, ran, searches };
}

// The last assistant text, total cost, and the provider error if no turn succeeded.
export function outcome(events: string) {
  let reply = "", cost = 0, error: string | undefined, succeeded = false;
  for (const line of events.split("\n")) {
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
    const message = event.message;
    cost += message.usage?.cost?.total ?? 0;
    if (message.stopReason === "error") error ??= String(message.errorMessage ?? "error").slice(0, 300);
    else succeeded = true;
    const text = (message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    if (text.trim()) reply = text;
  }
  return { reply, cost, error: succeeded ? undefined : error ?? "no reply" };
}

export function report(rows: readonly Row[]): string {
  const valid = rows.filter(r => !r.error), out: string[] = [];
  const models = [...new Set(rows.map(r => r.model))], tasks = TASKS.filter(t => valid.some(r => r.task === t.id));
  const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : "-");
  const needing = (r: Row) => TASKS.find(t => t.id === r.task)!.kind !== "control";
  out.push("Found the needed tool (tasks that need one), passed (all tasks), searches per run");
  out.push(["model".padEnd(28), ...ARMS.map(a => a.padStart(22))].join(""));
  for (const model of models) {
    const cells = ARMS.map(arm => {
      const of = valid.filter(r => r.model === model && r.arm === arm), need = of.filter(needing);
      if (!of.length) return "-".padStart(22);
      const searches = of.reduce((n, r) => n + r.searches.length, 0) / of.length;
      return `${pct(need.filter(r => r.found).length, need.length)} ${pct(of.filter(r => r.pass).length, of.length)} ${searches.toFixed(1)}`.padStart(22);
    });
    out.push([model.padEnd(28), ...cells].join(""));
  }
  out.push("", "Failures by task (model: arms)");
  for (const task of tasks) {
    const failed = valid.filter(r => r.task === task.id && !r.pass);
    if (!failed.length) continue;
    const byModel = models.map(m => [m, failed.filter(r => r.model === m).map(r => r.arm)] as const).filter(([, arms]) => arms.length);
    out.push(`  ${task.id} (${task.kind}): ${byModel.map(([m, arms]) => `${m.split("/")[1]}: ${arms.join(",")}`).join("; ")}`);
  }
  const controls = valid.filter(r => !needing(r) && r.searches.length).length;
  out.push("", `Control runs that searched anyway: ${controls}`);
  out.push("", "Per run: cost, seconds");
  for (const arm of ARMS) {
    const of = valid.filter(r => r.arm === arm);
    if (of.length) out.push(`  ${arm.padEnd(9)} $${(of.reduce((n, r) => n + r.cost, 0) / of.length).toFixed(4)}  ${(of.reduce((n, r) => n + r.seconds, 0) / of.length).toFixed(1)}s  (${of.length} runs)`);
  }
  const errors = new Map<string, string>();
  for (const r of rows) if (r.error && !errors.has(r.model)) errors.set(r.model, r.error);
  if (errors.size) out.push("", "Not scored, the provider refused every turn:", ...[...errors].map(([m, e]) => `  ${m}: ${e}`));
  out.push("", `Total spent: $${rows.reduce((n, r) => n + r.cost, 0).toFixed(2)}`);
  return out.join("\n");
}

function runOne(model: Model, arm: Arm, task: Task, run: number, out: string, keep: boolean): Promise<Row> {
  const name = `${model.id.replace("/", "_")}__${arm}__${task.id}__r${run}`, dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "deferred-tools-eval-"));
  for (const [file, text] of Object.entries(WORKSPACE)) writeFileSync(join(work, file), text);
  const args = [
    "--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "-na",
    "-e", CATALOG, ...(arm === "direct" ? [] : ["-e", "builtin:tool-search"]),
    // The index arm turns tool_search on the way users get it: through the extension, not --tools.
    ...(arm === "deferred" ? ["--tools", "+tool_search"] : arm === "index" ? ["-e", INDEX] : []),
    "--model", model.id, ...(model.thinking ? ["--thinking", model.thinking] : []), task.prompt,
  ];
  const env = { ...process.env, EVAL_EXPOSURE: arm === "direct" ? "direct" : "deferred", EVAL_LOG: join(dir, "log.jsonl") };
  for (const key of ["PI_REX_CHILD", "PI_WORKFLOW_CHILD_CONFIG"]) delete env[key];
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn("pi", args, { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    let events = "", stderr = "";
    child.stdout.on("data", d => (events += d));
    child.stderr.on("data", d => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.on("error", error => (stderr += String(error)));
    child.on("close", () => {
      clearTimeout(timer);
      writeFileSync(join(dir, "events.jsonl"), events);
      if (stderr) writeFileSync(join(dir, "stderr.txt"), stderr);
      const log: Log[] = existsSync(join(dir, "log.jsonl")) ? readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
      const files = Object.fromEntries(Object.keys(task.files ?? {}).map(f => [f, existsSync(join(work, f)) ? readFileSync(join(work, f), "utf8") : ""]));
      const { reply, cost, error } = outcome(events);
      const graded = grade(task, log, reply, files);
      writeFileSync(join(dir, "reply.md"), reply);
      if (!keep) rmSync(work, { recursive: true, force: true });
      resolve({ model: model.id, arm, task: task.id, run, pass: graded.pass, found: graded.found, searches: graded.searches, ran: graded.ran, cost, seconds: (Date.now() - started) / 1000, ...(error ? { error } : {}) });
    });
  });
}

async function main() {
  const usage = "Usage: pm-deferred-tools-eval [--models provider/model[:thinking],...] [--arms deferred,index,direct] [--tasks id,...] [--runs 1] [--jobs 8] [--budget 15] [--out DIR] [--keep]\n       pm-deferred-tools-eval --report DIR";
  const fail = (message: string): never => { console.error(`${message}\n${usage}`); process.exit(2); };
  const argv = process.argv.slice(2), options: Record<string, string> = {};
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--keep") keep = true;
    else if (["--models", "--arms", "--tasks", "--runs", "--jobs", "--budget", "--out", "--report"].includes(argv[i]) && argv[i + 1]) options[argv[i].slice(2)] = argv[++i];
    else fail(`Unknown option: ${argv[i]}`);
  }
  const results = (dir: string) => join(dir, "results.jsonl");
  const load = (dir: string): Row[] => existsSync(results(dir)) ? readFileSync(results(dir), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  if (options.report) { console.log(report(load(options.report))); return; }

  const models = options.models ? options.models.split(",").map(parseModel) : presetModels(JSON.parse(readFileSync(join(root, "roles.json"), "utf8")));
  const arms = (options.arms ?? ARMS.join(",")).split(",") as Arm[];
  const tasks = options.tasks ? TASKS.filter(t => options.tasks.split(",").includes(t.id)) : TASKS;
  const runs = Number(options.runs ?? 1), jobs = Number(options.jobs ?? 8), budget = Number(options.budget ?? 15);
  if (arms.some(a => !ARMS.includes(a))) fail(`Arms are ${ARMS.join(", ")}.`);
  if (!tasks.length || !(runs > 0) || !(jobs > 0) || !(budget > 0)) fail("Nothing to run.");
  if (spawnSync("pi", ["--version"], { encoding: "utf8" }).error) fail("Pi is not installed.");
  const out = options.out ?? mkdtempSync(join(tmpdir(), "deferred-tools-results-"));
  mkdirSync(out, { recursive: true });

  // Rerunning with the same --out continues; whole rounds first, so a budget stop leaves runs even.
  const done = load(out), key = (m: string, a: string, t: string, r: number) => `${m} ${a} ${t} ${r}`;
  const seen = new Set(done.map(r => key(r.model, r.arm, r.task, r.run)));
  const queue: [Model, Arm, Task, number][] = [];
  for (let run = 1; run <= runs; run++) for (const m of models) for (const a of arms) for (const t of tasks)
    if (!seen.has(key(m.id, a, t.id, run))) queue.push([m, a, t, run]);
  let spent = done.reduce((n, r) => n + r.cost, 0);
  console.error(`${queue.length} runs on ${models.map(m => m.id).join(", ")}; $${spent.toFixed(2)} spent of $${budget}; results in ${out}`);
  await Promise.all(Array.from({ length: jobs }, async () => {
    for (let job = queue.shift(); job && spent < budget; job = queue.shift()) {
      const row = await runOne(...job, out, keep);
      spent += row.cost;
      appendFileSync(results(out), `${JSON.stringify(row)}\n`);
      console.error(`${row.error ? "ERR " : row.pass ? "pass" : "FAIL"} ${row.model} ${row.arm} ${row.task} r${row.run} ${row.seconds.toFixed(0)}s`);
    }
  }));
  if (queue.length) console.error(`Stopped at the budget with ${queue.length} runs not started.`);
  console.log(report(load(out)));
}

if (import.meta.main) await main();
