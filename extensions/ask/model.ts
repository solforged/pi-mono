// Pure questionnaire logic: validation, form state, model-facing text and the
// decision ledger. No Pi runtime imports, so the test suite can load it.

export const TOOL = "ask_user_question";
export const LEDGER = "ask-decisions";
export const MAX_QUESTIONS = 4, MIN_OPTIONS = 2, MAX_OPTIONS = 4;

export interface Option { label: string; description?: string; preview?: string }
export interface Question { question: string; header?: string; options: Option[]; recommended?: number; multi?: boolean }
/** Picked options, an optional note on them, and optional typed text (which replaces a single choice). */
export interface Answer { picked: number[]; note?: string; custom?: string }
export type Outcome = "answered" | "discuss" | "handback" | "interrupted" | "unavailable" | "invalid";
export interface Item { question: string; header?: string; answer?: string }
export interface Details { outcome: Outcome; items: Item[] }

const RECOMMENDED = /\s*\(recommended\)\s*$/i;
const clean = (text: unknown) => typeof text === "string" ? text.trim() : "";

/** Repairs common model habits before validation: stringified arrays and "(Recommended)" labels. */
export function prepare(args: unknown): unknown {
  const input = (args && typeof args === "object" ? { ...args } : args) as { questions?: unknown };
  if (input && typeof input.questions === "string") {
    try { input.questions = JSON.parse(input.questions); } catch { /* the schema reports it */ }
  }
  if (!Array.isArray(input?.questions)) return input;
  input.questions = input.questions.map((q: any) => {
    if (!q || typeof q !== "object" || !Array.isArray(q.options)) return q;
    let recommended = q.recommended;
    const options = q.options.map((o: any, i: number) => {
      if (!o || typeof o.label !== "string" || !RECOMMENDED.test(o.label)) return o;
      recommended ??= i;
      return { ...o, label: o.label.replace(RECOMMENDED, "") };
    });
    return { ...q, options, ...(recommended === undefined ? {} : { recommended }) };
  });
  return input;
}

export function normalize(questions: Question[]): Question[] {
  return questions.map(q => ({
    question: clean(q.question), ...(clean(q.header) ? { header: clean(q.header) } : {}),
    options: q.options.map(o => ({ label: clean(o.label), ...(clean(o.description) ? { description: clean(o.description) } : {}),
      ...(typeof o.preview === "string" && o.preview.trim() ? { preview: o.preview.replace(/\r\n?/g, "\n").replace(/\s+$/, "") } : {}) })),
    ...(Number.isInteger(q.recommended) ? { recommended: q.recommended } : {}),
    ...(q.multi ? { multi: true } : {}),
  }));
}

/** A message for the model when the questionnaire cannot be shown as given. */
export function invalid(questions: Question[]): string | undefined {
  if (questions.length < 1 || questions.length > MAX_QUESTIONS) return `Ask 1-${MAX_QUESTIONS} questions per call.`;
  const seen = new Set<string>();
  for (const [i, q] of questions.entries()) {
    const name = `Question ${i + 1}`;
    if (!q.question) return `${name} is empty.`;
    if (seen.has(q.question)) return `${name} repeats an earlier question.`;
    seen.add(q.question);
    if (q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) return `${name} needs ${MIN_OPTIONS}-${MAX_OPTIONS} options; the user can always type their own answer.`;
    const labels = q.options.map(o => o.label.toLowerCase());
    if (labels.some(l => !l)) return `${name} has an empty option label.`;
    if (new Set(labels).size !== labels.length) return `${name} has duplicate option labels.`;
    if (q.recommended !== undefined && (q.recommended < 0 || q.recommended >= q.options.length)) return `${name} recommends option ${q.recommended}, which does not exist (indexes start at 0).`;
  }
}

export type Step = "edit" | "note" | "submit" | "discuss" | undefined;

/**
 * Questionnaire state, independent of rendering. Each question lists its
 * options, then a row for the user's own answer. More than one question adds a
 * review tab with Submit and Discuss rows.
 */
