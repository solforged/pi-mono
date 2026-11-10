// Profiles saved Pi sessions offline: where cost goes, what tool output is
// carried through later requests, why the prompt cache was rewritten, and how
// much each candidate feature could save (docs/measuring.md). Reads session
// files only; no model calls, no network, no writes.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BYTES_PER_TOKEN = 4; // Until a model has enough turns to calibrate; the estimate /prompt-size uses.
const DROP_MIN_PROMPT = 20_000, IDLE_MS = 5 * 60_000;

export type Entry = Record<string, any>;
export type Call = { id: string; name: string; args: Record<string, any> };
export type Turn = {
  prompt: number; prompts: number; model: string; ts: number; calls: Call[]; text: boolean; stop: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  read: number; first: number; // Dollars per token: re-reading from cache, and sending for the first time.
};
export type Result = {
  kind?: undefined; tool: string; args: Record<string, any>; text: string; bytes: number; error: boolean;
  start: number; end: number; // Carried by turns [start, end).
};
export type Drop = { cause: string; detail: string; rewritten: number; extra: number; gapMin: number };
// Everything else in the context: the prompt and tool declarations, what the user and the model wrote.
export type Part = { kind: "prompt and tools" | "user and injected" | "assistant text" | "thinking" | "tool-call arguments" | "summaries"; bytes: number; start: number; end: number };
export type Timeline = { turns: Turn[]; results: Result[]; parts: Part[]; drops: Drop[]; prompts: number[]; bytesPerToken: Record<string, number> };

export function parse(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch { /* A torn final record. */ }
  }
  return entries;
}

// The branch a resume would continue: the ancestry of the last entry.
export function mainBranch(entries: readonly Entry[]): Entry[] {
  const byId = new Map<string, Entry>();
  for (const e of entries) if (e.id) byId.set(e.id, e);
  const branch: Entry[] = [], seen = new Set<string>();
  for (let leaf = entries.findLast(e => e.id); leaf && !seen.has(leaf.id); leaf = byId.get(leaf.parentId)) { seen.add(leaf.id); branch.push(leaf); }
  return branch.reverse();
}

const textOf = (content: unknown) => Array.isArray(content) ? content.filter(c => c?.type === "text").map(c => c.text).join("\n") : typeof content === "string" ? content : "";

