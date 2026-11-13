import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { meter, seconds, SILENCE, wav } from "./audio.ts";
import { baseCode, kittyKey, Trigger, type KeyEvent } from "./keys.ts";
import { record, type Recorder } from "./recorder.ts";
import { DEFAULT_URL, health, joinDictation, SpeechError, transcribe } from "./speech.ts";

// Push-to-talk dictation into the editor: hold the key, speak, release. A
// local speech server transcribes; the text is pasted at the cursor for review,
// never sent. Settings: `voice.key` and `voice.url` in settings.json.

const DEFAULT_KEY = "ctrl+space";
const MAX_SECONDS = 120;
const MIN_SECONDS = 0.3;
/** How often the preview transcript under the meter refreshes while recording. */
const PARTIAL_MS = 400;
const TICK_MS = 100;
const LEVELS = 12;
/** Pi collapses longer pastes into a `[paste #n]` marker, hiding the text to review. */
const PASTE_LIMIT = 1000;

type Phase = "idle" | "opening" | "live" | "transcribing";

class Dictation {
  readonly trigger = new Trigger();
  readonly base: number | undefined;
  phase: Phase = "idle";
  #recorder?: Recorder;
  #generation = 0;
  #started = 0;
  #levels: number[] = [];
  #peak = 0;
  #partial = "";
  #partialAt = 0;
  #partialBusy = false;
  #partialBytes = 0;
  #timer?: ReturnType<typeof setInterval>;
  #tui?: TUI;

  constructor(private readonly ctx: ExtensionContext, readonly key: string, readonly url: string) {
    this.base = baseCode(key);
  }

  input(data: string): { consume: true } | undefined {
    if (this.phase !== "idle" && !isKeyRelease(data)) {
      if (matchesKey(data, "escape")) {
        this.cancel();
        return { consume: true };
      }
      if (matchesKey(data, "enter")) {
        // Ends a recording; while transcribing, it would submit the prompt
        // without the words still on their way.
        if (this.trigger.active) void this.finish();
        return { consume: true };
      }
    }
    const event = this.#classify(data);
    if (!event) return;
    // One recording at a time: the previous one is still transcribing.
    if (this.phase === "transcribing") return { consume: true };
    const action = this.trigger.key(event, Date.now());
    if (action === "start") this.#start();
    else if (action === "stop") void this.finish();
    else if (action === "latch") this.#render();
    return { consume: true };
  }

