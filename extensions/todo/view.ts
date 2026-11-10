// Terminal rendering shared by the /todos panel, the widget and tool results.
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { counts, ordered, upNext, type Item, type List, type Status } from "./store.ts";

export interface Theme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
}

const sections: Array<[Status, string]> = [["in_progress", "IN PROGRESS"], ["blocked", "BLOCKED"], ["pending", "PENDING"], ["done", "DONE"]];
const maxWidth = 88;
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));
const fitTo = (text: string, width: number) => pad(truncateToWidth(text, Math.max(0, width)), width);

export function mark(item: Item, theme: Theme) {
  switch (item.status) {
    case "done": return theme.fg("success", "✓");
    case "in_progress": return theme.fg("accent", "▸");
    case "blocked": return theme.fg("warning", "⊘");
    default: return theme.fg("dim", "○");
  }
}

/** The item's text, struck through once done, with a blocked item's reason after it. */
export function label(item: Item, theme: Theme, withReason = true) {
  if (item.status === "done") return theme.fg("dim", theme.strikethrough(item.text));
  const reason = withReason && item.status === "blocked" && item.note ? theme.fg("dim", " · ") + theme.fg("warning", item.note) : "";
  return item.text + reason;
}

export function bar(done: number, total: number, width: number, theme: Theme) {
  const filled = total ? Math.round((done / total) * width) : 0;
  return theme.fg("success", "━".repeat(filled)) + theme.fg("borderMuted", "━".repeat(Math.max(0, width - filled)));
}

const row = (item: Item, theme: Theme) => `${mark(item, theme)} ${label(item, theme)} ${theme.fg("dim", `#${item.id}`)}`;

/** The widget above the editor: progress, then the work in view, beside it when there is room. */
export function widgetLines(list: List, width: number, theme: Theme): string[] {
  const { items, hidden } = upNext(list);
  if (!items.length) return [];
  const { done } = counts(list.items);
  const head = `${theme.fg("accent", theme.bold("Todo"))} ${bar(done, list.items.length, 10, theme)} ${theme.fg("muted", `${done}/${list.items.length}`)}`;
  const more = hidden ? theme.fg("dim", `+${hidden} more · /todos`) : "";
  const indent = visibleWidth(head) + 3;
  const lines = width >= indent + 40
    ? items.map((item, index) => (index ? " ".repeat(indent) : `${head}   `) + row(item, theme))
    : [head, ...items.map((item) => ` ${row(item, theme)}`)];
  if (more) {
    const last = lines.length - 1;
    if (visibleWidth(lines[last]) + 3 + visibleWidth(more) <= width) lines[last] += `   ${more}`;
    else lines.push(" ".repeat(width >= indent + 40 ? indent : 1) + more);
  }
  return lines.map((line) => truncateToWidth(line, width));
}

/** Tool-result rows: the open work in view, or every item when expanded. */
export function resultRows(list: List, expanded: boolean, theme: Theme): { lines: string[]; hidden: number } {
  const { items, hidden } = expanded ? { items: ordered(list.items), hidden: 0 } : upNext(list, 5);
  return { lines: items.map((item) => row(item, theme)), hidden: expanded ? 0 : hidden + counts(list.items).done };
}

export const hints: Array<[string, string]> = [["↑↓", "move"], ["space", "done"], ["⏎", "actions"], ["a", "add"], ["n", "note"], ["c", "clear done"], ["esc", "close"]];

/**
 * The /todos panel: a framed list grouped by status with a progress bar. The
 * selected row is highlighted and shows its note; blocked rows always show
 * their reason. The body scrolls to keep the selection in view.
 */
export function panelLines(list: List, selected: number, available: number, maxBody: number, theme: Theme): string[] {
  // Wider panels only push the IDs away from their text.
  const width = Math.min(available, maxWidth);
  const items = ordered(list.items);
  const { done } = counts(list.items);
  const framed = width >= 50;
  const inner = framed ? width - 4 : width;
  const border = (text: string) => theme.fg("borderMuted", text);

  const body: string[] = [];
  let focus = [0, 0];
  const add = (text: string) => body.push(fitTo(text, inner));
  if (!items.length) add(theme.fg("dim", "The list is empty. Press a to add an item."));
  for (const [status, title] of sections) {
    const group = items.filter((item) => item.status === status);
    if (!group.length) continue;
    if (body.length) add("");
    add(theme.fg("dim", status === "done" ? `${title} · ${group.length}` : title));
    for (const item of group) {
      const chosen = items[selected] === item;
      const id = theme.fg("dim", `#${item.id}`);
      const text = truncateToWidth(`${mark(item, theme)} ${label(item, theme, false)}`, inner - visibleWidth(id) - 4);
      const lines = [pad(`${chosen ? theme.fg("accent", "▌") : " "}${text}`, inner - visibleWidth(id) - 1) + id + " "];
      if (item.note && (chosen || item.status === "blocked")) {
        const tone = item.status === "blocked" ? "warning" : "muted";
        for (const part of wrapTextWithAnsi(item.note, inner - 6).slice(0, chosen ? 3 : 1)) {
          lines.push(`${chosen ? theme.fg("accent", "▌") : " "}  ${theme.fg(tone, `↳ ${part}`)}`);
        }
      }
      if (chosen) focus = [body.length, lines.length];
      for (const line of lines) body.push(chosen ? theme.bg("selectedBg", fitTo(line, inner)) : fitTo(line, inner));
    }
  }

  // Keep the selection centred when the body is taller than the room.
  let start = 0;
  if (body.length > maxBody) start = Math.min(Math.max(0, focus[0] - Math.floor((maxBody - focus[1]) / 2)), body.length - maxBody);
  const shown = body.slice(start, start + maxBody);
  const position = body.length > maxBody ? ` ${selected + 1} of ${items.length} ` : "";

  const status = theme.fg("muted", `${done} of ${items.length} done`);
  // Key hints wrap whole hints onto further lines rather than being cut off.
  const keys: string[] = [];
  for (const [key, text] of hints) {
    const hint = `${theme.fg("muted", key)} ${theme.fg("dim", text)}`;
    const joined = keys.length ? `${keys.at(-1)}${theme.fg("dim", " · ")}${hint}` : ` ${hint}`;
    if (keys.length && visibleWidth(joined) <= width) keys[keys.length - 1] = joined;
    else keys.push(` ${hint}`);
  }
  if (!framed) {
    return [`${theme.fg("accent", theme.bold("Session todos"))}  ${status}`, bar(done, items.length, Math.min(inner, 40), theme), "", ...shown,
      ...(position ? [theme.fg("dim", position.trim())] : []), "", ...keys].map((line) => truncateToWidth(line, width));
  }
  const title = ` ${theme.fg("accent", theme.bold("Session todos"))} `;
  const top = border("╭─") + title + border("─".repeat(Math.max(1, width - 6 - visibleWidth(title) - visibleWidth(status)))) + ` ${status} ` + border("─╮");
  const bottom = border("╰─") + theme.fg("dim", position) + border("─".repeat(Math.max(1, width - 3 - visibleWidth(position)))) + border("╯");
  const side = (text: string) => `${border("│")} ${text} ${border("│")}`;
  return [top, side(bar(done, items.length, inner, theme)), side(" ".repeat(inner)), ...shown.map(side), bottom, ...keys]
    .map((line) => truncateToWidth(line, width));
}
