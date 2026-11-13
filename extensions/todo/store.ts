// Pure list logic. State lives in the session: todo tool-result details and
// "todo" custom entries on the active branch, so it follows /tree and forks.

export const statuses = ["pending", "in_progress", "blocked", "done"] as const;
export type Status = (typeof statuses)[number];
export interface Item { id: number; text: string; status: Status; note?: string }
export interface List { nextId: number; items: Item[] }
export interface Change { text?: string; status?: Status; note?: string }

export const limits = { items: 200, text: 500, note: 2000, reminders: 3, widget: 3, context: 16000 };

export function empty(): List { return { nextId: 1, items: [] }; }

function clean(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`Todo ${field} must be text`);
  const text = value.replace(/\s+/g, " ").trim();
  if (!text && !allowEmpty) throw new Error(`Todo ${field} must not be empty`);
  if (text.length > max) throw new Error(`Todo ${field} exceeds ${max} characters`);
  return text;
}
function status(value: unknown): Status {
  if (!statuses.includes(value as Status)) throw new Error(`Todo status must be one of: ${statuses.join(", ")}`);
  return value as Status;
}

// Accept only well-formed snapshots; anything else is ignored during restore.
export function valid(data: any): List | undefined {
  if (!data || !Number.isInteger(data.nextId) || !Array.isArray(data.items)) return undefined;
  const ids = new Set<number>();
  for (const item of data.items) {
    if (!item || !Number.isInteger(item.id) || item.id < 1 || item.id >= data.nextId || ids.has(item.id)) return undefined;
    if (typeof item.text !== "string" || !statuses.includes(item.status) || (item.note !== undefined && typeof item.note !== "string")) return undefined;
    ids.add(item.id);
  }
  return { nextId: data.nextId, items: data.items.map((item: Item) => ({ ...item })) };
}

// The latest snapshot on the branch wins; failed tool calls leave no state.
export function restore(entries: Iterable<any>): List {
  let list = empty();
  for (const entry of entries) {
    let data: unknown;
    if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "todo" && !entry.message.isError) data = entry.message.details;
    else if (entry?.type === "custom" && entry.customType === "todo") data = entry.data;
    else continue;
    list = valid(data) ?? list;
  }
  return list;
}

export type Operation =
  | { action: "add"; items: string[] }
  | { action: "update"; id: number; change: Change }
  | { action: "remove"; id: number }
  | { action: "clear_done" };

function find(list: List, id: number): Item {
  const item = list.items.find((entry) => entry.id === id);
  if (!item) throw new Error(`Todo #${id} not found`);
  return item;
}

// Apply one operation to a copy and describe the change in a sentence.
export function apply(current: List, op: Operation): { list: List; summary: string } {
  const list: List = { nextId: current.nextId, items: current.items.map((item) => ({ ...item })) };
  switch (op.action) {
    case "add": {
      const texts = op.items.map((text) => clean(text, "text", limits.text));
      if (!texts.length) throw new Error("Provide at least one todo to add");
      if (list.items.length + texts.length > limits.items) throw new Error(`Todo lists hold at most ${limits.items} items; remove finished items first`);
      const ids = texts.map((text) => {
        const id = list.nextId++;
        list.items.push({ id, text, status: "pending" });
        return `#${id}`;
      });
      return { list, summary: `Added ${ids.join(", ")}` };
    }
    case "update": {
      const item = find(list, op.id);
      const { text, status: next, note } = op.change;
      if (text === undefined && next === undefined && note === undefined) throw new Error("Provide text, status or note to update");
      if (text !== undefined) item.text = clean(text, "text", limits.text);
      if (next !== undefined) item.status = status(next);
      if (note !== undefined) {
        const value = clean(note, "note", limits.note, true);
        if (value) item.note = value; else delete item.note;
      }
      return { list, summary: `Updated #${item.id} (${item.status.replace("_", " ")})` };
    }
    case "remove": {
      const item = find(list, op.id);
      list.items = list.items.filter((entry) => entry !== item);
      return { list, summary: `Removed #${item.id}` };
    }
    case "clear_done": {
      const before = list.items.length;
      list.items = list.items.filter((item) => item.status !== "done");
      return { list, summary: `Removed ${before - list.items.length} finished item(s)` };
    }
  }
}

const rank: Record<Status, number> = { in_progress: 0, blocked: 1, pending: 2, done: 3 };
export function ordered(items: Item[]): Item[] {
  return [...items].sort((a, b) => rank[a.status] - rank[b.status] || a.id - b.id);
}
export const open = (list: List) => ordered(list.items).filter((item) => item.status !== "done");

// A glance at the open work: started and blocked items lead, then the pending
// items that follow the first started one, wrapping to earlier ones.
export function upNext(list: List, cap: number = limits.widget): { items: Item[]; hidden: number } {
  const items = open(list);
  const active = items.filter((item) => item.status !== "pending");
  const from = active.find((item) => item.status === "in_progress")?.id ?? 0;
  const pending = items.filter((item) => item.status === "pending");
  const shown = [...active, ...pending.filter((item) => item.id > from), ...pending.filter((item) => item.id <= from)].slice(0, cap);
  return { items: shown, hidden: items.length - shown.length };
}
export function counts(items: Item[]) {
  const done = items.filter((item) => item.status === "done").length;
  return { open: items.length - done, done, active: items.filter((item) => item.status === "in_progress").length };
}
export const tally = (list: List) => { const { open, done } = counts(list.items); return `${open} open, ${done} done`; };

export function line(item: Item): string {
  return `#${item.id} [${item.status}] ${item.text}${item.note ? ` (note: ${item.note})` : ""}`;
}

// Full listing for the list action and noninteractive commands.
export function format(list: List): string {
  if (!list.items.length) return "The todo list is empty.";
  return [tally(list), ...ordered(list.items).map(line)].join("\n");
}

// Bounded list of open items; undefined when nothing is open.
export function section(list: List, maxItems = 20, maxChars = 2000): string | undefined {
  const items = open(list);
  if (!items.length) return undefined;
  const lines: string[] = [];
  let used = 0;
  for (const item of items.slice(0, maxItems)) {
    const text = line(item);
    if (used + text.length + 1 > maxChars) break;
    lines.push(text); used += text.length + 1;
  }
  if (lines.length < items.length) lines.push(`… ${items.length - lines.length} more`);
  return lines.join("\n");
}

// Sent after a compaction inside a run, when the prompt section predates the list.
export function restated(list: List): string {
  const text = section(list);
  return `The todo list has changed since the <todos> section above was written. ${text ? `Open items now:\n${text}` : "No items are open now."}`;
}

// Sent when the agent stops with open items.
export function reminder(list: List, count: number): string | undefined {
  const text = section(list);
  if (!text) return undefined;
  return `You stopped with ${open(list).length} open todo item(s):\n${text}\n\n`
    + "Continue working on them, or mark them done or remove them if they are finished or no longer needed. "
    + `If you are waiting on the user, say so briefly and stop. (Reminder ${count}/${limits.reminders})`;
}

// Delegated children receive the parent's open items as data in their context.
export function withParentTodos(context: unknown, list: List, max = limits.context): string | undefined {
  const base = typeof context === "string" ? context : undefined;
  const text = section(list);
  if (!text) return base;
  const block = `Parent session's open todo items (read-only, for orientation):\n${text}`;
  const next = base ? `${base}\n\n${block}` : block;
  return next.length <= max ? next : base;
}
