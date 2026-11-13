// Explicit live check: runs real Pi with a scripted slow agent and summarizer, with and
// without the compaction extension. No model, network or credentials.
// node tests/fixtures/compaction-smoke.ts [--json] [--keep]
// Reports how long each compaction blocked the run, which summaries were requested at
// which thinking level, and whether the context after compaction is intact. Exits 1
// when the extension's summary did not commit, as after a change to Pi's compact().
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUMMARY_MS, TURN_MS, TURNS } from "./compaction-script.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const json = process.argv.includes("--json"), keep = process.argv.includes("--keep");
if (spawnSync("pi", ["--version"]).error) { console.error("Pi is not installed"); process.exit(2); }
const TIMEOUT_MS = 60_000;
// Threshold 26,000 tokens; the extension's band starts 8,192 below it.
const SETTINGS = { compaction: { reserveTokens: 4000, keepRecentTokens: 3000 }, retry: { baseDelayMs: 20, maxAgentDelayMs: 50 } };

function runPi(dir: string, env: Record<string, string>, args: string[]) {
  return new Promise<{ events: any[]; hung: boolean; code: number | null; stderr: string }>(done => {
    const child = spawn("pi", args, { cwd: join(dir, "cwd"), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const events: any[] = [];
    let partial = "", stderr = "", hung = false;
    const timer = setTimeout(() => { hung = true; child.kill("SIGKILL"); }, TIMEOUT_MS);
    // Events are stamped as they arrive, to time compaction from the outside.
    child.stdout.on("data", chunk => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop()!;
      for (const line of lines.filter(Boolean)) { try { events.push({ at: Date.now(), ...JSON.parse(line) }); } catch { /* not an event */ } }
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => { clearTimeout(timer); done({ events, hung, code, stderr }); });
  });
}

async function check(variant: string, extensions: string[]) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-compaction-")));
  try {
    const agentDir = join(dir, "agent"), sessions = join(dir, "sessions"), log = join(dir, "requests.jsonl");
    for (const path of [agentDir, sessions, join(dir, "cwd")]) await mkdir(path, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(SETTINGS));
    const args = ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-builtin-tools",
      "--session-dir", sessions, "-e", join(root, "tests/fixtures/compaction-provider.ts"), ...extensions.flatMap(path => ["-e", join(root, path)]),
      "--model", "compaction/fixture", "--thinking", "xhigh", "--mode", "json", "-p", "Read the files."];
    const run = await runPi(dir, { PI_CODING_AGENT_DIR: agentDir, PI_COMPACTION_LOG: log }, args);
    const records = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const file = (await readdir(sessions, { recursive: true })).find(name => name.endsWith(".jsonl"));
    const entries = file ? (await readFile(join(sessions, file), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const starts = run.events.filter(e => e.type === "compaction_start"), ends = run.events.filter(e => e.type === "compaction_end");
    const blocked = starts.map((start, i) => (ends[i]?.at ?? NaN) - start.at);
    const summaries = records.filter(r => r.t === "summary");
    const firstCompaction = starts[0]?.at ?? Infinity;
    const agents = records.filter(r => r.t === "agent");
    const afterCompaction = agents.filter(r => r.summarized);
    const compactions = entries.filter(e => e.type === "compaction");
    const byId = new Map(entries.map(e => [e.id, e]));
    const reply = run.events.filter(e => e.type === "message_end" && e.message?.role === "assistant").at(-1)?.message;
    return {
      variant,
      settled: !run.hung && run.events.some(e => e.type === "agent_settled"),
      finished: reply?.stopReason === "stop" && agents.at(-1)?.reads === TURNS,
      compactions: starts.map(e => e.reason),
      blockedMs: blocked,
      errors: ends.map(e => e.errorMessage).filter(Boolean),
      summaries: summaries.map(r => ({ reasoning: r.reasoning ?? "off", beforeThreshold: r.at < firstCompaction })),
      peakTokens: Math.max(0, ...agents.map(r => r.tokens)),
      tokensAfter: afterCompaction[0]?.tokens,
      kept: compactions.map(c => ({ fromExtension: Boolean(c.fromHook), firstKept: byId.get(c.firstKeptEntryId)?.message?.role ?? "missing" })),
      stderr: run.stderr.trim().slice(0, 300) || undefined,
      dir: keep ? dir : undefined,
    };
  } finally { if (!keep) await rm(dir, { recursive: true, force: true }); }
}

// The extension passes positional arguments to Pi's internal compact() through `as any`.
// Were an upgrade to move one, the background summary would fail without a word and every
// compaction would fall back to Pi's default after a wasted attempt. These are the signs.
function problems(r: Awaited<ReturnType<typeof check>>, extension: boolean) {
  const found: string[] = [];
  if (!r.settled || !r.finished) found.push("the run did not finish");
  if (!r.compactions.length) found.push("nothing was compacted");
  if (r.errors.length) found.push(`compaction failed: ${r.errors.join("; ")}`);
  if (!extension) return found;
  if (!r.kept.every(k => k.fromExtension)) found.push("a compaction used Pi's default summary, not the extension's");
  if (!r.summaries.every(s => s.reasoning === "low")) found.push(`summaries ran at ${r.summaries.map(s => s.reasoning).join(", ")} thinking, not low`);
  if (!r.summaries.some(s => s.beforeThreshold)) found.push("no summary was prepared in the background");
  return found;
}

const rows = [await check("pi alone", []), await check("with compaction", ["extensions/compaction/index.ts"])];
const failures = rows.flatMap((r, i) => problems(r, i === 1).map(problem => `${r.variant}: ${problem}`));
for (const failure of failures) console.error(`FAILED ${failure}`);
if (failures.length) process.exitCode = 1;
if (json) console.log(JSON.stringify(rows, null, 2));
else {
  console.log(`Agent turns take ${TURN_MS}ms, a summary takes ${SUMMARY_MS}ms; thinking is xhigh.`);
  for (const r of rows) {
    console.log(`\n${r.variant}: ${r.settled ? "settled" : "DID NOT SETTLE"}, ${r.finished ? "finished all reads" : "did not finish"}`);
    console.log(`  compactions: ${r.compactions.map((reason, i) => `${reason} blocked ${r.blockedMs[i]}ms`).join(", ") || "none"}`);
    console.log(`  summaries: ${r.summaries.map(s => `${s.reasoning}${s.beforeThreshold ? " (in background)" : ""}`).join(", ") || "none"}`);
    console.log(`  context: peak ${r.peakTokens}, first request after compaction ${r.tokensAfter ?? "-"}`);
    console.log(`  kept: ${r.kept.map(k => `from ${k.firstKept}${k.fromExtension ? " (extension)" : ""}`).join(", ") || "-"}`);
    for (const e of r.errors) console.log(`  error: ${e}`);
    if (r.stderr) console.log(`  stderr: ${r.stderr}`);
    if (r.dir) console.log(`  kept at ${r.dir}`);
  }
}
