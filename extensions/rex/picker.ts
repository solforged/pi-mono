import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { HINT, KEYS, pickerRow, widgetLine, type PickAction, type Row } from "./ui.ts";

export function widget(items: Row[]) {
  return (_tui: unknown, theme: any) => ({
    render: (width: number) => [truncateToWidth(widgetLine(items, theme), width)],
    invalidate() {},
  });
}

/** One picker for all child controls; actions run after it closes. */
export function pick(ctx: ExtensionContext, items: Row[]): Promise<{ id: string; action: PickAction } | undefined> {
  return ctx.ui.custom<{ id: string; action: PickAction } | undefined>((tui, theme, _keys, done) => {
    let index = 0; // Rows are sorted attention-first.
    return {
      render(width: number) {
        const lines = [theme.fg("accent", theme.bold("Rex agents"))];
        for (const [i, r] of items.entries()) lines.push(truncateToWidth(pickerRow(r, i === index, theme), width));
        if (!items.length) lines.push(theme.fg("muted", "  No Rex children in this session."));
        lines.push(theme.fg("dim", truncateToWidth(HINT, width)));
        return lines;
      },
      handleInput(data: string) {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return done(undefined);
        if (matchesKey(data, "up")) index = Math.max(0, index - 1);
        else if (matchesKey(data, "down")) index = Math.min(items.length - 1, index + 1);
        else {
          const action = KEYS[matchesKey(data, "enter") ? "enter" : data];
          if (action && items[index]) return done({ id: items[index].id, action });
        }
        tui.requestRender();
      },
      invalidate() {},
    };
  });
}