export function timeline(branch: readonly Entry[]): Timeline {
  const turns: Turn[] = [], results: Result[] = [], parts: Part[] = [], drops: Drop[] = [], prompts: number[] = [];
  const calls = new Map<string, Call>(), entryOf = new Map<Result | Part, number>(), index = new Map<string, number>();
  const part = (kind: Part["kind"], bytes: number, i: number) => { if (bytes > 0) { const p: Part = { kind, bytes, start: turns.length, end: Infinity }; parts.push(p); entryOf.set(p, i); } };
  const size = (value: unknown) => value == null ? 0 : Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
  const prices = new Map<string, { read: number; first: number }>();
  let between: Entry[] = [], run = 0;
  branch.forEach((e, i) => { if (e.id) index.set(e.id, i); });
  branch.forEach((e, i) => {
    const m = e.message;
    if (e.type === "compaction") {
      // Entries before firstKeptEntryId leave the context; the rest stay.
      const kept = index.get(e.firstKeptEntryId) ?? i;
      for (const r of [...results, ...parts]) if (r.end === Infinity && r.kind !== "prompt and tools" && entryOf.get(r)! < kept) r.end = turns.length;
      part("summaries", size(e.summary), i);
    }
    if (e.type === "custom_message") part("user and injected", size(e.content), i);
    if (e.type !== "message" || !m) { between.push(e); return; }
    if (m.role === "user") { if (run) prompts.push(run); run = 0; part("user and injected", size(textOf(m.content)), i); }
    if (m.role === "system") part("prompt and tools", size(m.content) + size(Object.values(m.sections ?? {}).filter(Boolean).join("\n")) + size(m.toolsAdded), i);
    if (m.role === "assistant") {
      const u = m.usage ?? {}, c = u.cost ?? {};
      const known = prices.get(m.model) ?? { read: 0, first: 0 };
      const read = u.cacheRead > 0 ? (c.cacheRead ?? 0) / u.cacheRead : known.read;
      const first = u.cacheWrite > 0 ? (c.cacheWrite ?? 0) / u.cacheWrite : u.input > 0 ? (c.input ?? 0) / u.input : known.first;
      prices.set(m.model, { read, first });
      const turn: Turn = {
        prompt: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), prompts: prompts.length, model: m.model, ts: Date.parse(e.timestamp),
        calls: [], text: false, stop: m.stopReason, read, first,
        cost: { input: c.input ?? 0, output: c.output ?? 0, cacheRead: c.cacheRead ?? 0, cacheWrite: c.cacheWrite ?? 0 },
      };
      for (const block of m.content ?? []) {
        if (block.type === "toolCall") { const call = { id: block.id, name: block.name, args: block.arguments ?? {} }; turn.calls.push(call); calls.set(call.id, call); }
        else if (block.type === "text" && block.text?.trim()) turn.text = true;
      }
      const prev = turns.at(-1);
      if (prev && prev.prompt > DROP_MIN_PROMPT && (u.cacheRead ?? 0) < prev.prompt * 0.5) drops.push(classify(prev, turn, u, between));
      turns.push(turn); run++; between = [];
      // The model's own output enters the context of the next turn.
      for (const block of m.content ?? []) {
        if (block.type === "toolCall") part("tool-call arguments", size(block.arguments) + size(block.name), i);
        else if (block.type === "text") part("assistant text", size(block.text), i);
        else if (block.type === "thinking") part("thinking", size(block.thinking), i);
      }
      return;
    }
    between.push(e);
    if (m.role === "toolResult") {
      const call = calls.get(m.toolCallId), text = textOf(m.content);
      const result: Result = { tool: m.toolName ?? call?.name ?? "?", args: call?.args ?? {}, text, bytes: Buffer.byteLength(text), error: Boolean(m.isError), start: turns.length, end: Infinity };
      results.push(result); entryOf.set(result, i);
    }
  });
  if (run) prompts.push(run);
  for (const r of [...results, ...parts]) if (r.end === Infinity) r.end = turns.length;
  return { turns, results, parts, drops, prompts, bytesPerToken: {} };
}

function classify(prev: Turn, turn: Turn, usage: any, between: readonly Entry[]): Drop {
  const gap = turn.ts - prev.ts, patch = between.find(e => e.message?.role === "system")?.message;
  const names = (list: any[] | undefined) => (list ?? []).map(t => t.name).join(",");
  let cause = "unexplained", detail = "";
  if (between.some(e => e.type === "compaction")) cause = "compaction";
  else if (prev.model !== turn.model) { cause = "model switch"; detail = `${prev.model} → ${turn.model}`; }
  else if (gap > IDLE_MS) cause = gap > 60 * 60_000 ? "idle over 1h" : "idle 5m–1h";
  else if (between.some(e => e.type === "thinking_level_change")) cause = "thinking level";
  // A prompt or tool patch usually keeps the cache, so it is context for an unexplained miss, not a cause.
  else if (patch) detail = ["after a patch:", names(patch.toolsAdded) && `+${names(patch.toolsAdded)}`, names(patch.toolsRemoved) && `-${names(patch.toolsRemoved)}`, Object.entries(patch.sections ?? {}).map(([k, v]) => v === null ? `-${k}` : k).join(",")].filter(Boolean).join(" ");
  const rewritten = (usage.cacheWrite ?? 0) + (usage.input ?? 0);
  // What the miss cost beyond a hit: the rewritten prefix at the first-send price instead of the read price.
  return { cause, detail, rewritten, extra: Math.min(rewritten, prev.prompt) * Math.max(0, turn.first - turn.read), gapMin: gap / 60_000 };
}

