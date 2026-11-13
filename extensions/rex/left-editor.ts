import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { LeftGate } from "./hub-model.ts";

const MARK = Symbol.for("pi-mono.rex.left-editor");

/**
 * Pi's editor, except that ← on an empty prompt calls `onLeft` (as ctrl+d exits
 * only when empty). The editor only sees keys while it has focus, so dialogs
 * keep their own ←. Another extension's editor is left alone: returns false.
 */
export function installLeftArrow(ctx: ExtensionContext, onLeft: () => void, armHint: string): boolean {
  const current = ctx.ui.getEditorComponent() as any;
  if (current && !current[MARK]) return false;
  const gate = new LeftGate();
  const factory: any = (tui: any, theme: any, keybindings: any) => new (class extends CustomEditor {
    private hintTimer?: ReturnType<typeof setTimeout>;
    private clearHint() {
      if (!this.hintTimer) return;
      clearTimeout(this.hintTimer); this.hintTimer = undefined; tui.requestRender();
    }
    dispose() { this.clearHint(); }
    renderTopBorder(width: number, hidden: number) {
      if (!this.hintTimer) return super.renderTopBorder(width, hidden);
      const text = truncateToWidth(`─ ${armHint} `, width);
      return this.borderColor(text + "─".repeat(Math.max(0, width - visibleWidth(text))));
    }
    handleInput(data: string) {
      this.clearHint();
      if (matchesKey(data, "left") && !this.isShowingAutocomplete()) {
        const step = gate.left(this.getText() === "", Date.now());
        if (step === "open") return onLeft();
        if (step === "arm") {
          // Transient editor feedback, not a notification left in the transcript.
          this.hintTimer = setTimeout(() => this.clearHint(), 2000); this.hintTimer.unref?.();
          tui.requestRender(); return;
        }
      }
      const had = this.getText() !== "";
      super.handleInput(data);
      gate.edited(had || this.getText() !== "", Date.now());
    }
  })(tui, theme, keybindings);
  factory[MARK] = true;
  ctx.ui.setEditorComponent(factory);
  return true;
}
