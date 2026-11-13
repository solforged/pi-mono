// The parent end of tool(): a Unix socket in a private temporary directory
// that children's kernel tools (child-tools.ts) call with a per-session token.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ToolHandler = (name: string, args: unknown, signal: AbortSignal) => Promise<{ ok: boolean; value?: string; error?: string }>;

export class ToolServer {
  readonly socket: string;
  readonly token = randomBytes(24).toString("hex");
  private dir: string;
  private server: Server;

  constructor(handler: ToolHandler) {
    // Short path: Unix socket paths are limited to about 100 bytes.
    this.dir = mkdtempSync(join(tmpdir(), "wfz-"));
    this.socket = join(this.dir, "k.sock");
    this.server = createServer((connection) => {
      const closed = new AbortController();
      connection.on("close", () => closed.abort());
      connection.on("error", () => {});
      connection.setEncoding("utf8");
      let buffer = "";
      connection.on("data", async (chunk) => {
        if (buffer.includes("\n")) return;
        buffer += chunk;
        if (buffer.length > 1_000_000) { connection.destroy(); return; }
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        let reply: { ok: boolean; value?: string; error?: string };
        try {
          const request = JSON.parse(buffer.slice(0, end)) as { token?: unknown; name?: unknown; args?: unknown };
          const given = Buffer.from(String(request.token ?? "")), expected = Buffer.from(this.token);
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("Bad kernel tool token");
          reply = await handler(String(request.name), request.args ?? {}, closed.signal);
        } catch (error) { reply = { ok: false, error: String((error as Error)?.message ?? error) }; }
        if (!connection.destroyed) connection.end(`${JSON.stringify(reply)}\n`);
      });
    });
    this.server.on("error", () => {});
    this.server.listen(this.socket);
    this.server.unref();
  }

  close() {
    this.server.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The child end: one request per connection. */
export function callKernel(spec: { socket: string; token: string }, name: string, args: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(spec.socket);
    let buffer = "";
    const abort = () => { socket.destroy(); reject(new Error("Cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ token: spec.token, name, args })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      signal?.removeEventListener("abort", abort);
      socket.end();
      try { resolve(JSON.parse(buffer.slice(0, end))); } catch (error) { reject(error); }
    });
    socket.on("error", (error) => { signal?.removeEventListener("abort", abort); reject(new Error(`The parent workflow kernel is unreachable: ${error.message}`)); });
    socket.on("close", () => { signal?.removeEventListener("abort", abort); if (!buffer.includes("\n")) reject(new Error("The parent workflow kernel closed the connection")); });
  });
}