// Bytes per token for each model, measured where a turn's prompt grew by exactly what was added since the
// last one. Tokenizers differ by a factor of two, so a fixed estimate misprices everything below.
export function calibrate(timelines: readonly Timeline[]): Record<string, number> {
  const sums: Record<string, { bytes: number; tokens: number; n: number }> = {};
  for (const t of timelines) {
    const added = new Map<number, number>();
    for (const x of [...t.results, ...t.parts]) added.set(x.start, (added.get(x.start) ?? 0) + x.bytes);
    t.turns.forEach((turn, i) => {
      const prev = t.turns[i - 1], bytes = added.get(i) ?? 0, grown = prev ? turn.prompt - prev.prompt : 0;
      // Skip model switches, compactions, archive frames and anything else that is not plain growth.
      if (!prev || prev.model !== turn.model || grown <= 50 || bytes < 200 || bytes / grown > 12 || bytes / grown < 1) return;
      const sum = sums[turn.model] ??= { bytes: 0, tokens: 0, n: 0 };
      sum.bytes += bytes; sum.tokens += grown; sum.n++;
    });
  }
  const rates: Record<string, number> = {};
  for (const [model, sum] of Object.entries(sums)) if (sum.n >= 20) rates[model] = sum.bytes / sum.tokens;
  for (const t of timelines) t.bytesPerToken = rates;
  return rates;
}

// Dollars a result cost by being sent once and then re-read on every later turn.
export function carried(t: Timeline, r: Result | Part, from = r.start, to = r.end): number {
  let dollars = 0;
  for (let i = from; i < Math.min(to, t.turns.length); i++) {
    const turn = t.turns[i];
    dollars += r.bytes / (t.bytesPerToken[turn.model] ?? BYTES_PER_TOKEN) * (i === r.start ? turn.first : turn.read);
  }
  return dollars;
}

// The program a bash command runs, past `cd dir &&` and environment assignments.
export function program(command: unknown): string {
  let rest = String(command ?? "").trim();
  for (let prev = ""; prev !== rest;) { prev = rest; rest = rest.replace(/^cd\s+[^&;|]+(&&|;)\s*/, "").replace(/^[A-Za-z_]\w*=\S*\s+/, ""); }
  return (rest.split(/[\s|;&<>()]/)[0] ?? "").split("/").pop() ?? "";
}
const FILE_READERS = new Set(["cat", "sed", "head", "tail", "nl", "bat", "less"]);
const SEARCHERS = new Set(["grep", "rg", "ls", "find", "fd", "tree", "wc", "stat", "file", "which", "jq", "awk", "sort", "uniq", "strings", "diff"]);
const GIT_READS = /^git\s+(?:-C\s+\S+\s+|--no-pager\s+)*(log|show|diff|status|blame|grep|ls-files|rev-parse|branch|remote|describe|shortlog|worktree list|stash list)\b/;
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "artifact_read", "session_search", "session_read", "web_search"]);
export function readOnly(call: Call): boolean {
  if (READ_TOOLS.has(call.name)) return true;
  if (call.name !== "bash") return false;
  const command = String(call.args.command ?? "");
  if (/(^|[^0-9&])>{1,2}(?!&)\s*(?!\/dev\/null)\S/.test(command) || /\b(sed\s+(-\w+\s+)*-i|rm|mv|cp|mkdir|touch|tee|chmod|git\s+(add|commit|checkout|switch|reset|restore|push|pull|merge|rebase|stash(?! list)|cherry-pick|clean|apply|worktree (add|remove)))\b|-delete\b|-exec\b/.test(command)) return false;
  const first = program(command), rest = command.trim().replace(/^cd\s+[^&;|]+(&&|;)\s*/, "");
  return FILE_READERS.has(first) || SEARCHERS.has(first) || GIT_READS.test(rest);
}

