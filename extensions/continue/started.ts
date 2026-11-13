// Which runs the user started. "." and /retry start a run with a hidden
// message of their own, which Pi reports as "custom" and not "user", and "."
// handles the input before other extensions see it. Extensions that renew a
// budget when the user speaks ask here, or those two would never renew it.
// No Pi imports.
import { RETRY_TYPE } from "../retry/retry.ts";

export const CONTINUE_TYPE = "continue";
const STAND_INS = new Set([CONTINUE_TYPE, RETRY_TYPE]);

/** Whether a `before_agent_start` event is the user's doing: a prompt, or a message that stands in for one. */
export const userStarted = (event: { messageType?: string; message?: { customType?: string } }) =>
  event.messageType === "user" || (event.messageType === "custom" && STAND_INS.has(event.message?.customType ?? ""));
