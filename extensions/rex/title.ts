import { basename } from "node:path";

const PATCHED = Symbol.for("pi-mono.rex.title");
// Pi writes its title as one OSC 0 sequence: "π - <session> - <dir>" or "π - <dir>".
const PI_TITLE = /^\x1b\]0;\u03c0 - ([^\x07]*)\x07$/;

/** The session name alone, or the directory when unnamed; Rex already shows a Pi icon. */
export function rexTitle(piTitle: string, dir: string): string {
  const suffix = ` - ${dir}`;
  return piTitle.endsWith(suffix) && piTitle.length > suffix.length ? piTitle.slice(0, -suffix.length) : piTitle;
}

/** Rewrites Pi's own title writes, so every path (startup, resume, reload, rename) is covered without racing Pi. */
export function registerRexTitle(env = process.env, out: NodeJS.WriteStream = process.stdout, cwd = () => process.cwd()) {
  if (!env.REX_SESSION || (out as any)[PATCHED]) return;
  (out as any)[PATCHED] = true;
  const write = out.write.bind(out) as (...args: any[]) => boolean;
  out.write = ((chunk: any, ...rest: any[]) => {
    const match = typeof chunk === "string" ? PI_TITLE.exec(chunk) : null;
    return write(match ? `\x1b]0;${rexTitle(match[1]!, basename(cwd()))}\x07` : chunk, ...rest);
  }) as typeof out.write;
}
