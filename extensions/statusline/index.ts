import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  backoff, borderLabel, branchLabel, displayPath, fitSegments, formatCost, formatTokens, icons, jjLabel, layout, parseGitStatus, parseJj, readContribution, rightStatuses, sessionStats,
  modelLabel, plainText, thinkingColor, thinkingIcon, worktreeHome, CACHE_SHOWN_BELOW, JJ_TEMPLATE, SEGMENT_EVENT, type Contribution, type Git, type Jj, type Segment, type Stats,
} from "./format.ts";
import { hostGit, trustedLayout } from "../sandbox/hostgit.ts";
import { dropEditorFeature, useEditorFeature, type FeatureFactory } from "../shared/editor.ts";

const POLL_MS = 10_000; // Catches changes made outside Pi.
const IDLE_POLL_MS = 60_000; // The poll slows to this while it finds nothing new.
const DEBOUNCE_MS = 300;
const measure = { width: visibleWidth, truncate: (text: string, width: number) => truncateToWidth(text, width, "…") };
const borderMeasure = { ...measure, plain: plainText, cut: (text: string, width: number) => truncateToWidth(text, width, "") };
const TITLE_FEATURE = "statusline-title";

type Footer = { refreshGit: () => void; render: () => void; close: () => void };

export default function (pi: ExtensionAPI) {
  let footer: Footer | undefined;
  const close = () => { footer?.close(); footer = undefined; };
  // Kept across sessions: a contributor may publish before the footer exists.
  const contributed = new Map<string, Contribution>();
  pi.events.on(SEGMENT_EVENT, (data) => {
    const update = readContribution(data);
    if (!update) return;
    if (update.contribution) contributed.set(update.key, update.contribution);
    else contributed.delete(update.key);
    footer?.render();
  });

  pi.on("session_start", (_event, ctx) => {
    close();
    if (ctx.mode === "tui") footer = install(pi, ctx, contributed);
  });
  pi.on("session_shutdown", close);
  pi.on("tool_execution_end", () => footer?.refreshGit());
  pi.on("agent_end", () => footer?.refreshGit());
  pi.on("user_bash", () => { setTimeout(() => footer?.refreshGit(), 1000); });
  pi.on("model_select", () => footer?.render());
  pi.on("thinking_level_select", () => footer?.render());
}

