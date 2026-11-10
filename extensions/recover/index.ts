import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { label, RECOVER_TYPE, registerRecover } from "./recover.ts";

export default function (pi: ExtensionAPI) {
  registerRecover(pi);
  // The model receives the full note; the transcript shows one line.
  pi.registerMessageRenderer(RECOVER_TYPE, (message, options, theme) =>
    new Text(theme.fg("warning", "↻ ") + theme.fg("muted", label(message.details as any)), options.outputPad, 0));
}
