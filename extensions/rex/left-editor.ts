import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { LeftGate } from "./hub-model.ts";

const MARK = Symbol.for("pi-mono.rex.left-editor");

/**
 * Pi's editor, except that ← on an empty prompt calls `onLeft` (as ctrl+d exits
 * only when empty). The editor only sees keys while it has focus, so dialogs
 * keep their own ←. Another extension's editor is left alone: returns false.
 */
export function installLeftArrow(ctx: ExtensionContext, onLeft: () => void, onArm: () => void): boolean {
  const current = ctx.ui.getEditorComponent() as any;
  if (current && !current[MARK]) return false;
  const gate = new LeftGate();
  const factory: any = (tui: any, theme: any, keybindings: any) => new (class extends CustomEditor {
    handleInput(data: string) {
      if (matchesKey(data, "left") && !this.isShowingAutocomplete()) {
        const step = gate.left(this.getText() === "", Date.now());
        if (step === "open") return onLeft();
        if (step === "arm") return onArm();
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
