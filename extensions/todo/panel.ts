import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { ordered, type List } from "./store.ts";
import { panelLines } from "./view.ts";

export type PanelAction = { kind: "toggle" | "menu" | "note"; id: number } | { kind: "add" | "clear" };

const key = (data: string, name: string) => data === name || matchesKey(data, name);
// Rows of the terminal left for the list after the frame, hints and editor chrome.
const bodyRows = () => Math.max(8, Math.min(24, (process.stdout.rows || 30) - 12));

// One interaction per call: the command applies the chosen action and reopens the panel.
export function showPanel(ctx: ExtensionCommandContext, list: List, selectedId?: number) {
  return ctx.ui.custom<PanelAction | undefined>((tui, theme, keybindings, done) => {
    const items = ordered(list.items);
    let index = Math.max(0, items.findIndex((item) => item.id === selectedId));
    return {
      render: (width: number) => panelLines(list, index, width, bodyRows(), theme),
      handleInput(data: string): void {
        const item = items[index];
        if (keybindings.matches(data, "tui.select.cancel") || key(data, "q")) return done(undefined);
        if (keybindings.matches(data, "tui.select.up")) index = Math.max(0, index - 1);
        else if (keybindings.matches(data, "tui.select.down")) index = Math.max(0, Math.min(items.length - 1, index + 1));
        else if (item && (data === " " || matchesKey(data, Key.space))) return done({ kind: "toggle", id: item.id });
        else if (item && keybindings.matches(data, "tui.select.confirm")) return done({ kind: "menu", id: item.id });
        else if (item && key(data, "n")) return done({ kind: "note", id: item.id });
        else if (key(data, "a")) return done({ kind: "add" });
        else if (key(data, "c")) return done({ kind: "clear" });
        else return;
        tui.requestRender();
      },
      invalidate() {},
    };
  });
}
