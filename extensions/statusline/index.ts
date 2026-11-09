import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  displayPath, fitSegments, formatCost, formatTokens, icons, layout, parseGitStatus, sessionStats,
  modelLabel, thinkingColor, thinkingIcon, thinkingLabel, type Git, type Segment, type Stats,
} from "./format.ts";

const POLL_MS = 10_000; // Catches changes made outside Pi.
const DEBOUNCE_MS = 300;
const measure = { width: visibleWidth, truncate: (text: string, width: number) => truncateToWidth(text, width, "…") };

type Footer = { refreshGit: () => void; render: () => void; close: () => void };

export default function (pi: ExtensionAPI) {
  let footer: Footer | undefined;
  const close = () => { footer?.close(); footer = undefined; };

  pi.on("session_start", (_event, ctx) => {
    close();
    if (ctx.mode === "tui") footer = install(pi, ctx);
  });
  pi.on("session_shutdown", close);
  pi.on("tool_execution_end", () => footer?.refreshGit());
  pi.on("agent_end", () => footer?.refreshGit());
  pi.on("user_bash", () => { setTimeout(() => footer?.refreshGit(), 1000); });
  pi.on("model_select", () => footer?.render());
  pi.on("thinking_level_select", () => footer?.render());
}

function install(pi: ExtensionAPI, ctx: ExtensionContext): Footer {
  const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
  let git: Git | undefined;
  let render = () => {};
  let running = false, again = false, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function refreshGit() {
    if (running) { again = true; return; }
    running = true;
    try {
      const result = await pi.exec("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], { cwd, timeout: 5000 });
      git = result.code === 0 ? parseGitStatus(result.stdout) : undefined;
      if (!closed) render();
    } catch { git = undefined; }
    finally {
      running = false;
      if (again && !closed) { again = false; void refreshGit(); }
    }
  }
  const scheduleGit = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(refreshGit, DEBOUNCE_MS);
  };
  const poll = setInterval(scheduleGit, POLL_MS);
  poll.unref?.();

  let cached: { key: string; stats: Stats; auto: boolean } | undefined;
  const stats = () => {
    const sm = ctx.sessionManager;
    const key = `${sm.getSessionId()}:${sm.getLeafId()}:${sm.getEntryCount?.() ?? sm.getEntries().length}`;
    if (cached?.key !== key) {
      const settings: any = pi.getSettings();
      cached = { key, stats: sessionStats(sm.getEntries()), auto: settings.compaction?.enabled !== false };
    }
    return cached;
  };

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

        segments.push({ priority: 7, text: theme.fg("text", `${icons.model} ${modelLabel(model?.name ?? model?.id ?? "no model")}`) });

        if (model?.reasoning) {
          const level = pi.getThinkingLevel();
          segments.push({ priority: 6, text: theme.fg(thinkingColor(level) as any, `${thinkingIcon(level)} ${thinkingLabel(level)}`) });
        }

        const path = displayPath(cwd, process.env.HOME);
        const base = path.split("/").pop() || path;
        segments.push({ priority: 3, text: theme.fg("muted", `${icons.folder} ${path}`), compact: theme.fg("muted", `${icons.folder} ${base}`) });

        const branch = footerData.getGitBranch() ?? git?.branch ?? (git?.oid ? `@${git.oid.slice(0, 7)}` : undefined);
        if (branch) {
          const marks: string[] = [];
          if (git?.conflicts) marks.push(theme.fg("error", `!${git.conflicts}`));
          if (git?.staged) marks.push(theme.fg("success", `+${git.staged}`));
          if (git?.unstaged) marks.push(theme.fg("warning", `*${git.unstaged}`));
          if (git?.untracked) marks.push(theme.fg("muted", `?${git.untracked}`));
          if (git?.ahead) marks.push(theme.fg("accent", `⇡${git.ahead}`));
          if (git?.behind) marks.push(theme.fg("accent", `⇣${git.behind}`));
          const dirty = Boolean(git && (git.conflicts || git.staged || git.unstaged || git.untracked));
          const head = theme.fg(dirty ? "warning" : "success", `${icons.branch} ${branch}`);
          segments.push({ priority: 4, text: [head, ...marks].join(" "), compact: head });
        }

        const { stats: { cost, cacheHit }, auto } = stats();
        const usage = ctx.getContextUsage();
        const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
        const percent = usage?.percent;
        const level = (percent ?? 0) > 90 ? "error" : (percent ?? 0) > 70 ? "warning" : "muted";
        const contextText = `${percent == null ? "?" : `${percent.toFixed(1)}%`}/${formatTokens(window)}`;
        segments.push({ priority: 5, text: theme.fg(level, `${icons.context} ${contextText}${auto ? ` ${icons.auto}` : ""}`) });

        if (cacheHit !== undefined) {
          segments.push({ priority: 2, text: theme.fg(cacheHit < 50 ? "warning" : "muted", `${icons.cache} ${Math.round(cacheHit)}%`) });
        }

        const subscription = model ? usingSubscription(ctx, model) : false;
        if (cost > 0 || subscription) segments.push({ priority: 1, text: theme.fg("muted", formatCost(cost, subscription)) });

        const left = fitSegments(segments, dim(" · "), width, measure);
        const statuses = [...footerData.getExtensionStatuses().entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => text.replace(/[\r\n\t]+/g, " ").trim())
          .filter(Boolean);
        const name = ctx.sessionManager.getSessionName();
        return layout(left, statuses, name ? dim(name) : undefined, width, measure);
      },
    };
  });

  return {
    refreshGit: scheduleGit,
    render: () => { if (!closed) render(); },
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(poll);
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
