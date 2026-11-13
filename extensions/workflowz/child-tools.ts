// Loaded explicitly into workflowz children, never auto-discovered. Registers
// the kernel functions a pool or agent was given with tool(); each call goes
// over a private Unix socket to the parent Pi, which runs it in the kernel.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callKernel } from "./tool-server.ts";

interface Spec { socket: string; token: string; tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }

export default function (pi: ExtensionAPI) {
  const raw = process.env.PI_WORKFLOWZ_TOOLS;
  if (!raw) return;
  const spec = JSON.parse(raw) as Spec;
  for (const tool of spec.tools) {
    pi.registerTool({
      name: tool.name, label: tool.name,
      description: `${tool.description} (runs in the parent's workflow kernel)`,
      parameters: tool.parameters as any,
      async execute(_id, params, signal) {
        const reply = await callKernel(spec, tool.name, params, signal);
        if (!reply.ok) throw new Error(reply.error ?? `${tool.name} failed`);
        return { content: [{ type: "text", text: reply.value ?? "" }], details: undefined };
      },
    });
  }
}
