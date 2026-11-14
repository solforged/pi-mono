import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, Image, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { useEditorFeature } from "../shared/editor.ts";
import { imageNumbers, pastedImageLabels } from "./labels.ts";
import { attach, imageIcon, isClipboardFile, shortenClipboardPaths } from "./paths.ts";
import { thumbnail, type Box, type Thumbnail } from "./thumbs.ts";

// One image gets the larger preview; several get the smaller one each.
const preview = { one: { cols: 48, rows: 8 }, several: { cols: 32, rows: 5 }, shown: 3, cached: 32 };

type Ready = { state: "ready"; box: string; thumb: Thumbnail; images: Map<number, Image> };
// A thumbnail being redrawn for new cells keeps the old one on screen meanwhile.
type Entry = { state: "loading"; box: string; previous?: Ready } | { state: "none"; box: string } | Ready;

// Thumbnails of the image paths in the editor, above it. Each image is its own
// block, as in the transcript: Pi tracks one image per line, so placing two
// side by side could leave the second on screen after the path is deleted.
class Previews implements Component {
  #entries = new Map<string, Entry>();

  constructor(private readonly tui: TUI, private readonly theme: Theme, private readonly text: () => string) {}

  render(width: number): string[] {
    if (!getCapabilities().images || width < 8) return [];
    const numbers = imageNumbers(this.text());
    const paths = [...numbers.keys()];
    // Pi asks the terminal for its cell size after startup, and Rex answers
    // with placeholder cells until the pane is laid out: a thumbnail made for
    // other cells is made again, so it is neither blurred nor oversized.
    const cell = getCellDimensions();
    const box: Box = { widthPx: preview.one.cols * cell.widthPx, heightPx: preview.one.rows * cell.heightPx };
    const key = `${box.widthPx}×${box.heightPx}`;
    const ready: Array<[string, Ready]> = [];
    for (const path of paths) {
      let entry = this.#entries.get(path);
      if (!entry || entry.box !== key) entry = this.#load(path, box, key, entry?.state === "ready" ? entry : entry?.state === "loading" ? entry.previous : undefined);
      const shown = entry.state === "loading" ? entry.previous : entry.state === "ready" ? entry : undefined;
      if (shown) ready.push([path, shown]);
    }
    this.#prune(paths);
    if (!ready.length) return [];
    const size = ready.length > 1 ? preview.several : preview.one;
    const lines: string[] = [];
    for (const [path, entry] of ready.slice(0, preview.shown)) {
      const { thumb } = entry;
      // Numbered as the editor labels pasted images and as the prompt will attach them.
      const name = isClipboardFile(path) ? "pasted image" : basename(path);
      const caption = [`image #${numbers.get(path)}`, ...isClipboardFile(path) ? [] : [name], ...thumb.width && thumb.height ? [`${thumb.width}×${thumb.height}`] : []];
      lines.push(truncateToWidth(` ${this.theme.fg("accent", imageIcon)} ${this.theme.fg("muted", caption.join(" · "))}`, width));
      let image = entry.images.get(size.rows);
      if (!image) {
        image = new Image(thumb.data, thumb.mimeType, { fallbackColor: (text) => this.theme.fg("dim", text) },
          { maxWidthCells: size.cols, maxHeightCells: size.rows, filename: name });
        entry.images.set(size.rows, image);
      }
      // Indented by one column under the caption; Pi's Image keeps two columns spare.
      lines.push(...image.render(Math.min(width - 1, size.cols + 2)).map((line) => ` ${line}`));
    }
    if (ready.length > preview.shown) lines.push(this.theme.fg("dim", ` +${ready.length - preview.shown} more`));
    return lines;
  }

  invalidate() {
    for (const entry of this.#entries.values()) {
      const ready = entry.state === "ready" ? entry : entry.state === "loading" ? entry.previous : undefined;
      for (const image of ready?.images.values() ?? []) image.invalidate();
    }
  }

  #load(path: string, box: Box, key: string, previous?: Ready): Entry {
    const entry: Entry = { state: "loading", box: key, previous };
    this.#entries.set(path, entry);
    const settle = (next: Entry) => {
      if (this.#entries.get(path) !== entry) return;
      this.#entries.set(path, next);
      if (next.state === "ready" || previous) this.tui.requestRender();
    };
    thumbnail(path, box).then(
      (thumb) => settle(thumb ? { state: "ready", box: key, thumb, images: new Map() } : { state: "none", box: key }),
      () => settle({ state: "none", box: key }),
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
    useEditorFeature(ctx, "image-paste", pastedImageLabels);
    const settings = pi.getSettings() as { terminal?: { showImages?: boolean } };
    if (settings.terminal?.showImages === false) return;
    ctx.ui.setWidget("image-paste", (tui, theme) => new Previews(tui, theme, () => ctx.ui.getEditorText()));
  });
}
