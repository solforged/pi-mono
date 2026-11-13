// Hold-to-talk on one key. Pi asks the terminal for Kitty keyboard event types,
// so in Rex, Ghostty, kitty and WezTerm the key reports press, repeat and
// release: holding it records until release. A quick tap latches recording
// until the next press, which is also all a terminal without release events
// can do.

export type KeyEvent = "press" | "repeat" | "release";
export type Action = "start" | "stop" | "latch" | "ignore";

/** A press shorter than this is a tap, which latches recording on. */
export const TAP_MS = 300;

export class Trigger {
  #state: "idle" | "held" | "latched" = "idle";
  #since = 0;
  #swallowRelease = false;

  get active() { return this.#state !== "idle"; }
  get held() { return this.#state === "held"; }
  get latched() { return this.#state === "latched"; }

  /** Forget a recording that ended some other way: Enter, Escape, an error. */
  reset() { this.#state = "idle"; }

  key(event: KeyEvent, now: number): Action {
    if (event === "repeat") return "ignore";
    if (event === "press") {
      if (this.#state === "idle") {
        this.#state = "held";
        this.#since = now;
        this.#swallowRelease = false;
        return "start";
      }
      // The press that ends a latched recording; its release must not start
      // or end anything.
      this.#state = "idle";
      this.#swallowRelease = true;
      return "stop";
    }
    if (this.#swallowRelease) {
      this.#swallowRelease = false;
      return "ignore";
    }
    if (this.#state !== "held") return "ignore";
    if (now - this.#since < TAP_MS) {
      this.#state = "latched";
      return "latch";
    }
    this.#state = "idle";
    return "stop";
  }
}

const NAMED: Record<string, number> = { space: 32, enter: 13, return: 13, tab: 9, escape: 27, esc: 27, backspace: 127 };

/** The Unicode codepoint Kitty reports for a key id's base key, such as 32 for `ctrl+space`. */
export function baseCode(key: string): number | undefined {
  const base = key.toLowerCase().split("+").pop() ?? "";
  if (base in NAMED) return NAMED[base];
  return [...base].length === 1 ? base.codePointAt(0) : undefined;
}

const EVENTS: Record<string, KeyEvent> = { "1": "press", "2": "repeat", "3": "release" };

/**
 * The base key and event type of a Kitty `CSI … u` key event, whatever its
 * modifiers. Events carry the modifiers held at that moment, so letting go of
 * ctrl before space reports a bare space, which `ctrl+space` would not match.
 */
export function kittyKey(data: string): { code: number; event: KeyEvent } | undefined {
  const match = /^\x1b\[(\d+)[\d:]*(?:;\d*(?::(\d))?)?(?:;[\d:]*)?u$/.exec(data);
  return match ? { code: Number(match[1]), event: EVENTS[match[2] ?? "1"] ?? "press" } : undefined;
}
