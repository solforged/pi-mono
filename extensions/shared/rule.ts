// The heading rule widgets share with the editor's top border:
// `─ left ──────── right ─`. No Pi imports, so the tests run under plain Node;
// terminal measurement comes in as a Measure.

export interface Measure {
  width(text: string): number;
  truncate(text: string, width: number): string;
}

/**
 * A full-width rule with `left` after its first stroke and `right` before its
 * last. `paint` colours the strokes; `fill(n)` draws the n columns between the
 * two sides, plain strokes by default. A tight width drops `right` first, then
 * truncates `left`.
 */
export function headingRule(m: Measure, width: number, left: string, right: string, paint: (text: string) => string,
  fill = (n: number) => paint("─".repeat(n))): string {
  const room = (r: string) => width - 3 - m.width(left) - (r ? m.width(r) + 3 : 0);
  if (right && room(right) < 3) right = "";
  const n = room(right);
  const end = right ? ` ${right} ${paint("─")}` : "";
  if (n >= 1) return `${paint("─")} ${left} ${fill(n)}${end}`;
  return m.truncate(`${paint("─")} ${left}`, width);
}
