// Pure planning for compaction summaries. No Pi runtime imports, so tests load it directly.
import { thresholdFor } from "../compact-ratio/index.ts";
import { archiveText } from "../snapcompact/compact.ts";

export type Message = { role: string; content?: unknown; [key: string]: unknown };
export type Entry = { id: string; type: string; summary?: string; details?: unknown; targetId?: string };
export type Projected = { sourceEntry: Entry; messages: Message[] };
export type FileOps = { read: Set<string>; written: Set<string>; edited: Set<string> };
export type Estimate = (message: Message) => number;

/** The shape of Pi's CompactionPreparation that `compact()` reads. */
export type Preparation = {
  firstKeptEntryId: string;
  messagesToSummarize: Message[];
  turnPrefixMessages: Message[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: FileOps;
  settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
};

export type Plan = {
  preparation: Preparation;
  /** The compaction this summary extends; a different one makes the plan stale. */
  previousCompactionId?: string;
  /** Every entry seen when planning, to recognise context edits made afterwards. */
  knownIds: Set<string>;
  summarizedIds: Set<string>;
};

export type Limits = { threshold: number; lead: number; reserveTokens: number; keepRecentTokens: number };

const DEFAULT_RESERVE = 16384;
const DEFAULT_KEEP_RECENT = 20000;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Summaries extract rather than reason; a high session level only slows them down. */
export const SUMMARY_THINKING = "low";
/** After a compaction the context must fit this share of the threshold, as in oh-my-pi. */
export const HEADROOM = 0.8;

type Model = { provider: string; id: string; contextWindow?: number };

function tokenSetting(settings: any, model: Model, field: "reserveTokens" | "keepRecentTokens", fallback: number): number {
  const compaction = settings?.compaction;
  const value = compaction?.modelOverrides?.[`${model.provider}/${model.id}`]?.[field] ?? compaction?.[field];
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * When compaction fires for this model: Pi's window minus reserve, or compact-ratio's
 * share when that is lower. Speculation starts `lead` tokens before it.
 */
export function limitsFor(model: Model | undefined, settings: any): Limits | undefined {
  if (!model?.contextWindow || settings?.compaction?.enabled === false) return undefined;
  const reserveTokens = tokenSetting(settings, model, "reserveTokens", DEFAULT_RESERVE);
  const keepRecentTokens = tokenSetting(settings, model, "keepRecentTokens", DEFAULT_KEEP_RECENT);
  const pi = model.contextWindow - reserveTokens;
  const ratio = thresholdFor(model, settings);
  const threshold = ratio === undefined ? pi : Math.min(ratio, pi);
  if (threshold <= 0) return undefined;
  const lead = Math.min(32000, Math.max(8192, Math.round(threshold * 0.125)));
  return { threshold, lead, reserveTokens, keepRecentTokens };
}

export function summaryThinking(level: string | undefined): string {
  const index = LEVELS.indexOf(level ?? "");
  return index >= 0 && index <= LEVELS.indexOf(SUMMARY_THINKING) ? level! : SUMMARY_THINKING;
}

export function retryPolicy(settings: any) {
  const retry = settings?.retry ?? {};
  return {
    enabled: retry.enabled ?? true,
    maxRetries: retry.maxRetries ?? 3,
    baseDelayMs: retry.baseDelayMs ?? 2000,
    maxAgentDelayMs: retry.maxAgentDelayMs ?? 60000,
  };
}

const CUT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
const TURN_START_ROLES = new Set(["user", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
const isCompaction = (entry: Projected) => entry.sourceEntry.type === "compaction";
const isCutPoint = (entry: Projected) => !isCompaction(entry) && entry.messages.some((m) => CUT_ROLES.has(m.role));
const isTurnStart = (entry: Projected) => !isCompaction(entry) && entry.messages.some((m) => TURN_START_ROLES.has(m.role));
const conversation = (entry: Projected) => (isCompaction(entry) ? [] : entry.messages.filter((m) => m.role !== "system"));

/** The compaction whose summary heads this projection, if any. */
export function previousCompaction(entries: Projected[]): Entry | undefined {
  return entries.find((entry) => isCompaction(entry) && entry.messages.length > 0)?.sourceEntry;
}

/**
 * The summary a new one should extend. A snapcompact archive's summary is only a
 * reading guide for its images, so its transcript text stands in for it.
 */
export function previousSummaryOf(entry: Entry | undefined): string | undefined {
  if (!entry) return undefined;
  const archived = archiveText(entry.details);
  return archived ? `Archived transcript of the earlier conversation:\n\n${archived}` : entry.summary;
}

function addFileOp(name: unknown, args: any, ops: FileOps) {
  const path = typeof args?.path === "string" ? args.path : undefined;
  if (!path) return;
  if (name === "read") ops.read.add(path);
  else if (name === "write") ops.written.add(path);
  else if (name === "edit") ops.edited.add(path);
}

/**
 * Files read and modified, carried from the previous compaction. Pi only carries
 * them from its own summaries, so an extension's summary has to carry them itself.
 */
export function fileOpsFor(messages: Message[], previous: Entry | undefined, base?: FileOps): FileOps {
  const ops: FileOps = { read: new Set(base?.read), written: new Set(base?.written), edited: new Set(base?.edited) };
  const details = previous?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
  if (Array.isArray(details?.readFiles)) for (const file of details.readFiles) ops.read.add(String(file));
  if (Array.isArray(details?.modifiedFiles)) for (const file of details.modifiedFiles) ops.edited.add(String(file));
  for (const message of messages) {
    if (message.role === "toolResult") {
      for (const call of (message as any).nestedCalls?.calls ?? []) addFileOp(call?.name, call?.arguments, ops);
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as any[]) if (block?.type === "toolCall") addFileOp(block.name, block.arguments, ops);
    }
  }
  return ops;
}

/**
 * What a compaction at this moment would summarize, mirroring Pi's prepareCompaction:
 * keep about `keepRecentTokens` of recent context, cut at a message that is not a tool
 * result, and summarize a split turn's prefix separately.
 */
export function planCompaction(entries: Projected[], limits: Limits, tokensBefore: number, estimate: Estimate): Plan | undefined {
  const previous = previousCompaction(entries);
  const start = previous ? entries.findIndex((entry) => entry.sourceEntry === previous) + 1 : 0;
  const end = entries.length;
  const cuts: number[] = [];
  for (let i = start; i < end; i++) if (isCutPoint(entries[i]!)) cuts.push(i);
  if (!cuts.length) return undefined;

  let cut: number | undefined;
  let kept = 0;
  for (let i = end - 1; i >= start; i--) {
    const tokens = entries[i]!.messages.reduce((sum, message) => sum + estimate(message), 0);
    if (!tokens) continue;
    kept += tokens;
    if (kept >= limits.keepRecentTokens) {
      cut = cuts.find((candidate) => candidate >= i) ?? cuts.at(-1)!;
      break;
    }
  }
  // Everything still fits the recent window: there is nothing to summarize yet.
  if (cut === undefined) return undefined;
  while (cut > start && !isCompaction(entries[cut - 1]!) && entries[cut - 1]!.messages.length === 0) cut--;

  let turnStart = -1;
  if (!isTurnStart(entries[cut]!)) {
    for (let i = cut; i >= start; i--) if (isTurnStart(entries[i]!)) { turnStart = i; break; }
  }
  const isSplitTurn = turnStart !== -1;
  const historyEnd = isSplitTurn ? turnStart : cut;
  const history = entries.slice(start, historyEnd);
  const prefix = isSplitTurn ? entries.slice(turnStart, cut) : [];
  const messagesToSummarize = history.flatMap(conversation);
  const turnPrefixMessages = prefix.flatMap(conversation);
  if (!messagesToSummarize.length && !turnPrefixMessages.length) return undefined;

  return {
    preparation: {
      firstKeptEntryId: entries[cut]!.sourceEntry.id,
      messagesToSummarize,
      turnPrefixMessages,
      isSplitTurn,
      tokensBefore,
      previousSummary: previousSummaryOf(previous),
      fileOps: fileOpsFor([...messagesToSummarize, ...turnPrefixMessages], previous),
      settings: { enabled: true, reserveTokens: limits.reserveTokens, keepRecentTokens: limits.keepRecentTokens },
    },
    previousCompactionId: previous?.id,
    knownIds: new Set(entries.map((entry) => entry.sourceEntry.id)),
    summarizedIds: new Set([...history, ...prefix].map((entry) => entry.sourceEntry.id)),
  };
}

/**
 * Why a summary planned earlier cannot be committed now, or undefined when it can.
 * Turns added since planning are kept verbatim after it, so the result must still
 * leave headroom below the threshold.
 */
export function staleReason(plan: Plan, summary: string, entries: Projected[], limits: Limits, estimate: Estimate): string | undefined {
  if (previousCompaction(entries)?.id !== plan.previousCompactionId) return "another compaction ran";
  const kept = entries.findIndex((entry) => entry.sourceEntry.id === plan.preparation.firstKeptEntryId);
  if (kept < 0) return "its history left the branch";
  const edited = entries.some((entry) =>
    entry.sourceEntry.type === "context_edit" && !plan.knownIds.has(entry.sourceEntry.id) && plan.summarizedIds.has(entry.sourceEntry.targetId ?? ""));
  if (edited) return "summarized history was edited";
  const after = Math.ceil(summary.length / 4) + entries.slice(kept).reduce((sum, entry) => sum + entry.messages.reduce((s, m) => s + estimate(m), 0), 0);
  if (after > limits.threshold * HEADROOM) return "too much history arrived since";
  return undefined;
}
