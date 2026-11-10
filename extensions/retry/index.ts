import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerRetry, RETRY_TYPE } from "./retry.ts";

export default function (pi: ExtensionAPI) {
  registerRetry(pi);
  // New notes are hidden; this keeps notes in older sessions to a one-line marker.
  pi.registerMessageRenderer(RETRY_TYPE, (_message, options, theme) =>
    new Text(theme.fg("dim", "↻ Retried the failed turn"), options.outputPad, 0));
}
