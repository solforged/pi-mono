import { chmod } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { Frames, isId, record, send, text, validateReady, validUsage, waitFor, type ChildMessage, type Manifest, type ParentMessage, type Ready } from "./protocol.ts";

/** One authenticated, non-reconnecting connection per child. No message replay. */
export class Channel {
  readonly ready = Promise.withResolvers<Ready>();
  hello?: Ready;
  private peer?: Socket;
  private sockets = new Set<Socket>();
  private server = createServer(socket => this.connect(socket));
  private stopped = false;
  private sequence = 0;
  private queue = Promise.resolve();
  private heartbeat?: ReturnType<typeof setInterval>;
  private pending = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  private manifest: Manifest;
  private event: (message: ChildMessage) => Promise<void>;
  private lost: (error: Error) => Promise<void>;
  constructor(manifest: Manifest, event: (message: ChildMessage) => Promise<void>, lost: (error: Error) => Promise<void>) {
    this.manifest = manifest; this.event = event; this.lost = lost;
    void this.ready.promise.catch(() => {});
    this.server.on("error", error => this.fail(error));
  }
  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.manifest.socket, () => { this.server.removeListener("error", reject); resolve(); });
    });
    await chmod(this.manifest.socket, 0o600);
  }
  private connect(socket: Socket) {
    if (this.stopped || this.sockets.size >= 4) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    let authenticated = false;
    const frames = new Frames();
    socket.on("error", error => { if (authenticated) this.afterEvents(() => this.fail(error)); });
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (authenticated) this.afterEvents(() => this.fail(new Error("Child channel closed; no task replay")));
    });
    socket.on("data", chunk => {
      try {
        frames.push(chunk, value => {
          if (!authenticated) {
            const hello = validateReady(value, this.manifest);
            if (this.peer) throw new Error("Duplicate child connection");
            this.peer = socket; this.hello = hello; authenticated = true; socket.setTimeout(0);
            this.ready.resolve(hello);
            this.heartbeat = setInterval(() => {
              try { this.send({ type: "ping", id: this.manifest.id }); } catch (error) { this.fail(error as Error); }
            }, 3000);
            this.heartbeat.unref();
            return;
          }
          const message = record(value);
          if (message.id !== this.manifest.id || message.seq !== this.sequence + 1) throw new Error("Invalid child event sequence");
          this.sequence = message.seq;
          const type = message.type;
          if (type === "result") {
            if (!isId(message.taskId) || !["succeeded", "failed", "cancelled"].includes(message.status)
              || !text(message.text, 51000) || !validUsage(message.usage)) throw new Error("Invalid child result");
          } else if (["accepted", "ack", "error"].includes(type)) {
            if (!isId(message.requestId) || (message.taskId !== undefined && !isId(message.taskId)) || !text(message.text ?? "", 2000)) throw new Error("Invalid child receipt");
          } else if (type === "progress") {
            const count = (n: unknown) => n === undefined || (Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 1000);
            if (!isId(message.taskId) || !text(message.text, 1000)
              || (message.cost !== undefined && !(typeof message.cost === "number" && Number.isFinite(message.cost) && message.cost >= 0))
              || !count(message.done) || !count(message.total) || (message.done === undefined) !== (message.total === undefined)
              || (message.total !== undefined && message.done > message.total)) throw new Error("Invalid child progress");
          } else if (type === "request") {
            if (!isId(message.requestId) || !text(message.text, 16000) || !message.text.trim()) throw new Error("Invalid child request");
          } else if (type === "ownership") {
            if (message.owner !== "human" || (message.requestId !== undefined && !isId(message.requestId))) throw new Error("Invalid ownership receipt");
          } else if (type !== "retired" || !text(message.text, 2000)) throw new Error("Unknown child event");
          this.afterEvents(async () => {
            await this.event(message as ChildMessage);
            const pending = this.pending.get(message.requestId);
            if (pending) {
              this.pending.delete(message.requestId);
              if (type === "error") pending.reject(new Error(message.text || "Child rejected request"));
              else if (["accepted", "ack", "ownership"].includes(type)) pending.resolve();
            }
          });
        });
      } catch (error) {
        if (authenticated) this.afterEvents(() => this.fail(error as Error));
        socket.destroy();
      }
    });
  }
  private afterEvents(fn: () => void | Promise<void>) {
    this.queue = this.queue.then(fn).catch(error => { this.fail(error); });
  }
  private fail(error: Error) {
    if (this.stopped) return;
    this.stopped = true;
    this.ready.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.sockets) socket.destroy();
    // Must not await teardown from within the event queue itself.
    void this.lost(error).catch(() => {});
  }
  send(message: ParentMessage) {
    if (this.stopped || !this.peer) throw new Error("Child channel is unavailable");
    send(this.peer, message);
  }
  async request(message: ParentMessage & { requestId: string }, signal: AbortSignal) {
    if (this.pending.size >= 8 || this.pending.has(message.requestId)) throw new Error("Too many or duplicate pending requests");
    const pending = Promise.withResolvers<void>();
    this.pending.set(message.requestId, pending);
    void pending.promise.catch(() => {});
    try { signal.throwIfAborted(); this.send(message); await waitFor(pending.promise, signal); }
    finally { this.pending.delete(message.requestId); }
  }
  async close() {
    this.stopped = true;
    this.ready.reject(new Error("Coordinator closed"));
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) pending.reject(new Error("Coordinator closed"));
    this.pending.clear();
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