const CHECK = /\b(tsc\b|node\s+--test|mise\s+run\s+\S*(test|check|lint)|(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check|build)|cargo\s+(check|test|build|clippy)|go\s+(test|vet|build)|pytest|ruff|mypy|pyright|eslint|biome|swift\s+(build|test)|xcodebuild|make\s+(test|check|lint))/;
const STATIC = /error TS\d+|SyntaxError|ERR_[A-Z_]+|ReferenceError|is not defined|Cannot find (module|name)|does not exist on type|not assignable to|Unexpected token|unexpected (token|end)|error\[E\d+\]|undefined: |cannot use .* as|ParseError|IndentationError/;
const EMPTY = /^(\(no output\)|no (matches|files|results)( found)?\.?|)(\s*Command exited with code 1)?$/i;
const failed = (r: Result) => r.error || /Command exited with code [1-9]/.test(r.text);
const readPath = (r: Result) => String(r.args.path ?? r.args.file_path ?? "");
const wholeFile = (r: Result) => !r.args.offset && !r.args.limit && !/\[(Showing lines|\d+ more lines|Output archived|truncated)/i.test(r.text.slice(-400));

export type Sizing = { candidate: string; count: number; dollars: number; note: string };
export type Report = {
  sessions: number; first?: number; last?: number; calls: number; total: number; auxiliary: number; compactions: number;
  cost: Turn["cost"]; models: Record<string, number>; stops: Record<string, number>; callsPerTurn: number[];
  prompts: { n: number; median: number; mean: number; p90: number; max: number };
  tools: Record<string, { calls: number; bytes: number; errors: number; carried: number }>;
  bash: Record<string, { calls: number; bytes: number }>;
  drops: Record<string, { count: number; rewritten: number; extra: number; details: string[] }>;
  validation: Record<string, number>; context: Record<string, number>; bytesPerToken: Record<string, number>;
  // Turn endings Pi leaves to the user, and the notes extensions/recover wrote about them.
  endings: { empty: number; cut: number; repeats: number; recovered: Record<string, number> };
  sizings: Sizing[];
};

export function profile(sessions: readonly Entry[][]): Report {
  const report: Report = {
    sessions: sessions.length, calls: 0, total: 0, auxiliary: 0, compactions: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    models: {}, stops: {}, callsPerTurn: [0, 0, 0, 0], prompts: { n: 0, median: 0, mean: 0, p90: 0, max: 0 }, tools: {}, bash: {}, drops: {}, validation: {}, context: {}, bytesPerToken: {}, endings: { empty: 0, cut: 0, repeats: 0, recovered: {} }, sizings: [],
  };
  const runs: number[] = [];
  const size = (candidate: string, note: string): Sizing => { const s = { candidate, count: 0, dollars: 0, note }; report.sizings.push(s); return s; };
  const supersede = size("Blank superseded reads", "an older read of a path, once a later whole-file read exists; net of re-sending what followed it");
  const supersedeWarm = size("…only within an 8k-token tail", "the same, restricted to omp's cache-warm rule");
  const rereads = size("All re-reads (ceiling)", "carried cost of every read of a path that was read before");
  const empty = size("Elide empty results", "zero-match and no-output results blanked from the next turn on");
  const viaBash = size("Bash file reads", "cat, sed, head, tail and nl output; a redirect changes the tool, not the bytes");
  const dupBash = size("…that repeat a `read`", "bash file reads naming a path the read tool had already returned");
  const batch = size("Batch read-only turns (ceiling)", "cache reads of single-call read-only turns that directly follow another one");
  const checks = size("Post-edit check", "failed checks after edits that a compiler or linter would have reported");
  const lateChecks = size("…found 3+ turns after the edit", "the same, where the model had moved on before checking");

  const timelines = sessions.map(entries => timeline(mainBranch(entries)));
  report.bytesPerToken = calibrate(timelines);
  sessions.forEach((entries, n) => {
    for (const e of entries) {
      const usage = e.type === "message" ? (e.message?.role === "assistant" || e.message?.role === "toolResult" ? e.message.usage : undefined) : e.type === "custom" ? e.data?.usage : e.usage;
      const total = usage?.cost?.total ?? 0;
      report.total += total;
      if (e.type === "message" && e.message?.role === "assistant") report.calls++; else report.auxiliary += total;
      if (e.type === "compaction") report.compactions++;
      if (e.type === "custom_message" && e.customType === "recover") report.endings.recovered[e.details?.kind ?? "?"] = (report.endings.recovered[e.details?.kind ?? "?"] ?? 0) + 1;
      const ts = Date.parse(e.timestamp);
      if (ts) { report.first = Math.min(report.first ?? ts, ts); report.last = Math.max(report.last ?? ts, ts); }
    }
    const t = timelines[n];
    runs.push(...t.prompts);
    let last = "", streak = 0;
    t.turns.forEach((turn, i) => {
      if (!turn.calls.length && !turn.text && turn.stop === "stop") report.endings.empty++;
      if (!turn.calls.length && turn.stop === "length") report.endings.cut++;
      // The same calls returning the same results as the turn before: the third in a row is a loop.
      const key = turn.calls.length ? JSON.stringify([turn.calls.map(c => [c.name, c.args]), t.results.filter(r => r.start === i + 1).map(r => [r.error, r.text])]) : "";
      streak = key && key === last ? streak + 1 : 1; last = key;
      if (streak >= 3) report.endings.repeats++;
      for (const k of Object.keys(report.cost) as (keyof Turn["cost"])[]) report.cost[k] += turn.cost[k];
      report.models[turn.model] = (report.models[turn.model] ?? 0) + 1;
      report.stops[turn.stop] = (report.stops[turn.stop] ?? 0) + 1;
      report.callsPerTurn[Math.min(turn.calls.length, 3)]++;
      const prev = t.turns[i - 1];
      const single = (x: Turn | undefined) => x?.calls.length === 1 && !x.text && readOnly(x.calls[0]);
      if (prev && prev.prompts === turn.prompts && single(prev) && single(turn)) { batch.count++; batch.dollars += turn.cost.cacheRead; }
    });
    for (const d of t.drops) {
      const row = report.drops[d.cause] ??= { count: 0, rewritten: 0, extra: 0, details: [] };
      row.count++; row.rewritten += d.rewritten; row.extra += d.extra;
      if (d.detail && !row.details.includes(d.detail)) row.details.push(d.detail);
    }
    for (const p of t.parts) report.context[p.kind] = (report.context[p.kind] ?? 0) + carried(t, p);
    const seen = new Map<string, Result[]>(), viaRead = new Set<string>();
    let lastEdit = -1, edited = false;
    for (const r of t.results) {
      const row = report.tools[r.tool] ??= { calls: 0, bytes: 0, errors: 0, carried: 0 };
      row.calls++; row.bytes += r.bytes; row.carried += carried(t, r); if (r.error) row.errors++;
      report.context["tool results"] = (report.context["tool results"] ?? 0) + carried(t, r);
      const invalid = /^Validation failed for tool "([^"]+)":\s*-?\s*(\w+)/.exec(r.text);
      if (invalid) report.validation[`${invalid[1]}.${invalid[2]}`] = (report.validation[`${invalid[1]}.${invalid[2]}`] ?? 0) + 1;
      if (!r.error && EMPTY.test(r.text.trim()) && (r.tool !== "bash" || SEARCHERS.has(program(r.args.command)))) { empty.count++; empty.dollars += carried(t, r, r.start + 1); }

      if (r.tool === "read" && !r.error) {
        const path = readPath(r), earlier = seen.get(path) ?? [];
        if (earlier.length) { rereads.count++; rereads.dollars += carried(t, r); }
        if (wholeFile(r)) for (const old of earlier) {
          if (old.end <= r.start) continue; // Compacted away already.
          // Blanking `old` re-sends everything after it once, at the first-send price.
          const at = t.turns[r.start], suffix = at ? Math.max(0, at.prompt - (t.turns[old.start]?.prompt ?? at.prompt)) : 0;
          const net = carried(t, old, r.start) - (at ? suffix * Math.max(0, at.first - at.read) : 0);
          if (net > 0) { supersede.count++; supersede.dollars += net; }
          if (net > 0 && suffix <= 8000) { supersedeWarm.count++; supersedeWarm.dollars += net; }
          old.end = r.start;
        }
        seen.set(path, [...earlier.filter(old => old.end > r.start), r]); viaRead.add(path);
      }
      if (r.tool === "edit" || r.tool === "write") { if (!r.error) { lastEdit = r.start; edited = true; } }
      if (r.tool !== "bash") continue;
      const command = String(r.args.command ?? ""), first = program(command);
      const b = report.bash[first] ??= { calls: 0, bytes: 0 }; b.calls++; b.bytes += r.bytes;
      if (FILE_READERS.has(first) && readOnly({ id: "", name: "bash", args: r.args })) {
        viaBash.count++; viaBash.dollars += carried(t, r);
        if ([...viaRead].some(path => path && (command.includes(path) || command.includes(path.split("/").slice(-2).join("/"))))) { dupBash.count++; dupBash.dollars += carried(t, r); }
      }
      if (CHECK.test(command)) {
        if (edited && failed(r) && STATIC.test(r.text)) {
          // What reporting it at the edit would have spared: the turns in between.
          const wasted = t.turns.slice(lastEdit, r.start).reduce((sum, turn) => sum + turn.cost.cacheRead + turn.cost.output, 0);
          checks.count++; checks.dollars += wasted;
          if (r.start - lastEdit >= 3) { lateChecks.count++; lateChecks.dollars += wasted; }
        }
        edited = false;
      }
    }
  });
  runs.sort((a, b) => a - b);
  if (runs.length) report.prompts = { n: runs.length, median: runs[runs.length >> 1], mean: runs.reduce((a, b) => a + b, 0) / runs.length, p90: runs[Math.floor(runs.length * 0.9)], max: runs.at(-1)! };
  return report;
}

