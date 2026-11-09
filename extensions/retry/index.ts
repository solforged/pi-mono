import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerRetry, RETRY_TYPE } from "./retry.ts";

export default function (pi: ExtensionAPI) {
  registerRetry(pi);
  // The model receives the full note; the transcript shows a marker.
  pi.registerMessageRenderer(RETRY_TYPE, (_message, options, theme) =>
    new Text(theme.fg("dim", "↻ Retried the failed turn"), options.outputPad, 0));
}
