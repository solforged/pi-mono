// One status vocabulary for every extension that shows work in progress: the
// Rex widget and tool rows, workflowz pools, and their receipts. A state has
// one glyph and one tone everywhere, and numbers read the same way.

export type Tone = "accent" | "success" | "error" | "warning" | "muted" | "dim" | "borderMuted";
export type Theme = { fg(tone: Tone, text: string): string; bold?(text: string): string };
export type State = "attention" | "working" | "starting" | "done" | "failed" | "cancelled" | "idle" | "yours";

export const STATES: Record<State, [glyph: string, tone: Tone]> = {
  attention: ["!", "warning"], working: ["●", "accent"], starting: ["◌", "dim"], done: ["✓", "success"],
  failed: ["✗", "error"], cancelled: ["–", "warning"], idle: ["○", "muted"], yours: ["◆", "muted"],
};
export const glyph = (state: State, theme: Theme) => theme.fg(STATES[state][1], STATES[state][0]);

export const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
export function duration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
export const money = (dollars: number) => `$${dollars < 10 ? dollars.toFixed(2) : dollars.toFixed(1)}`;
/** How far along: `3/5`. Nothing when there is no count to show. */
export const fraction = (progress?: { done: number; total: number }) => progress && progress.total > 0 ? `${progress.done}/${progress.total}` : "";
/** The same as a 0–100 percentage, for terminal progress reports. */
export const percent = (progress?: { done: number; total: number }) => progress && progress.total > 0 ? Math.round(100 * progress.done / progress.total) : undefined;
