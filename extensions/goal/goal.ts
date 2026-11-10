// Pure goal logic. State lives in the session as "goal" custom entries and
// goal tool-result details on the active branch, so it follows /tree and forks.

export const statuses = ["active", "paused", "blocked", "budget_limited", "complete"] as const;
export type Status = (typeof statuses)[number];
// What changed the goal; set and resume start a new run with a fresh budget.
export const events = ["set", "resume", "pause", "interrupt", "budget", "limit", "complete", "blocked", "clear"] as const;
export type Event = (typeof events)[number];

export interface Budget { continuations?: number; tokens?: number }
export interface Goal { objective: string; status: Status; budget: Budget; note?: string }
export interface Snapshot { event: Event; goal: Goal | null }
// Spent in the current run: automatic continuations, fresh model tokens, and when it started.
export interface Usage { continuations: number; tokens: number; since?: number }
export interface State { goal: Goal | null; used: Usage }

export const limits = { objective: 4000, note: 2000, continuations: 25 };
export const NOTE_TYPE = "goal-note";       // continuation and wrap-up notes for the model
export const KICKOFF_TYPE = "goal-kickoff"; // hidden message that starts goal work

const unfinished: Status[] = ["active", "paused", "blocked", "budget_limited"];
export const isUnfinished = (goal: Goal | null) => !!goal && unfinished.includes(goal.status);

export function clean(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`Goal ${field} must be text`);
  const text = value.trim().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  if (!text) throw new Error(`Goal ${field} must not be empty`);
  if (text.length > max) throw new Error(`Goal ${field} exceeds ${max} characters`);
  return text;
}

const count = (value: unknown) => value === undefined || (Number.isInteger(value) && (value as number) > 0);
export function valid(data: any): Snapshot | undefined {
  if (!data || !events.includes(data.event)) return undefined;
  if (data.goal === null) return data.event === "clear" ? { event: "clear", goal: null } : undefined;
  const goal = data.goal;
  if (!goal || typeof goal.objective !== "string" || !goal.objective || !statuses.includes(goal.status)) return undefined;
  if (!goal.budget || !count(goal.budget.continuations) || !count(goal.budget.tokens)) return undefined;
  if (goal.note !== undefined && typeof goal.note !== "string") return undefined;
  return { event: data.event, goal: { objective: goal.objective, status: goal.status, budget: { ...goal.budget }, ...(goal.note ? { note: goal.note } : {}) } };
}

// Model input that does real work: uncached input, cache writes and output.
// Cache reads are left out, or a long session would spend a budget on rereading.
export function fresh(usage: any): number {
  if (!usage) return 0;
  const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
  return n(usage.input) + n(usage.output) + n(usage.cacheWrite);
}

const time = (entry: any) => { const t = Date.parse(entry?.timestamp ?? ""); return Number.isNaN(t) ? undefined : t; };

// The latest snapshot on the branch wins; failed tool calls leave no state.
// Usage counts from the last set or resume.
export function restore(entries: Iterable<any>): State {
  let goal: Goal | null = null;
  let used: Usage = { continuations: 0, tokens: 0 };
  for (const entry of entries) {
    let data: unknown;
    if (entry?.type === "custom" && entry.customType === "goal") data = entry.data;
    else if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "goal" && !entry.message.isError) data = entry.message.details;
    else if (entry?.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")) {
      if (goal?.status === "active") used.tokens += fresh(entry.message.usage);
      continue;
    } else if (entry?.type === "custom_message" && entry.customType === NOTE_TYPE) {
      if (goal?.status === "active" && entry.details?.kind === "continue") used.continuations++;
      continue;
    } else continue;
    const snapshot = valid(data);
    if (!snapshot) continue;
    goal = snapshot.goal;
    if (snapshot.event === "set" || snapshot.event === "resume") used = { continuations: 0, tokens: 0, since: time(entry) };
  }
  return { goal, used };
}

export function snapshot(event: Event, goal: Goal | null): Snapshot {
  return { event, goal: goal && { ...goal, budget: { ...goal.budget } } };
}

export function create(objective: string): Goal {
  return { objective: clean(objective, "objective", limits.objective), status: "active", budget: { continuations: limits.continuations } };
}

// Lifecycle changes the user makes with /goal.
export function transition(goal: Goal | null, action: "pause" | "resume" | "clear"): Snapshot {
  if (!goal) throw new Error("No goal is set. Start one with /goal <objective>");
  if (action === "clear") return snapshot("clear", null);
  if (action === "pause") {
    if (goal.status !== "active") throw new Error(`The goal is ${label(goal.status)}, not active`);
    return snapshot("pause", { ...goal, status: "paused" });
  }
  if (goal.status === "active") throw new Error("The goal is already active");
  if (goal.status === "complete") throw new Error("The goal is complete. Set a new one with /goal <objective>");
  const { note: _note, ...rest } = goal;
  return snapshot("resume", { ...rest, status: "active" });
}

// The agent may only close an active goal, or one it is wrapping up after its budget.
export function close(goal: Goal | null, status: "complete" | "blocked", note: unknown): Snapshot {
  if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) throw new Error("There is no active goal to update");
  return snapshot(status, { ...goal, status, note: clean(note, "note", limits.note) });
}