function install(pi: ExtensionAPI, ctx: ExtensionContext, contributed: ReadonlyMap<string, Contribution>): Footer {
  const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
  let git: Git | undefined;
  let home: string | undefined; // The main checkout's directory when cwd is in a linked worktree.
  let render = () => {};
  // Read from the directory, not asked of Git: nothing a sandbox guest left in the repository runs.
  const repo = trustedLayout(cwd);
  if (repo) home = worktreeHome(cwd, [repo.workTree, repo.gitDir, repo.commonDir].join("\n"));
  // pi.exec takes no environment, which is what names the repository for Git.
  const status = () => new Promise<string | undefined>((resolve) => {
    const call = hostGit(cwd, ["--no-optional-locks", "status", "--porcelain=v2", "--branch"]);
    execFile("git", call.args, { cwd, timeout: 5000, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: call.env }, (error, stdout) => resolve(error ? undefined : stdout));
  });
  // A colocated jj workspace: jj names the work, Git still counts the changed files.
  // --ignore-working-copy keeps the poll from snapshotting, which would record an
  // operation every time; jj commands the agent runs snapshot anyway.
  const jjTop = repo && existsSync(join(repo.workTree, ".jj")) ? repo.workTree : undefined;
  let jj: Jj | undefined;
  const describe = () => new Promise<string | undefined>((resolve) => {
    if (!jjTop) return resolve(undefined);
    execFile("jj", ["--no-pager", "--color=never", "--ignore-working-copy", "-R", jjTop, "log", "--no-graph", "-r", "@", "-T", JJ_TEMPLATE],
      { cwd, timeout: 5000, encoding: "utf8" }, (error, stdout) => resolve(error ? undefined : stdout));
  });
  let running = false, again = false, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seen: string | undefined;

  /** Whether the status differs from the last one read. */
  async function refreshGit(): Promise<boolean> {
    if (running) { again = true; return true; }
    running = true;
    let changed = false;
    try {
      const [output, described] = await Promise.all([status(), describe()]);
      const key = `${output}\0${described}`;
      changed = key !== seen;
      seen = key;
      git = output === undefined ? undefined : parseGitStatus(output);
      jj = described === undefined ? undefined : parseJj(described);
      if (!closed) render();
    } catch { git = undefined; }
    finally {
      running = false;
      if (again && !closed) { again = false; void refreshGit(); }
    }
    return changed;
  }
  // Every open pane has a session, most of them idle, and a status scans the
  // work tree for untracked files. The poll therefore slows down while it
  // finds nothing new, and does not run Git where there is no repository.
  const poll = backoff(async () => !closed && trustedLayout(cwd) ? refreshGit() : false, POLL_MS, IDLE_POLL_MS);
  // What Pi does starts the poll over: the next change outside it is likely soon.
  const scheduleGit = () => {
    if (closed) return;
    poll.reset();
    clearTimeout(timer);
    timer = setTimeout(refreshGit, DEBOUNCE_MS);
  };

  // The footer draws on every frame, and each of these walks the whole session,
  // so they are recomputed only when the branch or the model changes, as Pi's own footer does.
  let cached: { key: string; stats: Stats; auto: boolean; usage: ReturnType<ExtensionContext["getContextUsage"]> } | undefined;
  const stats = () => {
    const sm = ctx.sessionManager, model = ctx.model;
    const key = `${sm.getSessionId()}:${sm.getLeafId()}:${sm.getEntryCount?.() ?? sm.getEntries().length}:${model?.provider}/${model?.id}:${model?.contextWindow}`;
    if (cached?.key !== key) {
      const settings: any = pi.getSettings();
      cached = { key, stats: sessionStats(sm.getEntries()), auto: settings.compaction?.enabled !== false, usage: ctx.getContextUsage() };
    }
    return cached;
  };

  // The session name goes at the right end of the editor's top border; the footer shows it
  // only when the border did not, with another extension's editor or no room.
  let titled = false;
  const title: FeatureFactory = (editor) => ({
    topBorder(line) {
      const name = ctx.sessionManager.getSessionName();
      const drawn = name ? borderLabel(line, ctx.ui.theme.fg("dim", name), (text) => editor.borderColor(text), borderMeasure) : line;
      titled = drawn !== line;
      return drawn;
    },
  });
  useEditorFeature(ctx, TITLE_FEATURE, title);

  ctx.ui.setFooter((tui, theme, footerData) => {
    render = () => tui.requestRender();
    const offBranch = footerData.onBranchChange(() => { scheduleGit(); render(); });
    void refreshGit();

    return {
      dispose() { offBranch(); },
      invalidate() {},
      render(width: number): string[] {
        const dim = (text: string) => theme.fg("dim", text);
        const segments: Segment[] = [];
        const model = ctx.model;
        const extra = [...contributed].sort(([a], [b]) => a.localeCompare(b)).map(([, { text, color, priority, position }]) => {
          let painted: string;
          try { painted = theme.fg(color as any, text); } catch { painted = theme.fg("muted", text); }
          return { position, segment: { priority, text: painted } };
        });
        for (const { position, segment } of extra) if (position === "start") segments.push(segment);

        const path = displayPath(home ?? cwd, process.env.HOME);
        const base = path.split("/").pop() || path;
        const mark = home ? theme.fg("dim", " (wt)") : "";
        segments.push({ priority: 3, text: theme.fg("muted", `${icons.folder} ${path}`) + mark, compact: theme.fg("muted", `${icons.folder} ${base}`) + mark });

        const branch = footerData.getGitBranch() ?? git?.branch ?? (git?.oid ? `@${git.oid.slice(0, 7)}` : undefined);
        if (jj) {
          const marks: string[] = [];
          if (jj.conflict) marks.push(theme.fg("error", "!"));
          if (git?.changed) marks.push(theme.fg("warning", `*${git.changed}`));
          const head = theme.fg(git?.changed ? "warning" : "success", `${icons.branch} ${jjLabel(jj, Boolean(home))}`);
          segments.push({ priority: 4, text: [head, ...marks].join(" "), compact: head });
        } else if (branch) {
          const marks: string[] = [];
          if (git?.conflicts) marks.push(theme.fg("error", `!${git.conflicts}`));
          if (git?.staged) marks.push(theme.fg("success", `+${git.staged}`));
          if (git?.unstaged) marks.push(theme.fg("warning", `*${git.unstaged}`));
          if (git?.untracked) marks.push(theme.fg("muted", `?${git.untracked}`));
          if (git?.ahead) marks.push(theme.fg("accent", `⇡${git.ahead}`));
          if (git?.behind) marks.push(theme.fg("accent", `⇣${git.behind}`));
          const dirty = Boolean(git && (git.conflicts || git.staged || git.unstaged || git.untracked));
          const head = theme.fg(dirty ? "warning" : "success", `${icons.branch} ${branchLabel(branch, Boolean(home))}`);
          segments.push({ priority: 4, text: [head, ...marks].join(" "), compact: head });
        }

        // A reasoning model's icon is its thinking level, in that level's color.
        const thinking = model?.reasoning ? pi.getThinkingLevel() : undefined;
        const modelIcon = thinking ? theme.fg(thinkingColor(thinking) as any, thinkingIcon(thinking)) : theme.fg("text", icons.model);
        const modelText = `${modelIcon} ${theme.fg("text", modelLabel(model?.name ?? model?.id ?? "no model"))}`;
        segments.push({ priority: 7, side: "right", text: modelText });

        const { stats: { cost, cacheHit }, auto, usage } = stats();
        const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
        const percent = usage?.percent;
        const level = (percent ?? 0) > 90 ? "error" : (percent ?? 0) > 70 ? "warning" : "muted";
        const used = `${icons.context} ${percent == null ? "?" : `${Math.round(percent)}%`}`, autoMark = auto ? ` ${icons.auto}` : "";
        segments.push({ priority: 5, side: "right", text: theme.fg(level, `${used}/${formatTokens(window)}${autoMark}`), compact: theme.fg(level, `${used}${autoMark}`) });

        if (cacheHit !== undefined && cacheHit < CACHE_SHOWN_BELOW) {
          segments.push({ priority: 2, side: "right", text: theme.fg(cacheHit < 50 ? "warning" : "muted", `${icons.cache} ${Math.round(cacheHit)}%`) });
        }

        const subscription = model ? usingSubscription(ctx, model) : false;
        if (cost > 0 || subscription) segments.push({ priority: 1, side: "right", text: theme.fg("muted", formatCost(cost, subscription)) });

        for (const { position, segment } of extra) if (position === "end") segments.push({ ...segment, side: "right" });

        const sides = fitSegments(segments, dim(" · "), width, measure);
        const statuses = rightStatuses(footerData.getExtensionStatuses(), contributed);
        // The editor drew this frame's border, with the name when it fit, before the footer.
        const name = titled ? undefined : ctx.sessionManager.getSessionName();
        titled = false;
        return layout(sides, statuses, name ? dim(name) : undefined, width, measure);
      },
    };
  });

  return {
    refreshGit: scheduleGit,
    render: () => { if (!closed) render(); },
    close() {
      closed = true;
      clearTimeout(timer);
      poll.stop();
      dropEditorFeature(TITLE_FEATURE, title);
    },
  };
}

// Mirrors Pi's footer. The extension registry's isUsingOAuth takes a model, not a provider ID.
function usingSubscription(ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>): boolean {
  const registry: any = ctx.modelRegistry;
  if (model.provider === "kimi-coding") return true;
  try {
    return Boolean(registry.isUsingOAuth?.(model) && registry.getProvider?.(model.provider)?.auth?.oauth?.isSubscription);
  } catch { return false; }
}
