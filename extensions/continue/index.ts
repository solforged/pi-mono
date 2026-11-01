import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("input", (event, ctx) => {
    if (ctx.mode === "tui" && event.source === "interactive" &&
        event.text.trim() === "." && !event.images?.length) {
      return { action: "transform", text: "Continue." };
    }
    return { action: "continue" };
  });
}
