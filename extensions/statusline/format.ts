// Pure helpers for the status line; index.ts wires them to Pi.

export const icons = {
  model: "\uEC19",
  folder: "\uF115",
  branch: "\uF126",
  context: "\u{F029A}", // gauge
  auto: "\u{F0068}",
  cache: "\uF1C0",
  noBilling: "\u{F067A}", // crossed-out dollar
};

// The circle fills with the level (Material Design circle slices); max is a flame.
const thinkingIcons: Record<string, string> = {
  off: "\u{F0766}", minimal: "\u{F0A9E}", low: "\u{F0A9F}", medium: "\u{F0AA1}",
  high: "\u{F0AA3}", xhigh: "\u{F0AA5}", max: "\uF06D",
};
export const thinkingIcon = (level: string) => thinkingIcons[level] ?? thinkingIcons.medium;
// Vendor prefixes repeat what the model family already says.
export const modelLabel = (name: string) => name.replace(/^Claude\s+/i, "");
export const thinkingColor = (level: string) => `thinking${level[0].toUpperCase()}${level.slice(1)}`;
// Pi's own worktrees are on pi/<task> branches; the (wt) mark already says where the branch came from.
export const branchLabel = (branch: string, worktree: boolean) => worktree ? branch.replace(/^pi\//, "") : branch;
// A healthy cache rate is noise; the segment shows only below this.
export const CACHE_SHOWN_BELOW = 80;

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${n}`;
}

// Subscriptions are not billed per token, so their API-equivalent cost gets a crossed-out dollar.
export function formatCost(cost: number, subscription = false): string {
  const amount = cost > 0 ? cost.toFixed(cost >= 1 ? 2 : 3) : "";
  return subscription ? `${icons.noBilling}${amount && ` ${amount}`}` : `$${amount || "0"}`;
}

export function displayPath(cwd: string, home: string | undefined, max = 40): string {
  let path = cwd;
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) path = `~${cwd.slice(home.length)}`;
  if (path.length <= max) return path;
  // Keep whole trailing directories; the last one is kept even when it alone is too long.
  const parts = path.split("/");
  let tail = parts.pop()!;
  while (parts.length && tail.length + parts[parts.length - 1].length + 3 <= max) tail = `${parts.pop()}/${tail}`;
  return `…/${tail}`;
}

/**
 * For a linked worktree, the same directory under the main checkout, from
 * `git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir`.
 * The branch already names the task, so the footer shows where the repository lives.
 */
export function worktreeHome(cwd: string, revParse: string): string | undefined {
  const [top, gitDir, common] = revParse.trim().split("\n");
  if (!top || !gitDir || !common || gitDir === common || !common.endsWith("/.git")) return undefined;
  if (cwd !== top && !cwd.startsWith(`${top}/`)) return undefined;
  return common.slice(0, -"/.git".length) + cwd.slice(top.length);
}

export type Git = {
  branch?: string; // Undefined when HEAD is detached.
  oid?: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
};

// Parses `git status --porcelain=v2 --branch`.
export function parseGitStatus(stdout: string): Git {
  const git: Git = { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice(14);
      if (head !== "(detached)") git.branch = head;
    } else if (line.startsWith("# branch.oid ")) {
      const oid = line.slice(13);
      if (oid !== "(initial)") git.oid = oid;
    } else if (line.startsWith("# branch.ab ")) {
      const [ahead, behind] = line.slice(12).split(" ");
      git.ahead = Math.abs(Number(ahead)) || 0;
      git.behind = Math.abs(Number(behind)) || 0;
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      if (line[2] !== ".") git.staged++;
      if (line[3] !== ".") git.unstaged++;
    } else if (line.startsWith("u ")) git.conflicts++;
    else if (line.startsWith("? ")) git.untracked++;
  }
  return git;
}

/**
 * Runs `check` every `first` ms, and doubles the wait up to `max` each time it
 * reports nothing new. `reset` starts over at `first`.
 */
export function backoff(check: () => Promise<boolean>, first: number, max: number) {
  let wait = first, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    if (stopped) return;
    const armed = timer = setTimeout(async () => {
      const changed = await check().catch(() => false);
      // A reset during the check has armed the next one already.
      if (timer !== armed) return;
      wait = changed ? first : Math.min(wait * 2, max);
      arm();
    }, wait);
    armed.unref?.();
  };
  arm();
  return { reset() { wait = first; arm(); }, stop() { stopped = true; clearTimeout(timer); } };
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
export type Stats = { cost: number; cacheHit?: number };

// Cost covers every entry Pi bills, including abandoned branches, like the built-in footer,
// plus the workflows extension's model calls outside tool results (titles, commits, learning).
// The cache hit rate is from the latest request that sent a prompt; failed requests keep the previous rate.
export function sessionStats(entries: readonly any[]): Stats {
  let cost = 0;
  let cacheHit: number | undefined;
  const add = (usage: Usage | undefined) => { cost += usage?.cost?.total ?? 0; };
  for (const entry of entries) {
    if (entry.type === "usage") add(entry.usage);
    else if (entry.type === "custom" && entry.customType === "workflow-usage") add(entry.data?.usage);
    else if ((entry.type === "branch_summary" || entry.type === "compaction")) add(entry.usage);
    else if (entry.type === "message" && entry.message.role === "toolResult") add(entry.message.usage);
    else if (entry.type === "message" && entry.message.role === "assistant") {
      const usage: Usage = entry.message.usage;
      add(usage);
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      if (prompt > 0) cacheHit = (usage.cacheRead / prompt) * 100;
    }
  }
  return { cost, cacheHit };
}

// Left segments say where the session works; right ones what it runs and spends.
export type Segment = { text: string; priority: number; compact?: string; side?: "left" | "right" };

// Another extension's segment, from
//   pi.events.emit("statusline:segment", { key, text, color?, priority?, position? })
// color names a theme color (default "muted"); priority ranks it with the
// built-in segments (default 1, the cost's); position "start" puts it before
// the path, on the left, instead of after the cost, on the right. An empty text removes the key.
// A segment replaces the extension status with the same key, so an extension
// can publish both and Pi's built-in footer still shows the status.
export const SEGMENT_EVENT = "statusline:segment";
export type Contribution = { text: string; color: string; priority: number; position: "start" | "end" };

// Extension statuses for the right-hand side, sorted by key, without those a segment replaces.
export function rightStatuses(statuses: ReadonlyMap<string, string>, contributed: ReadonlyMap<string, unknown>): string[] {
  return [...statuses.entries()]
    .filter(([key]) => !contributed.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => text.replace(/[\r\n\t]+/g, " ").trim())
    .filter(Boolean);
}

export function readContribution(data: unknown): { key: string; contribution?: Contribution } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { key, text, color, priority, position } = data as Record<string, unknown>;
  if (typeof key !== "string" || !key) return undefined;
  const clean = typeof text === "string" ? text.replace(/[\r\n\t]+/g, " ").trim() : "";
  if (!clean) return { key };
  return {
    key,
    contribution: {
      text: clean,
      color: typeof color === "string" && color ? color : "muted",
      priority: typeof priority === "number" && Number.isFinite(priority) ? priority : 1,
      position: position === "start" ? "start" : "end",
    },
  };
}
export type Measure = { width: (text: string) => number; truncate: (text: string, width: number) => string };
export type Sides = { left: string; right: string };
const GAP = 2; // Least space between the sides.

// Fits segments into one line, left ones from the start and right ones against the end:
// compacts, then drops, the lowest-priority segments first, then truncates the left side.
export function fitSegments(segments: Segment[], separator: string, width: number, measure: Measure): Sides {
  const parts = segments.map((segment) => ({ ...segment }));
  const side = (name: "left" | "right") => parts.filter((part) => (part.side ?? "left") === name).map((part) => part.text).join(separator);
  const span = () => joined(side("left"), side("right"), measure);
  const order = [...parts].sort((a, b) => a.priority - b.priority);
  for (const part of order) {
    if (span() <= width) break;
    if (part.compact !== undefined) part.text = part.compact;
  }
  for (const part of order) {
    if (parts.length <= 1 || span() <= width) break;
    parts.splice(parts.indexOf(part), 1);
  }
  const right = measure.truncate(side("right"), width);
  const room = width - measure.width(right) - (right ? GAP : 0);
  return { left: room > 0 ? measure.truncate(side("left"), room) : "", right };
}

const joined = (left: string, right: string, measure: Measure) =>
  measure.width(left) + measure.width(right) + (left && right ? GAP : 0);

// Puts extension statuses, and the session name when the editor border cannot show it,
// right-aligned before the right side when they fit. Whatever does not fit moves,
// untruncated where possible, to a second line; the name moves first.
export function layout({ left, right }: Sides, statuses: string[], name: string | undefined, width: number, measure: Measure): string[] {
  const line = (middle: string) => {
    const end = [middle, right].filter(Boolean).join("  ");
    return end ? left + " ".repeat(Math.max(0, width - measure.width(left) - measure.width(end))) + end : left;
  };
  const fits = (middle: string) => joined(left, [middle, right].filter(Boolean).join("  "), measure) <= width;
  const all = [...statuses, ...(name ? [name] : [])].join("  ");
  if (!all) return [line("")];
  if (fits(all)) return [line(all)];
  if (statuses.length && name && fits(statuses.join("  "))) return [line(statuses.join("  ")), measure.truncate(name, width)];
  return [line(""), measure.truncate(all, width)];
}

const ANSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const plainText = (text: string) => text.replace(ANSI, "");

export type BorderMeasure = Measure & { plain: (text: string) => string; cut: (text: string, width: number) => string };

// Writes a label over the run of plain border that ends an editor border line, so it
// stays clear of the working status and scroll marker before it: "── ⠋ Working ──── label ─".
// The label is shortened to fit, and left out when fewer than `least` columns are free.
export function borderLabel(line: string, label: string, border: (text: string) => string, measure: BorderMeasure, least = 12): string {
  const room = (/─*$/.exec(measure.plain(line))?.[0].length ?? 0) - 4; // "─ " before, " ─" after.
  const full = measure.width(label);
  if (!full || room < Math.min(least, full)) return line;
  const text = full <= room ? label : measure.truncate(label, room);
  return measure.cut(line, measure.width(line) - measure.width(text) - 3) + " " + text + " " + border("─");
}
