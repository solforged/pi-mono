import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, Image, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { attach, candidates, isClipboardFile, shortenClipboardPaths } from "./paths.ts";
import { thumbnail, type Thumbnail } from "./thumbs.ts";

const preview = { cols: 24, rows: 4, shown: 3, cached: 32 };

type Entry = { state: "loading" | "none" } | { state: "ready"; thumb: Thumbnail; image?: Image };

// Thumbnails of the image paths in the editor, above it. Each image is its own
// block, as in the transcript: Pi tracks one image per line, so placing two
// side by side could leave the second on screen after the path is deleted.
class Previews implements Component {
  #entries = new Map<string, Entry>();

  constructor(private readonly tui: TUI, private readonly theme: Theme, private readonly text: () => string) {}

  render(width: number): string[] {
    if (!getCapabilities().images || width < 8) return [];
    const paths = [...new Set(candidates(this.text()).map((candidate) => candidate.path))];
    const ready: Array<[string, Extract<Entry, { state: "ready" }>]> = [];
    for (const path of paths) {
      const entry = this.#entries.get(path) ?? this.#load(path);
      if (entry.state === "ready") ready.push([path, entry]);
    }
    this.#prune(paths);
    if (!ready.length) return [];
    const lines: string[] = [];
    for (const [path, entry] of ready.slice(0, preview.shown)) {
      const { thumb } = entry;
      const name = isClipboardFile(path) ? "pasted image" : basename(path);
      const size = thumb.width && thumb.height ? ` · ${thumb.width}×${thumb.height}` : "";
      lines.push(truncateToWidth(` ${this.theme.fg("accent", "🖼")} ${this.theme.fg("muted", name + size)}`, width));
      entry.image ??= new Image(thumb.data, thumb.mimeType, { fallbackColor: (text) => this.theme.fg("dim", text) },
        { maxWidthCells: preview.cols, maxHeightCells: preview.rows, filename: name });
      lines.push(...entry.image.render(Math.min(width, preview.cols + 2) - 1).map((line) => ` ${line}`));
    }
    if (ready.length > preview.shown) lines.push(this.theme.fg("dim", ` +${ready.length - preview.shown} more`));
    return lines;
  }

  invalidate() {
    for (const entry of this.#entries.values()) if (entry.state === "ready") entry.image?.invalidate();
  }

  #load(path: string): Entry {
    const entry: Entry = { state: "loading" };
    this.#entries.set(path, entry);
    const cell = getCellDimensions();
    thumbnail(path, Math.max(preview.cols * cell.widthPx, preview.rows * cell.heightPx)).then(
      (thumb) => {
        if (this.#entries.get(path) !== entry) return;
        this.#entries.set(path, thumb ? { state: "ready", thumb } : { state: "none" });
        if (thumb) this.tui.requestRender();
      },
      () => { if (this.#entries.get(path) === entry) this.#entries.set(path, { state: "none" }); },
    );
    return entry;
  }

  // Forget paths no longer in the editor once the cache is full, so a file
  // that appears later is read again.
  #prune(current: string[]) {
    if (this.#entries.size <= preview.cached) return;
    for (const path of this.#entries.keys()) if (!current.includes(path)) this.#entries.delete(path);
  }
}

const isVision = (ctx: ExtensionContext) => Array.isArray(ctx.model?.input) && ctx.model.input.includes("image");

export default function (pi: ExtensionAPI) {
  // Attach image paths in a submitted prompt, so the model sees the image
  // without spending a turn on `read`. Pi resizes these like pasted images.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || event.text.startsWith("!") || !isVision(ctx)) return;
    const existing = event.images ?? [];
    const result = await attach(event.text, existing.length);
    if (!result) return;
    return {
      action: "transform",
      text: result.text,
      images: [...existing, ...result.images.map((image) => ({ type: "image" as const, ...image }))],
    };
  });

  pi.registerMarkdownTransformer((markdown) => shortenClipboardPaths(markdown), { messageTypes: ["user"] });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const settings = pi.getSettings() as { terminal?: { showImages?: boolean } };
    if (settings.terminal?.showImages === false) return;
    ctx.ui.setWidget("image-paste", (tui, theme) => new Previews(tui, theme, () => ctx.ui.getEditorText()));
  });
}
