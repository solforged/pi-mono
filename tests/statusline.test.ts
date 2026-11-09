import assert from "node:assert/strict";
import test from "node:test";
import { displayPath, fitSegments, formatCost, formatTokens, layout, parseGitStatus, sessionStats, modelLabel, thinkingColor, thinkingIcon, thinkingLabel } from "../extensions/statusline/format.ts";

const measure = { width: (text: string) => [...text].length, truncate: (text: string, width: number) => [...text].slice(0, width).join("") };
const usage = (input: number, cacheRead: number, cacheWrite: number, total: number) => ({ input, output: 10, cacheRead, cacheWrite, cost: { total } });
const assistant = (u: ReturnType<typeof usage>) => ({ type: "message", message: { role: "assistant", usage: u } });

test("labels thinking levels, token counts, and costs compactly", () => {
  assert.deepEqual(["minimal", "medium", "xhigh", "off"].map(thinkingLabel), ["min", "med", "xhigh", "off"]);
  assert.equal(thinkingColor("xhigh"), "thinkingXhigh");
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(thinkingIcon);
  assert.equal(new Set(levels).size, levels.length);
  assert.deepEqual(["Claude Opus 5.5", "GPT-6.1 Sol", "claude-x"].map(modelLabel), ["Opus 5.5", "GPT-6.1 Sol", "claude-x"]);
  assert.deepEqual([999, 1500, 272_000, 1_000_000, 1_048_576].map(formatTokens), ["999", "2k", "272k", "1M", "1M"]);
  assert.deepEqual([0.0421, 12.345].map((cost) => formatCost(cost)), ["$0.042", "$12.35"]);
  assert.deepEqual([formatCost(2.744, true), formatCost(0, true)], ["\u{F067A} 2.74", "\u{F067A}"]);
});

test("shortens paths under home and keeps whole trailing directories", () => {
  assert.equal(displayPath("/Users/a/src/pi-sol", "/Users/a"), "~/src/pi-sol");
  assert.equal(displayPath("/Users/ab", "/Users/a"), "/Users/ab");
  assert.equal(displayPath("/Users/a", "/Users/a"), "~");
  assert.equal(displayPath("/very/long/path/to/some/project", undefined, 20), "…/to/some/project");
  assert.equal(displayPath("/x/an-extremely-long-directory-name", undefined, 10), "…/an-extremely-long-directory-name");
});

test("parses porcelain v2 status with branch, tracking, and change counts", () => {
  const git = parseGitStatus([
    "# branch.oid 0123456789abcdef", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1",
    "1 M. N... 100644 100644 100644 a b staged.ts", "1 .M N... 100644 100644 100644 a b unstaged.ts",
    "1 MM N... 100644 100644 100644 a b both.ts", "2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts",
    "u UU N... 100644 100644 100644 100644 a b c conflict.ts", "? new.txt", "? dir/", "! ignored", "",
  ].join("\n"));
  assert.deepEqual(git, { branch: "main", oid: "0123456789abcdef", ahead: 2, behind: 1, staged: 3, unstaged: 2, untracked: 2, conflicts: 1 });
  assert.deepEqual(parseGitStatus("# branch.oid (initial)\n# branch.head (detached)\n"), { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 });
});

test("totals billed usage and keeps the latest real cache hit rate", () => {
  assert.deepEqual(sessionStats([]), { cost: 0, cacheHit: undefined });
  const stats = sessionStats([
    assistant(usage(100, 0, 900, 0.5)),
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "toolResult", usage: usage(0, 0, 0, 0.25) } },
    { type: "message", message: { role: "toolResult" } },
    assistant(usage(10, 900, 90, 0.1)),
    assistant(usage(0, 0, 0, 0)), // A failed request sent no prompt.
    { type: "compaction", usage: usage(0, 0, 0, 0.05) },
    { type: "branch_summary" },
    { type: "usage", usage: usage(0, 0, 0, 0.1) },
  ]);
  assert.equal(stats.cost.toFixed(2), "1.00");
  assert.equal(stats.cacheHit, 90);
});

test("fits segments by compacting, then dropping, lowest priorities first", () => {
  const segments = [
    { text: "model", priority: 3 },
    { text: "~/src/project", compact: "project", priority: 1 },
    { text: "$0.10", priority: 0 },
  ];
  assert.equal(fitSegments(segments, " | ", 80, measure), "model | ~/src/project | $0.10");
  assert.equal(fitSegments(segments, " | ", 25, measure), "model | project | $0.10");
  assert.equal(fitSegments(segments, " | ", 16, measure), "model | project");
  assert.equal(fitSegments(segments, " | ", 4, measure), "mode");
  assert.equal(segments[1].text, "~/src/project");
});

test("right-aligns statuses and names, moving the name and then statuses below", () => {
  assert.deepEqual(layout("left", [], undefined, 20, measure), ["left"]);
  assert.deepEqual(layout("left", ["s1"], "name", 20, measure), ["left        s1  name"]);
  assert.deepEqual(layout("left", [], "a-long-session-name", 20, measure), ["left", "a-long-session-name"]);
  assert.deepEqual(layout("left", [], "a-long-session-name-that-overflows", 20, measure), ["left", "a-long-session-name-"]);
  assert.deepEqual(layout("left", ["status"], "a-long-session-name", 20, measure), ["left          status", "a-long-session-name"]);
  assert.deepEqual(layout("left", ["a-long-status-text"], "name", 20, measure), ["left", "a-long-status-text  "]);
});
