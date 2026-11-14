import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { useEditorFeature } from "../shared/editor.ts";
import { LeftGate } from "./ui.ts";

/**
 * Pi's editor, except that ← on an empty prompt calls `onLeft` (as ctrl+d exits
 * only when empty). The editor only sees keys while it has focus, so dialogs
 * keep their own ←. Another extension's editor is left alone: returns false.
 */
export function installLeftArrow(ctx: Pick<ExtensionContext, "ui">, onLeft: () => void, armHint: string): boolean {
  return useEditorFeature(ctx, "rex-left", (editor, tui) => {
    const gate = new LeftGate();
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    const clearHint = () => {
      if (!hintTimer) return;
      clearTimeout(hintTimer); hintTimer = undefined; tui.requestRender();
    };
    return {
      dispose: clearHint,
      topBorder(line, width) {
        if (!hintTimer) return line;
        const text = truncateToWidth(`─ ${armHint} `, width);
        return editor.borderColor(text + "─".repeat(Math.max(0, width - visibleWidth(text))));
      },
      input(data, next) {
        clearHint();
        if (matchesKey(data, "left") && !editor.isShowingAutocomplete()) {
          const step = gate.left(editor.getText() === "", Date.now());
          if (step === "open") return onLeft();
          if (step === "arm") {
            // Transient editor feedback, not a notification left in the transcript.
            hintTimer = setTimeout(clearHint, 2000); hintTimer.unref?.();
            tui.requestRender(); return;
          }
        }
        const had = editor.getText() !== "";
        next();
        gate.edited(had || editor.getText() !== "", Date.now());
      },
    };
  });
}
