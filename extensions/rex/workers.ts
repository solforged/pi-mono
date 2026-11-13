// pi.events service through which other extensions (the workflowz kernel) run
// tasks on Rex children the user can watch. Emit REX_WORKERS with a request
// object; the Rex extension fills in `answer` synchronously when it can serve.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "../workflows/process.ts";
import type { AgentName } from "../workflows/subagents.ts";

export const REX_WORKERS = "rex:workers";

export interface RexWorkerResult {
  status: "succeeded" | "failed" | "cancelled"; text: string; usage?: Usage;
  provider: string; model: string; worktree?: string; sessionFile: string; elapsedMs: number;
}
export interface RexWorkers {
  /** Opens a managed child in the deck; resolves to its id once it is ready. */
  open(agent: AgentName, title: string, ctx: ExtensionContext, signal: AbortSignal): Promise<string>;
  /** Runs one task on an idle child and reads its result, so Rex does not deliver it again. */
  run(child: string, task: string, context: string, signal: AbortSignal, title?: string): Promise<RexWorkerResult>;
  /** Closes an idle child; its files, session and worktree are retained. */
  close(child: string): Promise<void>;
}
export interface RexWorkersRequest { answer?: RexWorkers }
