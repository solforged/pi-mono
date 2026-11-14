// Runs Vale over a Markdown file before and after an edit and keeps only the
// alerts the edit introduced, so the agent hears about its own prose and not
// about every old problem in the file.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export type Alert = { Check: string; Message: string; Match: string; Line: number; Severity: string };

/** Markdown files, the only kind the house style's Vale config lints. */
export const isProse = (path: string) => /\.(?:md|mdx|markdown)$/i.test(path);

/**
 * Spelling rules report every project name and identifier in a repository
 * without a vocabulary, which buries the style alerts. Projects that gate on
 * spelling run Vale themselves.
 */
const SKIPPED = /(?:^|\.)Spelling(?:Compound)?$/;

/**
 * Lints `text` as if it were the file at `path`, so the project's .vale.ini
 * and path sections such as `[**\/README.md]` apply. Resolves to no alerts
 * when Vale is missing, fails, or reports a configuration error.
 */
export function vale(text: string, path: string, options: { signal?: AbortSignal; args?: string[]; bin?: string } = {}): Promise<Alert[]> {
  const args = [...(options.args ?? []), "--output=JSON", "--no-exit", "--minAlertLevel=warning", `--path=${path}`];
  // Vale finds the project's .vale.ini from its working directory upward.
  let cwd = dirname(path);
  while (!existsSync(cwd) && dirname(cwd) !== cwd) cwd = dirname(cwd);
  return new Promise(resolve => {
    const child = execFile(options.bin ?? "vale", args, { cwd, timeout: 10_000, maxBuffer: 8 << 20, signal: options.signal }, (error, stdout) => {
      if (error) return resolve([]);
      try {
        const parsed = JSON.parse(stdout || "{}");
        // A configuration error is a single object with a Code, not a file map.
        if (!parsed || typeof parsed !== "object" || "Code" in parsed) return resolve([]);
        const alerts = Object.values(parsed).flat() as Alert[];
        resolve(alerts.filter(alert => alert && typeof alert.Check === "string" && !SKIPPED.test(alert.Check)));
      } catch {
        resolve([]);
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  });
}

/** Alerts in `after` beyond those already in `before`, matched by rule and matched text, not line. */
export function introduced(before: Alert[], after: Alert[]): Alert[] {
  const key = (alert: Alert) => `${alert.Check}\u0000${alert.Match}`;
  const seen = new Map<string, number>();
  for (const alert of before) seen.set(key(alert), (seen.get(key(alert)) ?? 0) + 1);
  return after.filter(alert => {
    const left = seen.get(key(alert)) ?? 0;
    if (left === 0) return true;
    seen.set(key(alert), left - 1);
    return false;
  });
}

const SHOWN = 6;

/** The note appended to the tool result: a few short lines, never the whole report. */
export function note(alerts: Alert[], shownPath: string): string {
  const lines = alerts
    .slice()
    .sort((a, b) => a.Line - b.Line)
    .slice(0, SHOWN)
    .map(alert => `- line ${alert.Line}, ${alert.Check}: ${alert.Message}`);
  if (alerts.length > SHOWN) lines.push(`- and ${alerts.length - SHOWN} more`);
  const count = alerts.length === 1 ? "1 style alert" : `${alerts.length} style alerts`;
  return [`Vale: this edit added ${count} to ${shownPath}. Revise the prose, or keep a passage that is right as written.`, ...lines].join("\n");
}
