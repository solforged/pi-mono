// Client for the local speech-to-text server, a long-running process that keeps
// the model loaded for every Pi session (config/voice/server.py in the system
// flake, run by the launchd agent its `modules.voice` defines).

export const DEFAULT_URL = "http://127.0.0.1:8178";

export interface Transcript { text: string }

export class SpeechError extends Error {}

const unreachable = (url: string) =>
  new SpeechError(`no speech server at ${url}; enable \`modules.voice\` in the system flake, run \`voice-serve\`, or check \`launchctl print gui/$(id -u)/org.nixos.voice-stt\``);

/** Transcribes a WAV clip. `partial` marks a recording still in progress, which the server neither keeps nor logs. */
export async function transcribe(url: string, clip: Buffer, options: { partial?: boolean; signal?: AbortSignal } = {}): Promise<Transcript> {
  let response: Response;
  try {
    response = await fetch(`${url}/transcribe${options.partial ? "?partial=1" : ""}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(clip),
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if ((error as Error).name === "AbortError" || (error as Error).name === "TimeoutError") throw error;
    throw unreachable(url);
  }
  const body = await response.json().catch(() => ({})) as { text?: string; error?: string };
  if (!response.ok || typeof body.text !== "string") throw new SpeechError(body.error ?? `speech server answered HTTP ${response.status}`);
  return { text: body.text };
}

/** The transcript as it joins the editor's text: after a space unless that ends in whitespace. */
export const joinDictation = (current: string, text: string) => (current && !/\s$/.test(current) ? " " : "") + text;

export async function health(url: string): Promise<string> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    const body = await response.json() as { model?: string };
    return body.model ?? "unknown model";
  } catch {
    throw unreachable(url);
  }
}
