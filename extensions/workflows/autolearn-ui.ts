import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isTransientError, MAX_TRANSIENT_FAILURES } from "./autoname.ts";
import { alreadyReviewed, documented, recurrence, recurringPatterns, runs, similarCore, segments, skillUse, summarizeRun, type PatternReview, type Recurrence, type Run } from "./autolearn.ts";
import { evidenceFromBranch, INVENTORY_LABEL, inventoryInput, inventorySkills, LEARNING_SYSTEM, parseCandidates, readDrafts, skillRef, stageCandidate, type Draft, type SkillSnapshot } from "./learning.ts";
import { completeRole } from "./requests.ts";
import { configSnapshot, resolveRole, type Config, type ConfigSource } from "./roles.ts";
import { readJson, saveJson, scopeRoot, withLock } from "./state.ts";
import { recordUsage } from "./usage.ts";

interface Indexed { mtimeMs: number; session: string; created: string; runs: Run[] }
export interface AutoState { version: 1; enabled?: boolean; files: Record<string, Indexed>; reviews: PatternReview[] }
const MAX_FILES = 120;
const MAX_REVIEWS = 100;
const ITEM_CHARS = 1500;
const stateFile = (root: string) => join(root, "autolearn.json");

export async function readState(root: string): Promise<AutoState> {
  const state = await readJson<AutoState>(stateFile(root), { version: 1, files: {}, reviews: [] });
  return state.version === 1 ? state : { version: 1, files: {}, reviews: [] };
}
// Every change re-reads the file under a short lock, so a toggle and a
// finishing review cannot overwrite each other.
async function updateState(root: string, change: (state: AutoState) => void): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withLock(root, "autolearn-state", async () => {
        const state = await readState(root);
        change(state);
        await saveJson(stateFile(root), state);
      });
    } catch (error) {
      if (attempt >= 20 || !/Workflow is locked/.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
export const enabledFor = (config: Config, state: AutoState) => state.enabled ?? config.learning.auto.enabled;

type Open = (path: string) => { getSessionId(): string; getHeader(): { timestamp?: string } | null; getBranch(): any[] };
/** Project session access; Pi's SessionManager in production. */
export interface Sessions { list(cwd: string): Promise<Array<{ path: string; name?: string; firstMessage?: string }>>; open: Open }
/**
 * Refresh the run index from changed project sessions. Returns the other
 * sessions' runs, keyed by file, and how many sessions were indexed in all.
 * Forks repeat their parent's entries, so a run counts only for the earliest
 * created session that holds it, and never for the current session's history.
 */
export async function indexSessions(state: AutoState, listed: Array<{ path: string }>, current: { file?: string; entryIds: Set<string> }, open: Open): Promise<{ others: Map<string, Run[]>; sessions: number }> {
  const found: Array<{ path: string; mtimeMs: number }> = [];
  for (const { path } of listed) {
    if (path === current.file) continue;
    try { found.push({ path, mtimeMs: (await stat(path)).mtimeMs }); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  const recent = found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
  const files: AutoState["files"] = {};
  for (const { path, mtimeMs } of recent) {
    const known = state.files[path];
    if (known?.mtimeMs === mtimeMs) { files[path] = known; continue; }
    let session;
    try { session = open(path); } catch { continue; } // An unreadable session is not evidence.
    files[path] = { mtimeMs, session: session.getSessionId(), created: session.getHeader()?.timestamp ?? new Date(mtimeMs).toISOString(), runs: runs(session.getBranch()) };
    // Opening parses the whole file synchronously; let input and drawing in between two.
    await new Promise((resolve) => setImmediate(resolve));
  }
  state.files = files;
  const others = new Map<string, Run[]>();
  const seen = new Set(current.entryIds);
  const byCreation = Object.keys(files).sort((a, b) => files[a].created.localeCompare(files[b].created) || a.localeCompare(b));
  for (const path of byCreation) {
    const list = files[path].runs.filter((run) => !seen.has(run.first));
    list.forEach((run) => seen.add(run.first));
    if (list.length) others.set(path, list);
  }
  return { others, sessions: Object.keys(files).length + 1 };
}

function runEntries(branch: any[], run: Run): any[] {
  const start = branch.findIndex((entry) => entry.id === run.first);
  const end = branch.findIndex((entry) => entry.id === run.last);
  return start < 0 || end < start ? [] : branch.slice(start, end + 1);
}
// The procedure lives in requests and tool calls; long outputs add little.
function evidenceText(entries: any[], session: string, budget: number): { text: string; refs: string[] } {
  let text = "";
  const refs: string[] = [];
  for (const item of evidenceFromBranch(entries, session, new Set())) {
    const line = item.text.length > ITEM_CHARS ? `${item.text.slice(0, ITEM_CHARS)}…(truncated)` : item.text;
    if (text.length + line.length + 1 > budget) break;
    text += `${line}\n`; refs.push(item.ref);
  }
  return { text, refs };
}

/** The learn provider failed in a way that says nothing about the pattern under review. */
class Outage extends Error {}

const FOCUS = `A deterministic detector, not a person, flagged this workflow because it recurred across sessions. Most recurring work needs nothing new: return [] unless capturing it would clearly save future effort or prevent a mistake the evidence shows being repeated. In order of preference: nothing; automate the mechanical steps; update an existing managed skill; create a skill only for judgment that commands cannot encode and that no existing skill or instruction already covers.`;

export function registerAutolearn(pi: ExtensionAPI, source: ConfigSource, agentDir: string, lifetime: AbortSignal, report: (ctx: ExtensionContext, text: string) => void, sessions: Sessions) {
  const child = !!(process.env.PI_REX_CHILD || process.env.PI_WORKFLOW_CHILD_CONFIG);
  let instructions = "";
  let loadedSkills: Array<{ name: string; filePath: string; description?: string }> = [];
  let session = new AbortController();
  let disabled = new AbortController(); // Aborted by /autolearn off.
  let running = false;
  let warned = false;
  let outages = 0;
  let sessionDir: string | undefined;
  // Where the previous task ended. A task is everything since, so steering
  // messages mid-run do not split it.
  let boundary: string | null | undefined;
  const considered = new Set<string>();
  pi.on("session_start", (_event, ctx) => {
    session.abort(); session = new AbortController(); considered.clear(); warned = false; outages = 0; sessionDir = undefined;
    boundary = ctx.sessionManager.getLeafId();
  });
  pi.on("session_shutdown", () => { session.abort(); });
  pi.on("before_agent_start", (event) => {
    instructions = (event.systemPromptOptions.contextFiles ?? []).map((file: { content: string }) => file.content).join("\n");
    loadedSkills = (event.systemPromptOptions.skills ?? []).map((skill: { name: string; filePath: string; description?: string }) => ({ name: skill.name, filePath: skill.filePath, description: skill.description }));
  });

  // Runs once the agent is idle, off the conversation: no prompt, tool or
  // message changes. Almost every task ends at the local checks below.
  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted || child || !ctx.hasUI || lifetime.aborted) return;
    const branch = ctx.sessionManager.getBranch();
    // null: the session was empty at start. Unknown or off-branch: fall back to the last request.
    const start = boundary ? branch.findIndex((entry: any) => entry.id === boundary) : -1;
    const task = boundary === null || start >= 0 ? branch.slice(start + 1) : segments(branch).at(-1);
    boundary = branch.at(-1)?.id ?? null;
    if (running) return;
    const run = task?.length ? summarizeRun(task) : undefined;
    if (!task || !run || considered.has(run.first)) return;
    const last = [...task].reverse().find((entry) => entry.type === "message" && entry.message?.role === "assistant");
    if (last?.message?.stopReason !== "stop") return;
    const use = skillUse(task);
    if (use.skills.length && !use.errors) return; // An existing skill handled it cleanly.
    running = true;
    const signal = AbortSignal.any([lifetime, session.signal, disabled.signal]);
    consider(ctx, task, run, use.skills, signal)
      .catch((error) => {
        if (signal.aborted || /Workflow is locked/.test(String(error)) || warned) return;
        warned = true;
        ctx.ui.notify(`Autolearn skipped a review: ${error instanceof Error ? error.message : String(error)}`, "warning");
      })
      .finally(() => { running = false; });
  });

  async function consider(ctx: ExtensionContext, task: any[], run: Run, usedSkills: string[], signal: AbortSignal) {
    const config = configSnapshot(source);
    const root = await scopeRoot(agentDir, config.profile, ctx.cwd);
    if (!enabledFor(config, await readState(root))) return;
    considered.add(run.first);
    // Shared with /learn-sessions and /curate-skills: one reviewer at a time,
    // so the pending-proposal check below stays true until staging.
    await withLock(root, "review", async () => {
      const state = await readState(root);
      const listed = await sessionPaths(ctx.cwd);
      signal.throwIfAborted();
      const { others, sessions: population } = await indexSessions(state, listed, {
        file: ctx.sessionManager.getSessionFile(),
        entryIds: new Set(ctx.sessionManager.getBranch().map((entry: any) => entry.id)),
      }, sessions.open);
      await updateState(root, (latest) => { latest.files = state.files; });
      const found = recurrence(run, others, config.learning.auto.minSessions, population);
      if (!found || documented(found.core, instructions) || alreadyReviewed(found.core, found.sessions, state.reviews)) return;
      if ((await readDrafts(root)).some((draft) => draft.status === "pending")) return; // One open question at a time.
      resolveRole(config, "learn", ctx.modelRegistry);
      // Another process may have turned it off while this one was indexing.
      if (!enabledFor(configSnapshot(source), await readState(root))) return;
      // A budget problem is configuration, not the pattern's outcome: fail
      // before recording, so raising the limit lets the pattern be reviewed.
      const skills = await skillInput(config, root);
      signal.throwIfAborted();
      // Record failures too, so a bad answer is not retried on every later task.
      // An outage says nothing about the pattern: it stays unrecorded, to be
      // reviewed when it recurs, until the provider has failed a few times.
      let staged: Draft | undefined, outcome = "nothing", failure: unknown;
      try {
        staged = await review(ctx, config, root, task, found, usedSkills, skills, signal);
        if (staged) outcome = `${staged.action} ${staged.name}`;
      } catch (error) {
        if (signal.aborted || (error instanceof Outage && ++outages < MAX_TRANSIENT_FAILURES)) throw error;
        failure = error; outcome = "failed";
      }
      const record = { core: found.core, sessions: found.sessions, at: new Date().toISOString(), outcome };
      await updateState(root, (latest) => { latest.reviews = [...latest.reviews, record].slice(-MAX_REVIEWS); });
      if (failure) throw failure;
      if (staged) {
        const what = staged.action === "automate" ? `automating ${staged.name}` : `${staged.action === "create" ? "a new skill" : `${staged.action} of`} ${staged.name}`;
        ctx.ui.notify(`Autolearn: you've repeated a workflow in ${found.sessions} sessions; it suggests ${what}. See /learn-review.`, "info");
      }
    });
  }

  // Listing parses every session of the project in full. Once it has shown where
  // they are kept, later tasks only read that directory.
  async function sessionPaths(cwd: string): Promise<Array<{ path: string }>> {
    if (sessionDir) {
      const dir = sessionDir;
      return (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).map((name) => ({ path: join(dir, name) }));
    }
    const listed = await sessions.list(cwd);
    if (listed.length) sessionDir = dirname(listed[0].path);
    return listed;
  }

  async function skillInput(config: Config, root: string): Promise<{ inventory: SkillSnapshot[]; text: string; budget: number }> {
    const inventory = await inventorySkills(root, loadedSkills);
    const text = inventoryInput(inventory, loadedSkills);
    const budget = config.learning.maxInputChars - text.length - LEARNING_SYSTEM.length - FOCUS.length - 2000;
    if (budget < 4000) throw new Error("Managed skills exceed the learning input budget; raise learning.maxInputChars");
    return { inventory, text, budget };
  }

  async function review(ctx: ExtensionContext, config: Config, root: string, task: any[], found: Recurrence, usedSkills: string[], skills: { inventory: SkillSnapshot[]; text: string; budget: number }, signal: AbortSignal): Promise<Draft | undefined> {
    const { inventory, text: inventoryText, budget } = skills;
    const managed = inventory.filter((skill) => skill.managed).length;
    const atLimit = managed >= config.learning.auto.maxSkills;
    const share = Math.floor(budget / (found.matches.length + 1));
    const parts = [evidenceText(task, ctx.sessionManager.getSessionId(), share)];
    for (const match of found.matches) {
      const other = sessions.open(match.session);
      parts.push(evidenceText(runEntries(other.getBranch(), match.run), other.getSessionId(), share));
    }
    signal.throwIfAborted();
    const focus = [FOCUS,
      atLimit ? `Creating skills is not allowed: ${managed} managed skills reach the limit of ${config.learning.auto.maxSkills}. Propose automate, an update, or a merge or deletion that makes room.` : "",
      usedSkills.length ? `The latest run consulted these skills and still hit errors: ${usedSkills.join(", ")}.` : "",
    ].filter(Boolean).join("\n");
    const result = await completeRole(ctx, config, "learn", LEARNING_SYSTEM,
      `Candidate limit: 1\nRecurring steps (in ${found.sessions} sessions): ${found.core.join(" | ")}\nFocus: ${focus}\n${INVENTORY_LABEL}:\n${inventoryText}\nEvidence, one run per session:\n${parts.map((part) => part.text).join("\n")}`, signal)
      .catch((error) => { throw isTransientError(error) ? new Outage(error instanceof Error ? error.message : String(error), { cause: error }) : error; });
    signal.throwIfAborted();
    recordUsage(pi, ctx, { role: "learn", ...result, text: undefined });
    const candidate = parseCandidates(result.text, new Set([...parts.flatMap((part) => part.refs), ...inventory.map(skillRef)]), 1)[0];
    if (!candidate || candidate.action === "note" || (atLimit && candidate.action === "create")) return undefined;
    return await stageCandidate(root, candidate, inventory, "autolearn");
  }

  // What would be reviewed the next time each pattern recurs. Reads sessions
  // and state only: no model call, and the index is not saved.
  async function dryRun(ctx: ExtensionCommandContext, config: Config, root: string): Promise<string> {
    const state = await readState(root);
    const listed = await sessions.list(ctx.cwd);
    const label = new Map(listed.map((item) => [item.path, (item.name || item.firstMessage || item.path.replace(/^.*\//, "")).replace(/\s+/g, " ").slice(0, 60)]));
    const { others, sessions: population } = await indexSessions(state, listed, { entryIds: new Set() }, sessions.open);
    const contextText = (ctx.getSystemPromptOptions().contextFiles ?? []).map((file) => file.content).join("\n");
    const patterns = recurringPatterns(others, config.learning.auto.minSessions, population - 1);
    const pending = (await readDrafts(root)).filter((draft) => draft.status === "pending").length;
    const lines = [
      `Dry run: no model call, nothing saved. ${population - 1} sessions indexed; a pattern needs ${config.learning.auto.minSessions}.`,
      ...!enabledFor(config, state) ? ["Autolearn is off here, so nothing below runs until /autolearn on."] : [],
      ...pending ? [`${pending} pending proposal${pending === 1 ? "" : "s"} must be resolved in /learn-review before any review runs.`] : [],
      ...patterns.length ? [] : ["No workflow currently recurs often enough."],
    ];
    patterns.forEach((pattern, i) => {
      const reviewed = state.reviews.filter((review) => similarCore(pattern.core, review.core)).at(-1);
      const status = documented(pattern.core, contextText) ? "skip: already in project instructions"
        : alreadyReviewed(pattern.core, pattern.sessions, state.reviews) ? `skip: reviewed ${reviewed!.at.slice(0, 10)} (${reviewed!.outcome}) until ${reviewed!.sessions * 2} sessions`
        : "would review";
      const steps = pattern.core.filter((feature) => !feature.includes(" → ")).map((feature) => feature.replace(/^\$ /, ""));
      lines.push(`${i + 1}. ${status} · ${pattern.sessions} sessions · ${steps.join(", ")}`,
        `   seen in: ${[pattern.session, ...pattern.matches.map((match) => match.session)].map((path) => `"${label.get(path) ?? path}"`).join(", ")}`);
    });
    return lines.join("\n");
  }

  pi.registerCommand("autolearn", {
    description: "Show automatic learning for this project; /autolearn on|off|dry-run",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const action = args.trim();
      if (!["", "on", "off", "dry-run"].includes(action)) throw new Error("Usage: /autolearn [on|off|dry-run]");
      const config = configSnapshot(source);
      const root = await scopeRoot(agentDir, config.profile, ctx.cwd);
      const role = config.roles.learn;
      if (action === "dry-run") { report(ctx, await dryRun(ctx, config, root)); return; }
      if (action) {
        if (action === "on") resolveRole(config, "learn", ctx.modelRegistry); // Unconfigured roles fail; no fallback.
        if (action === "off") { disabled.abort(); disabled = new AbortController(); }
        await updateState(root, (state) => { state.enabled = action === "on"; });
      }
      const state = await readState(root);
      const pending = (await readDrafts(root)).filter((draft) => draft.status === "pending").length;
      const lines = [
        `Autolearn is ${enabledFor(config, state) ? "on" : "off"} for this project${state.enabled === undefined ? " (profile default)" : ""}.`,
        `A workflow is reviewed after it recurs in ${config.learning.auto.minSessions} sessions; it then sends those runs to ${role ? `${role.provider}/${role.model}` : "the learn role (not configured)"}.`,
        `Indexed sessions: ${Object.keys(state.files).length}. Patterns reviewed: ${state.reviews.length}. Pending proposals: ${pending}.`,
        ...state.reviews.slice(-5).map((review) => `- ${review.at.slice(0, 10)} · ${review.sessions} sessions · ${review.outcome} · ${review.core.filter((f) => !f.includes(" → ")).join(", ")}`),
      ];
      report(ctx, lines.join("\n"));
    },
  });
}
