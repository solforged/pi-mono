import { spawn } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { rms } from "./audio.ts";

// Records the default macOS input with ffmpeg, streaming raw 16 kHz PCM over a
// pipe: the first chunk shows the microphone is live (~0.2 s after start) and
// each chunk's level drives the meter. Microphone permission belongs to the
// terminal that runs Pi.

/** Keep recording this long after the key is released, so the last word survives. */
export const TAIL_MS = 250;
/** A recorder that ignores SIGTERM this long is killed. */
const KILL_MS = 1000;

export interface Recorder {
  /** How much is recorded so far, without copying it. */
  bytes(): number;
  /** Everything recorded so far. */
  pcm(): Buffer;
  /** Stops after the tail and resolves with the whole recording. */
  stop(): Promise<Buffer>;
  /** Stops at once and discards the recording. */
  cancel(): void;
}

export interface RecorderEvents {
  onLive(): void;
  onLevel(level: number): void;
  /** ffmpeg ended without being asked to, typically for a denied microphone. */
  onError(message: string): void;
}

// Pi started from a GUI or launchd may lack the Nix profiles on PATH; the
// system flake's voice module installs ffmpeg into the per-user one.
const PATH = [
  process.env.PATH,
  `/etc/profiles/per-user/${userInfo().username}/bin`,
  join(homedir(), ".nix-profile/bin"),
  "/run/current-system/sw/bin",
  "/nix/var/nix/profiles/default/bin",
].filter(Boolean).join(delimiter);

export function record(events: RecorderEvents, command = "ffmpeg"): Recorder {
  const child = spawn(command, [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "avfoundation", "-i", ":default",
    "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
  ], { env: { ...process.env, PATH }, stdio: ["ignore", "pipe", "pipe"] });

  const chunks: Buffer[] = [];
  let size = 0;
  let stderr = "";
  let stopping = false;
  let live = false;
  // Exit, not close: a wrapper's orphaned child could hold the pipe open.
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  child.stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.length;
    if (!live) {
      live = true;
      events.onLive();
    }
    events.onLevel(rms(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  child.once("error", (error) => { if (!stopping) events.onError(`could not run ${command}: ${error.message}`); });
  // Close, unlike exit, comes after the last of stderr, which explains the failure.
  child.once("close", (code, signal) => {
    if (!stopping && (code !== 0 || signal)) events.onError(stderr.trim() || `${command} exited with ${signal ?? code}`);
  });

  const pcm = () => Buffer.concat(chunks);
  return {
    bytes: () => size,
    pcm,
    async stop() {
      stopping = true;
      await new Promise((resolve) => setTimeout(resolve, TAIL_MS));
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), KILL_MS);
      await exited;
      clearTimeout(force);
      return pcm();
    },
    cancel() {
      stopping = true;
      child.kill("SIGKILL");
    },
  };
}
