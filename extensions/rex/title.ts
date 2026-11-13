import { basename } from "node:path";

const PATCHED = Symbol.for("pi-mono.rex.title");
// Pi writes its title as one OSC 0 sequence: "π - <session> - <dir>" or "π - <dir>".
const PI_TITLE = /^\x1b\]0;\u03c0 - ([^\x07]*)\x07$/;

/** The session name alone, or the directory when unnamed; Rex already shows a Pi icon. */
export function rexTitle(piTitle: string, dir: string): string {
  const suffix = ` - ${dir}`;
  return piTitle.endsWith(suffix) && piTitle.length > suffix.length ? piTitle.slice(0, -suffix.length) : piTitle;
}

/** Kept on the stream, not the module: /reload loads a new module but the stream stays patched. */
interface TitleState { prefix: string; last?: string; write: (...args: any[]) => boolean }
type Patched = NodeJS.WriteStream & { [PATCHED]?: TitleState };
const osc = (state: TitleState, title: string) => `\x1b]0;${state.prefix ? `${state.prefix} ` : ""}${title}\x07`;

/** Rewrites Pi's own title writes, so every path (startup, resume, reload, rename) is covered without racing Pi. */
export function registerRexTitle(env = process.env, out: NodeJS.WriteStream = process.stdout, cwd = () => process.cwd()) {
  const stream = out as Patched;
  if (!env.REX_SESSION || stream[PATCHED]) return;
  const state: TitleState = { prefix: "", write: out.write.bind(out) as (...args: any[]) => boolean };
  stream[PATCHED] = state;
  out.write = ((chunk: any, ...rest: any[]) => {
    const match = typeof chunk === "string" ? PI_TITLE.exec(chunk) : null;
    if (match) state.last = rexTitle(match[1]!, basename(cwd()));
    return state.write(match ? osc(state, state.last!) : chunk, ...rest);
  }) as typeof out.write;
}

/** Marks every later title (e.g. the parent's colour); rewrites the current one at once. */
export function setTitlePrefix(prefix: string, out: NodeJS.WriteStream = process.stdout) {
  const state = (out as Patched)[PATCHED];
  if (!state || state.prefix === prefix) return;
  state.prefix = prefix;
  if (state.last !== undefined) state.write(osc(state, state.last));
}
