import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { counts, ordered, type Item, type List } from "./store.ts";

export type PanelAction = { kind: "toggle" | "menu"; id: number } | { kind: "add" | "clear" };

const rows = 15;
const key = (data: string, name: string) => data === name || matchesKey(data, name);

// One interaction per call: the command applies the chosen action and reopens the panel.
export function showPanel(ctx: ExtensionCommandContext, list: List, selectedId?: number) {
  return ctx.ui.custom<PanelAction | undefined>((tui, theme, keybindings, done) => {
    const items = ordered(list.items);
    let index = Math.max(0, items.findIndex((item) => item.id === selectedId));
    const mark = (item: Item) => item.status === "done" ? theme.fg("success", "✓")
      : item.status === "in_progress" ? theme.fg("accent", "▸") : theme.fg("dim", "○");
    return {
      render(width: number): string[] {
        const { open, done: finished } = counts(list.items);
        const lines = [theme.fg("accent", theme.bold("Session todos")) + theme.fg("muted", `  ${open} open, ${finished} done`), ""];
        if (!items.length) lines.push(theme.fg("dim", "  The list is empty. Press a to add an item."));
        const start = Math.min(Math.max(0, index - Math.floor(rows / 2)), Math.max(0, items.length - rows));
        items.slice(start, start + rows).forEach((item, offset) => {
          const selected = start + offset === index;
          const text = item.status === "done" ? theme.fg("dim", item.text) : item.text;
          const note = item.note ? theme.fg("dim", `  ${item.note}`) : "";
          lines.push(`${selected ? theme.fg("accent", "›") : " "} ${mark(item)} ${theme.fg("muted", `#${item.id}`)} ${text}${note}`);
        });
        if (items.length > rows) lines.push(theme.fg("dim", `  ${index + 1} of ${items.length}`));
        lines.push("", theme.fg("dim", "↑/↓ move · space done/reopen · enter actions · a add · c clear done · esc close"));
        return lines.map((text) => truncateToWidth(text, width));
      },
      handleInput(data: string): void {
        const item = items[index];
        if (keybindings.matches(data, "tui.select.cancel") || key(data, "q")) return done(undefined);
        if (keybindings.matches(data, "tui.select.up")) index = Math.max(0, index - 1);
        else if (keybindings.matches(data, "tui.select.down")) index = Math.max(0, Math.min(items.length - 1, index + 1));
        else if (item && (data === " " || matchesKey(data, Key.space))) return done({ kind: "toggle", id: item.id });
        else if (item && keybindings.matches(data, "tui.select.confirm")) return done({ kind: "menu", id: item.id });
        else if (key(data, "a")) return done({ kind: "add" });
        else if (key(data, "c")) return done({ kind: "clear" });
        else return;
        tui.requestRender();
      },
      invalidate() {},
    };
  });
}
