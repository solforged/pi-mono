import { BorderedLoader, DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";

export async function cancellable<T>(ctx: ExtensionCommandContext, title: string, signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  if (ctx.mode !== "tui") return fn(signal);
  return ctx.ui.custom<T | undefined>((tui, theme, _keys, done) => {
    const loader = new BorderedLoader(tui, theme, title);
    let finished = false;
    const finish = (result: T | undefined) => { if (!finished) { finished = true; done(result); } };
    loader.onAbort = () => finish(undefined);
    fn(AbortSignal.any([signal, loader.signal])).then(finish).catch((error) => {
      if (!signal.aborted && !loader.signal.aborted) ctx.ui.notify(String(error), "error");
      finish(undefined);
    });
    return loader;
  });
}

export async function pickMany(
  ctx: ExtensionCommandContext,
  title: string,
  items: Array<{ value: string; label: string; description?: string }>,
  signal: AbortSignal,
  max = 10,
  initial: Iterable<string> = [],
): Promise<string[] | undefined> {
  signal.throwIfAborted();
  if (!items.length) return [];
  return ctx.ui.custom<string[] | undefined>((tui, theme, _keys, done) => {
    const allowed = new Set(items.map((item) => item.value));
    const checked = new Set([...initial].filter((value) => allowed.has(value)).slice(0, max));
    let finished = false;
    const finish = (value?: string[]) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      done(value);
    };
    const abort = () => finish();
    const listTheme = {
      selectedPrefix: (s: string) => theme.fg("accent", s),
      selectedText: (s: string) => theme.fg("accent", s),
      description: (s: string) => theme.fg("muted", s),
      scrollInfo: (s: string) => theme.fg("dim", s),
      noMatch: (s: string) => theme.fg("warning", s),
    };
    const makeList = (keep?: string) => {
      const list = new SelectList(items.map((item) => ({
        ...item,
        label: `${checked.has(item.value) ? "[x] " : "[ ] "}${item.label}`,
      })), Math.min(items.length, 12), listTheme);
      list.onCancel = () => finish();
      if (keep) {
        const index = items.findIndex((item) => item.value === keep);
        if (index >= 0) list.setSelectedIndex(index);
      }
      return list;
    };
    let list = makeList();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) queueMicrotask(abort);
    return {
      render(width: number) {
        const frame = new Container();
        frame.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        frame.addChild(new Text(theme.fg("accent", theme.bold(`${title} (${checked.size}/${max})`)), 1, 0));
        frame.addChild(list);
        frame.addChild(new Text(theme.fg("dim", "↑↓ move · Space toggle · Enter review · Esc cancel"), 1, 0));
        frame.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return frame.render(width);
      },
      handleInput(data: string) {
        if (matchesKey(data, "space")) {
          const item = list.getSelectedItem();
          if (item) {
            if (checked.has(item.value)) checked.delete(item.value);
            else if (checked.size < max) checked.add(item.value);
            list = makeList(item.value);
          }
        } else if (matchesKey(data, "enter")) finish([...checked]);
        else list.handleInput(data);
        tui.requestRender();
      },
      invalidate() { list.invalidate(); },
      dispose() { finished = true; signal.removeEventListener("abort", abort); },
    };
  });
}
