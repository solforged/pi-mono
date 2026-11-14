// One prompt editor that several extensions add to. Pi takes a single editor
// factory, so extensions that each installed their own would replace one
// another; here each registers a feature under a key instead.
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type EditorFeature = {
  /** Rewrites the top border, after Pi's working status and scroll marker. */
  topBorder?(line: string, width: number): string;
  /** Sees each key before the editor; calls `next` to pass it on. */
  input?(data: string, next: () => void): void;
  /** Rewrites text Pi puts at the cursor, such as a pasted image's path; typing and terminal pastes do not come here. */
  insert?(text: string): string;
  /** Rewrites each rendered line, for display only. */
  line?(line: string): string;
  dispose?(): void;
};
type Tui = { requestRender(): void };
export type Editor = CustomEditor & {
  /**
   * Holds `content` behind a marker that the editor moves over, deletes and
   * undoes as one character and expands on submit, as it does a long paste.
   * Returns the marker, or `content` itself if Pi's editor no longer allows it.
   */
  atom(content: string): string;
  /** What the marker `[paste #id]` stands for, if anything. */
  atomContent(id: number): string | undefined;
};
export type FeatureFactory = (editor: Editor, tui: Tui) => EditorFeature;

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
      if (!this.live.has(key)) this.live.set(key, { factory, feature: factory(this as Editor, this.tui) });
    }
    return [...this.live.values()].map((entry) => entry.feature);
  }

  // Pi's long-paste store, which its marker handling and submit read.
  private get store(): { pastes: Map<number, string>; pasteCounter: number } | undefined {
    const self = this as any;
    return self.pastes instanceof Map && typeof self.pasteCounter === "number" ? self : undefined;
  }

  atom(content: string): string {
    const store = this.store;
    if (!store) return content;
    const id = ++store.pasteCounter;
    store.pastes.set(id, content);
    return `[paste #${id}]`;
  }

  atomContent(id: number): string | undefined {
    return this.store?.pastes.get(id);
  }

  insertTextAtCursor(text: string) {
    for (const feature of this.sync()) {
      try { if (feature.insert) text = feature.insert(text); } catch {}
    }
    super.insertTextAtCursor(text);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    const rewrites = this.sync().filter((feature) => feature.line);
    if (!rewrites.length) return lines;
    return lines.map((line) => rewrites.reduce((text, feature) => { try { return feature.line!(text); } catch { return text; } }, line));
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
