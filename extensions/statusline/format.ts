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

const thinkingLabels: Record<string, string> = { minimal: "min", medium: "med" };
export const thinkingLabel = (level: string) => thinkingLabels[level] ?? level;
// The circle fills with the level (Material Design circle slices); max is a flame.
const thinkingIcons: Record<string, string> = {
  off: "\u{F0766}", minimal: "\u{F0A9E}", low: "\u{F0A9F}", medium: "\u{F0AA1}",
  high: "\u{F0AA3}", xhigh: "\u{F0AA5}", max: "\uF06D",
};
export const thinkingIcon = (level: string) => thinkingIcons[level] ?? thinkingIcons.medium;
// Vendor prefixes repeat what the model family already says.
export const modelLabel = (name: string) => name.replace(/^Claude\s+/i, "");
export const thinkingColor = (level: string) => `thinking${level[0].toUpperCase()}${level.slice(1)}`;

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

export type Segment = { text: string; priority: number; compact?: string };

// Another extension's segment, from
//   pi.events.emit("statusline:segment", { key, text, color?, priority?, position? })
// color names a theme color (default "muted"); priority ranks it with the
// built-in segments (default 1, the cost's); position "start" puts it before
// the model instead of after the cost. An empty text removes the key.
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

// Fits segments into one line: compacts, then drops, the lowest-priority segments first.
export function fitSegments(segments: Segment[], separator: string, width: number, measure: Measure): string {
  const parts = segments.map((segment) => ({ ...segment }));
  const join = () => parts.map((part) => part.text).join(separator);
  const order = [...parts].sort((a, b) => a.priority - b.priority);
  for (const part of order) {
    if (measure.width(join()) <= width) break;
    if (part.compact !== undefined) part.text = part.compact;
  }
  for (const part of order) {
    if (parts.length <= 1 || measure.width(join()) <= width) break;
    parts.splice(parts.indexOf(part), 1);
  }
  return measure.truncate(join(), width);
}

// Right-aligns extension statuses and the session name when they fit beside the segments.
// Whatever does not fit moves, untruncated where possible, to a second line; the name moves first.
export function layout(left: string, statuses: string[], name: string | undefined, width: number, measure: Measure): string[] {
  const room = width - measure.width(left) - 2;
  const beside = (right: string) => left + " ".repeat(width - measure.width(left) - measure.width(right)) + right;
  const all = [...statuses, ...(name ? [name] : [])];
  if (!all.length) return [left];
  if (measure.width(all.join("  ")) <= room) return [beside(all.join("  "))];
  if (statuses.length && name && measure.width(statuses.join("  ")) <= room) return [beside(statuses.join("  ")), measure.truncate(name, width)];
  return [left, measure.truncate(all.join("  "), width)];
}
