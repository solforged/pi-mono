import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
export const TITLE_SOURCE = "user:pi-title";
export const TITLE_TTL_MS = 90_000;
export const REFRESH_INTERVAL_MS = 30_000;
type ReportTitle = (binary: string, pane: string, title: string | undefined, signal: AbortSignal) => Promise<void>;
type Heartbeat = (refresh: () => void, intervalMs: number) => () => void;

export function paneTitle(name: string | undefined): string | undefined {
  const clean = (name ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(clean).slice(0, 80).join("") || undefined;
}

const reportTitle: ReportTitle = async (binary, pane, title, signal) => {
  // The CLI consumes the argument after --title literally, even leading dashes.
  const args = ["pane", "report-metadata", pane, "--source", TITLE_SOURCE, "--agent", "pi"];
  if (title === undefined) args.push("--clear-title");
  else args.push("--title", title, "--ttl-ms", String(TITLE_TTL_MS));
  await execFileAsync(binary, args, {
    signal, timeout: 2000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
  });
};

const heartbeat: Heartbeat = (refresh, intervalMs) => {
  const timer = setInterval(refresh, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};

export function registerHerdrTitle(pi: ExtensionAPI, env = process.env, report: ReportTitle = reportTitle, schedule: Heartbeat = heartbeat) {
  const pane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !pane) return;
  const binary = env.HERDR_BIN_PATH || "herdr";
  const controller = new AbortController();
  let active = false;
  let stopped = false;
  let revision = 0;
  let desiredTitle: string | undefined;
  let appliedTitle: string | undefined;
  let hasReported = false;
  let stopHeartbeat: (() => void) | undefined;
  let shutdown: Promise<void> | undefined;
  let queue = Promise.resolve();

  function publish(refresh = false): Promise<void> {
    if (!active || stopped) return queue;
    const title = desiredTitle;
    const requested = ++revision;
    queue = queue.then(async () => {
      if (stopped || requested !== revision || (!refresh && hasReported && title === appliedTitle)) return;
      try {
        await report(binary, pane, title, controller.signal);
        appliedTitle = title;
        hasReported = true;
      } catch {
        // Fail open; a heartbeat or later event retries even after an ambiguous failure.
        hasReported = false;
      }
    });
    return queue;
  }

  pi.on("session_start", (_event, ctx) => {
    // Child agents inherit Herdr's environment; only a pane's TUI owns metadata.
    if (stopped || ctx.mode !== "tui") return;
    active = true;
    desiredTitle = paneTitle(pi.getSessionName());
    stopHeartbeat ??= schedule(() => { void publish(desiredTitle !== undefined); }, REFRESH_INTERVAL_MS);
    // A fixed source replaces or clears stale metadata from a crashed runtime.
    // Pi waits for what a handler returns, and a hung CLI takes its whole
    // time limit, so outside shutdown reports are started and not awaited.
    void publish(true);
  });
  pi.on("session_info_changed", (event, ctx) => {
    if (!active || stopped || ctx.mode !== "tui") return;
    desiredTitle = paneTitle(event.name);
    void publish();
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!active || stopped || ctx.mode !== "tui") return;
    desiredTitle = paneTitle(pi.getSessionName());
    void publish();
  });
  pi.on("session_shutdown", () => {
    if (shutdown) return shutdown;
    stopped = true;
    stopHeartbeat?.();
    controller.abort();
    shutdown = (async () => {
      await queue;
      if (!active) return;
      try {
        // Cleanup needs a fresh signal after aborting in-flight title writes.
        // Clear only our source's title, never manual labels or agent authority.
        await report(binary, pane, undefined, new AbortController().signal);
      } catch {
        // The last successful title expires within TITLE_TTL_MS without refresh.
      }
    })();
    return shutdown;
  });
}

export default function (pi: ExtensionAPI) {
  registerHerdrTitle(pi);
}