export class Form {
  tab = 0;
  review = 0;
  readonly cursor: number[];
  readonly answers: (Answer | undefined)[];
  readonly questions: Question[];
  constructor(questions: Question[]) {
    this.questions = questions;
    this.cursor = questions.map(q => q.recommended ?? 0);
    this.answers = questions.map(() => undefined);
  }
  get tabs() { return this.questions.length > 1 ? this.questions.length + 1 : 1; }
  get reviewing() { return this.tab === this.questions.length; }
  get question(): Question | undefined { return this.questions[this.tab]; }
  /** Row index of the "own answer" row on the current tab. */
  get ownRow() { return this.question?.options.length ?? -1; }
  move(delta: number) {
    if (this.reviewing) this.review = clamp(this.review + delta, 0, 1);
    else this.cursor[this.tab] = clamp(this.cursor[this.tab]! + delta, 0, this.ownRow);
  }
  go(delta: number) { this.tab = (this.tab + delta + this.tabs) % this.tabs; }
  toggle() {
    const q = this.question, row = this.cursor[this.tab]!;
    if (!q?.multi || row >= q.options.length) return;
    const answer = this.answers[this.tab] ?? { picked: [] };
    const picked = answer.picked.includes(row) ? answer.picked.filter(i => i !== row) : [...answer.picked, row].sort((a, b) => a - b);
    this.set({ ...answer, picked });
  }
  enter(): Step {
    if (this.reviewing) return this.review === 0 ? "submit" : "discuss";
    const q = this.question!, row = this.cursor[this.tab]!;
    if (row === this.ownRow) return "edit";
    if (!q.multi) this.set(this.single(row));
    else if (!this.answers[this.tab]) this.set({ picked: [row] });
    return this.advance();
  }
  /** Starts a note on the focused option; the own-answer row and the review tab take none. */
  startNote(): Step {
    if (this.reviewing || this.cursor[this.tab]! >= this.ownRow) return;
    return "note";
  }
  /** The note being edited on this tab, if any. */
  get noteText() { return this.answers[this.tab]?.note ?? ""; }
  /**
   * Picks the focused option with a note on the answer. Single-select moves on;
   * multi-select stays so more options can be toggled. Blank text removes the note.
   */
  note(text: string): Step {
    const q = this.question!, row = this.cursor[this.tab]!, value = text.trim();
    const previous = this.answers[this.tab];
    const base = q.multi ? { ...previous, picked: [...new Set([...(previous?.picked ?? []), row])].sort((a, b) => a - b) } : { picked: [row] };
    const { note: _old, ...rest } = base as Answer;
    this.set({ ...rest, ...(value ? { note: value } : {}) });
    return q.multi ? undefined : this.advance();
  }
  /** A single choice keeps its note only when the same option is chosen again. */
  private single(row: number): Answer {
    const previous = this.answers[this.tab];
    return previous?.note && !previous.custom && previous.picked[0] === row ? { picked: [row], note: previous.note } : { picked: [row] };
  }
  /** 1-based shortcut: single-select chooses, multi-select toggles. */
  number(n: number): Step {
    if (this.reviewing || n < 1 || n > this.ownRow + 1) return;
    this.cursor[this.tab] = n - 1;
    if (n - 1 === this.ownRow) return "edit";
    if (this.question!.multi) { this.toggle(); return; }
    return this.enter();
  }
  /** Typed text replaces a single choice and joins multi-select picks; blank text with nothing picked leaves it to the agent. */
  custom(text: string): Step {
    const multi = this.question!.multi, previous = this.answers[this.tab], value = text.trim();
    const picked = multi ? previous?.picked ?? [] : [];
    this.set({ picked, ...(multi && previous?.note ? { note: previous.note } : {}), ...(value ? { custom: value } : {}) });
    return this.advance();
  }
  private set(answer: Answer) { this.answers[this.tab] = answer.picked.length || answer.custom ? answer : undefined; }
  private advance(): Step {
    if (this.tabs === 1) return "submit";
    this.tab++;
    if (this.reviewing) this.review = 0;
    return;
  }
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export function answerText(q: Question, a: Answer | undefined): string | undefined {
  if (!a) return;
  const parts = [a.picked.map(i => q.options[i]?.label).filter(Boolean).join(", ")].filter(Boolean);
  if (a.note) parts.push(`note: "${a.note}"`);
  if (a.custom) parts.push(`own answer: "${a.custom}"`);
  return parts.join("; ") || undefined;
}

export function items(questions: Question[], answers: (Answer | undefined)[]): Item[] {
  return questions.map((q, i) => ({ question: q.question, ...(q.header ? { header: q.header } : {}), ...(answerText(q, answers[i]) ? { answer: answerText(q, answers[i]) } : {}) }));
}

const line = (item: Item) => `- ${item.question} → ${item.answer ?? "no answer; decide yourself and state your assumption"}`;

/** Model-facing tool result text. */
export function resultText(details: Details, note = ""): string {
  switch (details.outcome) {
    case "answered": return ["User answers:", ...details.items.map(line)].join("\n");
    case "discuss": return "The user wants to discuss these questions in chat instead. Nothing was answered; wait for their message.";
    case "handback": return "The user wants to answer these through your parent agent. Stop now: give your progress so far and list these questions under Open questions.";
    case "interrupted": return "Interrupted before the user answered.";
    case "unavailable": return "No interactive user is available. Decide yourself and state your assumptions.";
    case "invalid": return `Not shown to the user: ${note} Fix the call and ask again.`;
  }
}

/** Parses a dialog-host multi-select reply: option numbers, then optional text after ";". */
export function parseMulti(text: string, count: number): Answer | undefined {
  const [head = "", ...rest] = text.split(";");
  const numbers = /^[\s\d,]*$/.test(head) ? head.split(/[\s,]+/).filter(Boolean).map(Number) : undefined;
  if (!numbers) return text.trim() ? { picked: [], custom: text.trim() } : undefined;
  const picked = [...new Set(numbers.filter(n => n >= 1 && n <= count).map(n => n - 1))].sort((a, b) => a - b);
  const custom = rest.join(";").trim();
  return picked.length || custom ? { picked, ...(custom ? { custom } : {}) } : undefined;
}

// ---------------------------------------------------------------------------
// Decision ledger: answered questions whose results compaction removed from
// context are restated once, right after the compaction summary.

interface Entry { type?: string; id?: string; summary?: string; firstKeptEntryId?: string; targetId?: string; replacement?: unknown;
  message?: { role?: string; toolName?: string; details?: unknown } }
interface Message { role?: string; content?: unknown; timestamp?: number }

/** Answers summarized away by the latest compaction, minus results a context edit omitted. */
export function decisions(branch: Entry[]): Item[] {
  const at = branch.findLastIndex(entry => entry.type === "compaction");
  if (at < 0) return [];
  const kept = branch.findIndex(entry => entry.id === branch[at]!.firstKeptEntryId), cut = kept >= 0 && kept < at ? kept : at;
  const edits = new Map<string, unknown>();
  for (const entry of branch) if (entry.type === "context_edit" && entry.targetId) edits.set(entry.targetId, entry.replacement);
  const result: Item[] = [];
  for (const entry of branch.slice(0, cut)) {
    const m = entry.type === "message" ? entry.message : undefined;
    if (m?.role !== "toolResult" || m.toolName !== TOOL || (entry.id && edits.get(entry.id) === null)) continue;
    const details = m.details as Details | undefined;
    if (details?.outcome !== "answered" || !Array.isArray(details.items)) continue;
    result.push(...details.items.filter(item => typeof item?.question === "string" && typeof item.answer === "string"));
  }
  return result;
}

export function ledgerText(items: Item[]) {
  return ["Decisions the user made earlier in this session (still current unless they changed them since):", ...items.map(line)].join("\n");
}

/** Returns messages with the ledger inserted, or undefined when nothing was compacted away. */
export function withLedger<T extends Message>(messages: T[], branch: Entry[]): T[] | undefined {
  const lost = decisions(branch);
  if (!lost.length) return;
  const compaction = branch.findLast(entry => entry.type === "compaction")!;
  // Snapcompact may already have turned the summary into a user message.
  let at = messages.findIndex(m => m.role === "compactionSummary");
  if (at < 0) at = messages.findIndex(m => m.role === "user" && Array.isArray(m.content) && (m.content as any[])[0]?.text === compaction.summary);
  const anchor = messages[at];
  const ledger = { role: "custom", customType: LEDGER, content: ledgerText(lost), display: false, timestamp: anchor?.timestamp ?? 0 } as unknown as T;
  return [...messages.slice(0, at + 1), ledger, ...messages.slice(at + 1)];
}
