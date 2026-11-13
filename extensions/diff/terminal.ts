// Decodes what the terminal sends the two pane programs: keys, mouse reports
// and its answer to the background-color query. No Pi imports.

const KEYS: Record<string, string> = {
  "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left", "\x1bOA": "up", "\x1bOB": "down",
  "\x1bOC": "right", "\x1bOD": "left", "\x1b[5~": "pageup", "\x1b[6~": "pagedown", "\x1b[H": "home", "\x1b[F": "end",
  "\x1b[1;2A": "shift-up", "\x1b[1;2B": "shift-down", "\x1b[a": "shift-up", "\x1b[b": "shift-down", "\x1b[O": "blur",
  "\x1b[1~": "home", "\x1b[4~": "end", "\x1bOH": "home", "\x1bOF": "end", "\x1b[Z": "shift-tab", "\t": "tab", "\x7f": "backspace", "\b": "backspace",
  "\x03": "ctrl-c", "\x04": "ctrl-d", "\x15": "ctrl-u", "\x06": "ctrl-f", "\x02": "ctrl-b", "\x05": "ctrl-e", "\x19": "ctrl-y",
};

export interface Input {
  /** A named key from the table above, or a printable character as itself. */
  key(name: string): void;
  /** An SGR mouse report, with its 1-based column and row. */
  mouse(button: number, column: number, row: number, press: boolean): void;
  /** The terminal's background color, as #rrggbb. */
  background(color: string): void;
}

const COLOR = /^\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(?:\x07|\x1b\\)/i;
const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const SEQUENCE = /^(?:\x1b\[[0-9;?]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;
/** The start of a sequence whose end has not arrived. */
const PARTIAL = /^\x1b(?:\[[<0-9;?]*|O|\][^\x07\x1b]*\x1b?)?$/;
/** How long the rest of a sequence may take to arrive. */
const PARTIAL_MS = 50;

/**
 * Returns the function to feed with the terminal's input. A read can end
 * partway through a sequence, so its start waits for the next read: taken as
 * keys, a mouse report would press `[` and a color reply `]`, `r`, `g` and `b`.
 */
export function decoder(on: Input, wait = PARTIAL_MS): (data: string) => void {
  let held = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (data) => {
    clearTimeout(timer);
    let rest = held + data;
    held = "";
    while (rest.length) {
      if (PARTIAL.test(rest)) {
        held = rest;
        // A sequence that never ends was not typed either, so it is dropped.
        timer = setTimeout(() => { held = ""; }, wait);
        timer.unref();
        return;
      }
      const color = COLOR.exec(rest);
      if (color) {
        const channel = (hex: string) => Math.round(parseInt(hex, 16) / (16 ** hex.length - 1) * 255).toString(16).padStart(2, "0");
        on.background(`#${channel(color[1])}${channel(color[2])}${channel(color[3])}`);
        rest = rest.slice(color[0].length);
        continue;
      }
      const pointer = MOUSE.exec(rest);
      if (pointer) {
        on.mouse(Number(pointer[1]), Number(pointer[2]), Number(pointer[3]), pointer[4] === "M");
        rest = rest.slice(pointer[0].length);
        continue;
      }
      const token = SEQUENCE.exec(rest)?.[0] ?? String.fromCodePoint(rest.codePointAt(0)!);
      rest = rest.slice(token.length);
      const name = KEYS[token] ?? (token.length === 1 && token >= " " ? token : undefined);
      if (name) on.key(name);
    }
  };
}
