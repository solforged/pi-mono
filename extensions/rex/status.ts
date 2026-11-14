// Adds a child's progress to Pi's own program status reports (OSC 7501), so
// Rex draws a progress pie on its tab and lists it in Activity. Pi writes each
// report as one sequence, `ESC ] 7501 ; state=working:app=pi:msg=… ESC \`, and
// only after the terminal said it understands them; each report replaces the
// last. Reports are rewritten on their way to the terminal (as title.ts does
// for titles), and the last one is written again when the progress changes.

const PATCHED = Symbol.for("pi-mono.rex.status");
const REPORT = /^\x1b\]7501;([^?\x07\x1b][^\x07\x1b]*)\x1b\\$/;

/** A report with `progress` set for working and blocked states, which are the ones that carry it. */
export function withProgress(report: string, progress?: number): string {
  const match = REPORT.exec(report);
  if (!match) return report;
  const pairs = match[1]!.split(":").filter(pair => !pair.startsWith("progress="));
  const state = pairs.find(pair => pair.startsWith("state="))?.slice(6);
  if (progress !== undefined && (state === "working" || state === "blocked")) pairs.push(`progress=${Math.max(0, Math.min(100, Math.round(progress)))}`);
  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

interface StatusState { progress?: number; last?: string; write: (...args: any[]) => boolean }
type Patched = NodeJS.WriteStream & { [PATCHED]?: StatusState };

/** Patches the stream once (a /reload finds the patch on the stream) and returns a setter for the progress. */
export function registerProgressStatus(out: NodeJS.WriteStream = process.stdout): (progress?: number) => void {
  const stream = out as Patched;
  let state = stream[PATCHED];
  if (!state) {
    const created: StatusState = { write: out.write.bind(out) as (...args: any[]) => boolean };
    state = stream[PATCHED] = created;
    out.write = ((chunk: any, ...rest: any[]) => {
      if (typeof chunk === "string" && REPORT.test(chunk)) { created.last = chunk; chunk = withProgress(chunk, created.progress); }
      return created.write(chunk, ...rest);
    }) as typeof out.write;
  }
  const current = state;
  return (progress?: number) => {
    if (current.progress === progress) return;
    current.progress = progress;
    if (current.last) current.write(withProgress(current.last, progress));
  };
}
