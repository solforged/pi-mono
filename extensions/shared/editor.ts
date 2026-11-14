// One prompt editor that several extensions add to. Pi takes a single editor
// factory, so extensions that each installed their own would replace one
// another; here each registers a feature under a key instead.
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type EditorFeature = {
  /** Rewrites the top border, after Pi's working status and scroll marker. */
  topBorder?(line: string, width: number): string;
  /** Sees each key before the editor; calls `next` to pass it on. */
  input?(data: string, next: () => void): void;
  dispose?(): void;
};
type Tui = { requestRender(): void };
export type FeatureFactory = (editor: CustomEditor, tui: Tui) => EditorFeature;

// Global, not module state: each extension loads its own copy of this file.
const features: Map<string, FeatureFactory> = ((globalThis as any)[Symbol.for("pi-mono.editor.features")] ??= new Map());
const MARK = Symbol.for("pi-mono.editor");

class SharedEditor extends CustomEditor {
  private live = new Map<string, { factory: FeatureFactory; feature: EditorFeature }>();
  private tui: Tui;

  constructor(tui: Tui, theme: any, keybindings: any) {
    // As Pi's own editor: the working status goes in the top border, not on a line above it.
    super(tui as any, theme, keybindings, { embedWorkingStatus: true });
    this.tui = tui;
  }

  // Features registered or removed after the editor was made apply from the next render or key.
  private sync() {
    for (const [key, entry] of this.live) {
      if (features.get(key) !== entry.factory) { this.live.delete(key); entry.feature.dispose?.(); }
    }
    for (const [key, factory] of features) {
      if (!this.live.has(key)) this.live.set(key, { factory, feature: factory(this, this.tui) });
    }
    return [...this.live.values()].map((entry) => entry.feature);
  }

  renderTopBorder(width: number, hidden: number): string {
    let line = super.renderTopBorder(width, hidden);
    for (const feature of this.sync()) {
      try { if (feature.topBorder) line = feature.topBorder(line, width); } catch {}
    }
    return line;
  }

  handleInput(data: string) {
    const chain = this.sync().filter((feature) => feature.input);
    const step = (i: number): void => i < chain.length ? chain[i].input!(data, () => step(i + 1)) : super.handleInput(data);
    step(0);
  }

  dispose() {
    for (const { feature } of this.live.values()) feature.dispose?.();
    this.live.clear();
  }
}

/**
 * Adds a feature to the prompt editor, replacing the one with the same key,
 * and installs the editor unless another extension's is in place.
 * Returns whether the feature is active; it stays registered either way.
 */
export function useEditorFeature(ctx: Pick<ExtensionContext, "ui">, key: string, factory: FeatureFactory): boolean {
  features.set(key, factory);
  const current = ctx.ui.getEditorComponent() as any;
  if (current?.[MARK]) return true;
  if (current) return false;
  const editor: any = (tui: any, theme: any, keybindings: any) => new SharedEditor(tui, theme, keybindings);
  editor[MARK] = true;
  ctx.ui.setEditorComponent(editor);
  return true;
}

/** Removes a feature; the editor drops it at its next render. */
export function dropEditorFeature(key: string, factory?: FeatureFactory) {
  if (!factory || features.get(key) === factory) features.delete(key);
}