const short = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : "–";
const table = (rows: string[][]) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  return rows.map(r => r.map((cell, i) => i ? cell.padStart(widths[i]) : cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
};

export function render(r: Report): string {
  const day = (ms?: number) => ms ? new Date(ms).toISOString().slice(0, 10) : "?";
  const main = Object.values(r.cost).reduce((a, b) => a + b, 0), turns = r.callsPerTurn.reduce((a, b) => a + b, 0);
  const out = [`${r.sessions} sessions, ${day(r.first)} to ${day(r.last)}: ${r.calls} model calls, ${r.compactions} compactions, ${usd(r.total)} (${usd(r.auxiliary)} delegated or auxiliary).`,
    `Models: ${Object.entries(r.models).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(", ")}.`, "",
    "Cost on main branches",
    table([["cache read", usd(r.cost.cacheRead), pct(r.cost.cacheRead, main)], ["output", usd(r.cost.output), pct(r.cost.output, main)], ["cache write", usd(r.cost.cacheWrite), pct(r.cost.cacheWrite, main)], ["uncached input", usd(r.cost.input), pct(r.cost.input, main)]]), "",
    `Turns: ${pct(r.callsPerTurn[1], turns)} make one tool call, ${pct(r.callsPerTurn[2] + r.callsPerTurn[3], turns)} more, ${pct(r.callsPerTurn[0], turns)} none.`,
    `Turns per prompt: median ${r.prompts.median}, mean ${r.prompts.mean.toFixed(1)}, p90 ${r.prompts.p90}, max ${r.prompts.max} over ${r.prompts.n} prompts.`,
    `Stop reasons: ${Object.entries(r.stops).map(([k, n]) => `${k} ${n}`).join(", ")}.`, "",
    "What the prompt spend carried (sent once, then re-read every later turn)"];
  const prompt = r.cost.input + r.cost.cacheRead + r.cost.cacheWrite, attributed = Object.values(r.context).reduce((a, b) => a + b, 0);
  out.push(table([...Object.entries(r.context).sort((a, b) => b[1] - a[1]).map(([kind, dollars]) => [kind, usd(dollars), pct(dollars, prompt)]), ["images, cache misses, estimate error", usd(prompt - attributed), pct(prompt - attributed, prompt)]]), "", "Tool results");
  const bytes = Object.values(r.tools).reduce((a, t) => a + t.bytes, 0);
  out.push(table([["tool", "calls", "bytes", "share", "errors", "carried"], ...Object.entries(r.tools).sort((a, b) => b[1].carried - a[1].carried).slice(0, 10)
    .map(([name, t]) => [name, String(t.calls), short(t.bytes), pct(t.bytes, bytes), pct(t.errors, t.calls), usd(t.carried)])]), "");
  out.push("Bash by program", table([["program", "calls", "bytes"], ...Object.entries(r.bash).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8).map(([name, b]) => [name || "(none)", String(b.calls), short(b.bytes)])]), "");
  out.push("Cache rewrites (extra: what the miss cost beyond a hit)");
  const drops = Object.entries(r.drops).sort((a, b) => b[1].extra - a[1].extra);
  out.push(drops.length ? table([["cause", "count", "tokens", "extra"], ...drops.map(([cause, d]) => [d.details.length ? `${cause} (${d.details.slice(0, 2).join("; ")})` : cause, String(d.count), short(d.rewritten), usd(d.extra)])]) : "none", "");
  const notes = Object.entries(r.endings.recovered).map(([kind, n]) => `${kind} ${n}`).join(", ");
  out.push(`Turn endings left to the user: ${r.endings.empty} empty stops, ${r.endings.cut} cut at the output limit, ${r.endings.repeats} turns repeating a call and its result a third time or more. Recovery notes: ${notes || "none"}.`, "");
  const invalid = Object.entries(r.validation);
  if (invalid.length) out.push(`Argument validation failures: ${invalid.map(([k, n]) => `${k} ${n}`).join(", ")}.`, "");
  out.push("Candidate sizing (replayed against these sessions)", table([["candidate", "count", "saving", "of cost"], ...r.sizings.map(s => [s.candidate, String(s.count), usd(s.dollars), pct(s.dollars, r.total)])]));
  out.push("", ...r.sizings.map(s => `${s.candidate}: ${s.note}.`), "",
    `Dollar figures use each turn's recorded prices. Bytes per token, measured from prompt growth: ${Object.entries(r.bytesPerToken).map(([m, rate]) => `${m} ${rate.toFixed(1)}`).join(", ") || "none"}; ${BYTES_PER_TOKEN} otherwise.`);
  return out.join("\n");
}

export function sessionFiles(dir: string, since = 0): string[] {
  const files: string[] = [];
  const walk = (path: string, depth: number) => {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      if (e.isDirectory() && depth < 2) walk(join(path, e.name), depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl") && (!since || Date.parse(e.name.slice(0, 10)) >= since)) files.push(join(path, e.name));
    }
  };
  walk(dir, 0);
  return files.sort();
}

if (import.meta.main) {
  const usage = "Usage: mise run profile -- [--dir <sessions>] [--since YYYY-MM-DD] [--json]";
  let dir = process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions"), since = 0, json = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--dir" && argv[i + 1]) dir = argv[++i];
    else if (argv[i] === "--since" && Date.parse(argv[i + 1] ?? "")) since = Date.parse(argv[++i]);
    else { console.error(usage); process.exit(2); }
  }
  const report = profile(sessionFiles(dir, since).map(file => parse(readFileSync(file, "utf8"))));
  console.log(json ? JSON.stringify(report, null, 2) : render(report));
}