  #classify(data: string): KeyEvent | undefined {
    if (matchesKey(data, this.key)) return isKeyRelease(data) ? "release" : isKeyRepeat(data) ? "repeat" : "press";
    if (!this.trigger.active || this.base === undefined) return;
    // Events for the bare key while it is held, after its modifiers were let
    // go: the release ends recording, and repeats must not type spaces.
    const key = kittyKey(data);
    if (key?.code === this.base) return key.event === "release" ? "release" : "repeat";
    if (this.trigger.held && data === String.fromCodePoint(this.base)) return "repeat";
  }

  #start() {
    if (process.platform !== "darwin") {
      this.trigger.reset();
      this.ctx.ui.notify("Voice dictation records with macOS's AVFoundation and needs macOS for now.", "warning");
      return;
    }
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    this.phase = "opening";
    this.#started = Date.now();
    this.#levels = [];
    this.#peak = 0;
    this.#partial = "";
    this.#partialAt = 0;
    this.#partialBytes = 0;
    this.#show();
    this.#recorder = record({
      onLive: () => { if (current()) { this.phase = "live"; this.#render(); } },
      onLevel: (level) => {
        if (!current()) return;
        this.#peak = Math.max(this.#peak, level);
        this.#levels = [...this.#levels, level].slice(-LEVELS);
      },
      onError: (message) => { if (current()) this.#fail(`Recording failed: ${message}`); },
    });
    this.#timer = setInterval(() => this.#tick(generation), TICK_MS);
  }

  #tick(generation: number) {
    if (Date.now() - this.#started > MAX_SECONDS * 1000) return void this.finish();
    this.#render();
    const recorder = this.#recorder;
    if (!recorder || this.#partialBusy || Date.now() - this.#partialAt < PARTIAL_MS) return;
    const pcm = recorder.pcm();
    if (seconds(pcm.length) < 0.8 || pcm.length === this.#partialBytes) return;
    this.#partialBusy = true;
    this.#partialAt = Date.now();
    this.#partialBytes = pcm.length;
    transcribe(this.url, wav(pcm), { partial: true, signal: AbortSignal.timeout(5000) }).then(
      ({ text }) => {
        if (generation !== this.#generation || this.phase === "transcribing") return;
        this.#partial = text;
        this.#render();
      },
      () => {}, // The final transcription reports a missing server.
    ).finally(() => { this.#partialBusy = false; });
  }

  async finish() {
    const recorder = this.#recorder;
    if (!recorder || this.phase === "transcribing") return;
    const generation = this.#generation;
    this.trigger.reset();
    this.#stopTimer();
    this.phase = "transcribing";
    this.#render();
    try {
      const pcm = await recorder.stop();
      if (generation !== this.#generation) return;
      const length = seconds(pcm.length);
      if (length < MIN_SECONDS) return this.#idle();
      if (this.#peak < SILENCE) return this.#idle("Heard only silence; is the right microphone selected?");
      const { text } = await transcribe(this.url, wav(pcm));
      if (generation !== this.#generation) return;
      this.#idle();
      if (text) this.#insert(text);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#fail(error instanceof SpeechError ? error.message : `Transcription failed: ${(error as Error).message}`);
    }
  }

  cancel() {
    this.#generation++;
    this.#recorder?.cancel();
    this.#idle();
  }

  #insert(text: string) {
    const current = this.ctx.ui.getEditorText();
    const piece = joinDictation(current, text);
    if (piece.length > PASTE_LIMIT) this.ctx.ui.setEditorText(current + piece);
    else this.ctx.ui.pasteToEditor(piece);
  }

  #fail(message: string) {
    this.#generation++;
    this.#recorder?.cancel();
    this.#idle();
    this.ctx.ui.notify(message, "error");
  }

  #idle(note?: string) {
    this.trigger.reset();
    this.#stopTimer();
    this.#recorder = undefined;
    this.phase = "idle";
    this.ctx.ui.setWidget("voice", undefined);
    this.#tui = undefined;
    if (note) this.ctx.ui.notify(note, "warning");
  }

  #stopTimer() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #show() {
    this.ctx.ui.setWidget("voice", (tui, theme) => {
      this.#tui = tui;
      return { render: (width: number) => this.#lines(width, theme), invalidate() {} };
    });
  }

  #render() { this.#tui?.requestRender(); }

  #lines(width: number, theme: Theme): string[] {
    let head: string;
    if (this.phase === "live") {
      const levels = [...Array(LEVELS - this.#levels.length).fill(0), ...this.#levels];
      const elapsed = `${((Date.now() - this.#started) / 1000).toFixed(1)}s`;
      head = `${theme.fg("error", "●")} ${theme.fg("muted", elapsed.padStart(5))} ${theme.fg("accent", meter(levels))}`;
    } else {
      head = theme.fg("muted", this.phase === "opening" ? "◌ opening microphone…" : "◌ transcribing…");
    }
    const hint = this.phase === "transcribing" ? "" : this.trigger.latched
      ? `${this.key} or enter to insert · esc to cancel`
      : "release to insert · tap to keep listening · esc to cancel";
    const lines = [truncateToWidth(` ${head}  ${theme.fg("dim", hint)}`, width)];
    if (this.#partial) lines.push(truncateToWidth(` ${theme.fg("muted", tail(this.#partial, width - 2))}`, width));
    return lines;
  }
}

/** The end of a preview too long for one line, where new words appear. */
function tail(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  let start = text.length - Math.max(1, width - 1);
  while (start < text.length && visibleWidth(text.slice(start)) > width - 1) start++;
  return `…${text.slice(start)}`;
}

function options(pi: ExtensionAPI) {
  const voice = (pi.getSettings() as { voice?: { key?: string; url?: string } }).voice ?? {};
  return { key: voice.key ?? DEFAULT_KEY, url: (voice.url ?? DEFAULT_URL).replace(/\/+$/, "") };
}

export default function (pi: ExtensionAPI) {
  let dictation: Dictation | undefined;
  let unsubscribe: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    dictation?.cancel();
    unsubscribe?.();
    const { key, url } = options(pi);
    const current = new Dictation(ctx, key, url);
    dictation = current;
    unsubscribe = ctx.ui.onTerminalInput((data) => current.input(data));
  });

  pi.on("session_shutdown", () => {
    dictation?.cancel();
    unsubscribe?.();
    dictation = unsubscribe = undefined;
  });

  pi.registerCommand("voice", {
    description: "Check push-to-talk dictation and its speech server",
    handler: async (_args, ctx) => {
      const { key, url } = options(pi);
      try {
        const model = await health(url);
        ctx.ui.notify(`Hold ${key} to dictate (tap to keep listening). Speech server at ${url}: ${model}.`, "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });
}