const units: Record<string, number> = { "": 1, k: 1e3, m: 1e6 };
export function parseAmount(text: string, kind: "continuations" | "tokens"): number | undefined {
  if (/^(off|none)$/i.test(text)) return undefined;
  const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(text.replace(/[_,]/g, ""));
  const value = match ? Math.round(Number(match[1]) * units[match[2].toLowerCase()]) : NaN;
  if (!Number.isInteger(value) || value < 1 || (kind === "continuations" && match![2])) {
    throw new Error(kind === "tokens" ? "Give tokens as a number such as 500k or 2m, or off" : "Give continuations as a whole number, or off");
  }
  return value;
}

export function withBudget(goal: Goal | null, kind: "continuations" | "tokens", value: number | undefined): Snapshot {
  if (!goal) throw new Error("No goal is set. Start one with /goal <objective>");
  const budget = { ...goal.budget };
  if (value === undefined) delete budget[kind]; else budget[kind] = value;
  return snapshot("budget", { ...goal, budget });
}

export type Decision =
  | { kind: "none" }
  | { kind: "wait" }                     // the last turn ran no tool: wait for the user
  | { kind: "continue"; n: number }      // continuation n of the run
  | { kind: "limit"; reason: string };   // budget spent: wrap up once

// What to do when the agent stops with a goal in view.
export function decide(state: State, progressed: boolean): Decision {
  const { goal, used } = state;
  if (!goal || goal.status !== "active") return { kind: "none" };
  const over = overBudget(goal, used);
  if (over) return { kind: "limit", reason: over };
  if (!progressed) return { kind: "wait" };
  return { kind: "continue", n: used.continuations + 1 };
}

export function overBudget(goal: Goal, used: Usage): string | undefined {
  const { continuations, tokens } = goal.budget;
  if (continuations !== undefined && used.continuations >= continuations) return `${continuations} automatic continuations`;
  if (tokens !== undefined && used.tokens >= tokens) return `${amount(tokens)} tokens`;
  return undefined;
}

export const label = (status: Status) => status === "budget_limited" ? "out of budget" : status;

export function amount(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return String(n);
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function usageText(goal: Goal, used: Usage, now = Date.now()): string {
  const of = (n: number, cap?: number) => cap === undefined ? String(n) : `${n} of ${cap}`;
  const parts = [
    `${of(used.continuations, goal.budget.continuations)} continuations`,
    `${goal.budget.tokens === undefined ? amount(used.tokens) : `${amount(used.tokens)} of ${amount(goal.budget.tokens)}`} tokens`,
  ];
  if (used.since !== undefined) parts.push(duration(now - used.since));
  return parts.join(", ");
}

export function format(state: State, now = Date.now()): string {
  const { goal, used } = state;
  if (!goal) return "No goal is set. Start one with /goal <objective>";
  const lines = [`Goal (${label(goal.status)}): ${goal.objective}`, `Used this run: ${usageText(goal, used, now)}`];
  if (goal.note) lines.push(`${goal.status === "blocked" ? "Blocker" : "Note"}: ${goal.note}`);
  return lines.join("\n");
}

// Footer text: short enough to sit beside other statuses.
export function statusText(state: State): string | undefined {
  const { goal, used } = state;
  if (!goal) return undefined;
  if (goal.status !== "active") return `goal ${label(goal.status)}`;
  const cap = goal.budget.continuations;
  return `goal ${used.continuations}${cap === undefined ? "" : `/${cap}`}`;
}

// The system prompt section while the goal is active. It changes only with the goal.
export function section(goal: Goal | null): string | undefined {
  if (!goal || goal.status !== "active") return undefined;
  return `Objective: ${goal.objective}\n\n`
    + "The user set this objective for the session. Keep working toward it across turns; Pi prompts you to continue when you stop. "
    + "Call the goal tool with status complete only after checking the objective against concrete evidence such as test runs, command output or files, and give that evidence in the note. "
    + "Never mark it complete because work is hard, slow or the budget is low. "
    + "Call it with status blocked only when the same blocker has stopped progress for three turns in a row and only the user or an outside change can clear it; the note says what would. "
    + "If you need the user's input, ask and stop.";
}

export function kickoff(goal: Goal, event: "set" | "resume"): string {
  return event === "set" ? `New goal: ${goal.objective}\n\nStart working toward it now.` : "The goal is resumed. Continue working toward it.";
}

export function continueNote(goal: Goal, used: Usage, n: number): string {
  const cap = goal.budget.continuations;
  return `The goal is not marked complete. Continue working toward it (continuation ${n}${cap === undefined ? "" : ` of ${cap}`}). `
    + "Before stopping again, check the objective against concrete evidence. If it is achieved, call goal with status complete. "
    + "If you need the user's input, ask and stop.";
}

export function limitNote(reason: string): string {
  return `The goal's budget of ${reason} is spent. Stop working on it now. `
    + "Summarize what was done, the evidence so far, what remains and the next useful step. "
    + "Call goal with status complete only if the evidence already shows the objective is achieved.";
}
