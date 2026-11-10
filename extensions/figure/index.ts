import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex, Container, getCapabilities, getCellDimensions, Image, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { cleanup, rasterize, supported, type Raster } from "./raster.ts";
import { fit, onCanvas, prepare, tokens, type Palette, type Prepared } from "./svg.ts";

// Theme colors behind the figure tokens; c1…c6 are series colors for charts.
const sources: Palette = {
  fg: "text", muted: "muted", dim: "dim", border: "borderMuted", surface: "selectedBg", accent: "accent",
  success: "success", warning: "warning", error: "error",
  c1: "syntaxKeyword", c2: "syntaxFunction", c3: "syntaxNumber", c4: "syntaxType", c5: "syntaxVariable", c6: "toolDiffRemoved",
};

export function palette(theme: Theme): Palette {
  const colors = theme.colors as Record<string, Parameters<typeof colorToHex>[0] | undefined>;
  const hex = (name: string) => colors[name] ? colorToHex(colors[name]!) : undefined;
  return Object.fromEntries(tokens.map((token) => [token, hex(sources[token]) ?? hex("text") ?? "#888888"])) as Palette;
}

class Figure implements Component {
  #prepared?: Prepared;
  #error?: string;
  #theme!: Theme;
  #expanded = false;
  #pad = 0;
  #hint = "";
  #key?: string;
  #failed?: { key: string; message: string };
  #raster?: Raster;
  #image?: Image;

  constructor(private readonly changed: () => void) {}

  update(svg: string, theme: Theme, expanded: boolean, pad: number, hint: string) {
    this.#theme = theme; this.#expanded = expanded; this.#pad = pad; this.#hint = hint;
    try { this.#prepared = prepare(svg, palette(theme)); this.#error = undefined; }
    catch (error) { this.#prepared = undefined; this.#error = (error as Error).message; }
  }

  render(width: number): string[] {
    const pad = " ".repeat(this.#pad);
    const line = (text: string) => new Text(text, this.#pad, 0).render(width);
    if (!this.#prepared) return line(this.#theme.fg("error", this.#error ?? "No figure"));
    const inner = Math.max(1, width - 2 * this.#pad);
    const size = fit(this.#prepared, getCellDimensions(), { cols: inner, rows: process.stdout.rows || 40 }, this.#expanded);
    const key = onCanvas(this.#prepared, size.canvas.width, size.canvas.height);
    if (key !== this.#key) {
      // The previous image stays up, at its own size, until the new raster lands.
      this.#key = key;
      rasterize(key).then(
        (raster) => { if (this.#key === key) { this.#raster = raster; this.#image = undefined; this.changed(); } },
        (error: Error) => { this.#failed = { key, message: error.message }; if (this.#key === key) this.changed(); },
      );
    }
    if (this.#failed?.key === key) return line(this.#theme.fg("error", this.#failed.message));
    if (!this.#raster) {
      return [...line(this.#theme.fg("dim", "◌ Drawing figure…")), ...Array(Math.max(0, size.rows - 1)).fill("")];
    }
    this.#image ??= new Image(this.#raster.data, "image/png", { fallbackColor: (text) => this.#theme.fg("muted", text) },
      { maxWidthCells: size.cols, maxHeightCells: size.rows, filename: "figure.svg" }, { widthPx: this.#raster.width, heightPx: this.#raster.height });
    const lines = this.#image.render(inner + 2).map((text) => pad + text);
    if (size.shrunk && this.#hint) lines.push(...line(this.#theme.fg("dim", this.#hint)));
    return lines;
  }

  invalidate() { this.#image?.invalidate(); }
}

export default function (pi: ExtensionAPI) {
  if (!supported) return;

  // Pi asks for the cell size once, at startup. A Rex pane answers with
  // placeholder 8×16 cells until a client lays it out, which stretches every
  // image, so ask again whenever the terminal resizes; Pi takes the reply.
  const askCellSize = () => process.stdout.write("\x1b[16t");
  let asking = false;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !getCapabilities().images || asking) return;
    asking = true;
    process.stdout.on("resize", askCellSize);
    askCellSize();
  });
  pi.on("session_shutdown", () => {
    if (asking) process.stdout.off("resize", askCellSize);
    asking = false;
    return cleanup();
  });

  pi.registerTool({
    name: "figure",
    label: "Figure",
    // Sent with every request: keep it short. Details are in docs/figure.md.
    description: "Show the user an SVG inline: a UI mockup, layout, diagram or chart that says more than text. They see it; don't restate it. viewBox sets size (1 unit≈1px, font-size 14≈body text, ≤1000 wide). Colors only via var(--fg|muted|dim|border|surface|accent|success|warning|error|c1…c6), which follow their theme. No background, <style>, scripts or links.",
    parameters: Type.Object({ svg: Type.String(), title: Type.Optional(Type.String()) }),
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui" || !getCapabilities().images) {
        throw new Error("This terminal cannot show figures; describe it in text instead.");
      }
      // Draw once now so a broken SVG comes back to the model, not just to the screen.
      const prepared = prepare(params.svg, palette(ctx.ui.theme));
      await rasterize(prepared.svg, signal);
      return {
        content: [{ type: "text", text: `Shown to the user as a ${prepared.width}×${prepared.height} figure.` }],
        details: { width: prepared.width, height: prepared.height },
      };
    },
    renderCall(args, theme, context) {
      const title = typeof args.title === "string" && args.title.trim() ? ` ${theme.fg("muted", args.title.trim())}` : "";
      const text = (context.lastComponent instanceof Text ? context.lastComponent : new Text("", context.outputPad, 0));
      text.setText(theme.fg("toolTitle", theme.bold("◇ Figure")) + title);
      return text;
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Container();
      if (context.isError) {
        const message = result.content.find((part) => part.type === "text")?.text ?? "The figure failed.";
        return new Text(theme.fg("error", message), context.outputPad, 0);
      }
      if (!context.showImages) return new Text(theme.fg("dim", "Figure hidden: images are turned off."), context.outputPad, 0);
      const figure = context.lastComponent instanceof Figure ? context.lastComponent : new Figure(() => context.invalidate());
      figure.update(String(context.args.svg ?? ""), theme, expanded, context.outputPad, context.keyHint("app.tools.expand", "to enlarge"));
      return figure;
    },
  });
}
