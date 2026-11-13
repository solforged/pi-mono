import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Markdown, matchesKey, truncateToWidth, type EditorTheme } from "@earendil-works/pi-tui";
import { columns, COMMANDS, CONFIRM, entryLine, HELP, listLines, replyTarget, SECTIONS, tailLines, type Entry, type HubAction } from "./hub-model.ts";
import { money, widgetLine, type Row } from "./ui.ts";

/** What the hub needs from the coordinator. Everything is re-read on each render. */
export interface HubHost {
  list(): Entry[];
  /** Called on every child change; returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
  /** Re-reads other sessions' intercom cards. */
  refreshPeers(): Promise<void>;
  run(e: Entry): { owner: string; activeTask?: string; status: string } | undefined;
  /** Static peek facts, and the latest result as Markdown when there is no live screen worth showing. */
  detail(e: Entry): { facts: string[]; result?: string; live: boolean };
  tail(e: Entry, signal: AbortSignal): Promise<string>;
  send(e: Entry, text: string): Promise<string>;
  act(e: Entry, action: HubAction): Promise<string | void>;
}

const PEEK_LINES = 12, TAIL_MS = 1500, PEERS_MS = 3000, TICK_MS = 1000, CONFIRM_MS = 2500;
type Tone = "success" | "warning" | "error" | "dim";

export function widget(items: Row[]) {
  return (_tui: unknown, theme: any) => ({
    render: (width: number) => [truncateToWidth(widgetLine(items, theme), width)],
    invalidate() {},
  });
}

/**
 * The agent hub: a live list of children and other Pi sessions, with a peek
 * panel and a reply box. Closes with ←/Esc, or when `signal` aborts (session end).
 */
export function openHub(ctx: ExtensionContext, host: HubHost, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let selectedKey: string | undefined, peek = false, help = false, cache: string[] | undefined, cacheWidth = 0, disposed = false;
    let flash: { text: string; tone: Tone } | undefined, flashTimer: ReturnType<typeof setTimeout> | undefined;
    // A confirmation names exactly what the second press will do, and to which task.
    let confirm: { signature: string; at: number } | undefined;
    // A draft belongs to the entry and reply mode it was started for; it never retargets silently.
    let draft: { key: string; mode: "steer" | "followup"; task?: string } | undefined;
    const tails = new Map<string, string[]>(), results = new Map<string, { width: number; text: string; lines: string[] }>();
    const refresh = () => { if (disposed) return; cache = undefined; tui.requestRender(); };
    const editorTheme: EditorTheme = {
      borderColor: s => theme.fg("dim", s),
      selectList: { selectedPrefix: s => theme.fg("accent", s), selectedText: s => theme.fg("accent", s), description: s => theme.fg("muted", s),
        scrollInfo: s => theme.fg("dim", s), noMatch: s => theme.fg("warning", s) },
    };
    const editor = new Editor(tui, editorTheme);
    const say = (text: string, tone: Tone = "dim") => {
      if (disposed) return;
      flash = { text, tone }; if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flash = undefined; refresh(); }, tone === "error" ? 8000 : 4000); flashTimer.unref?.();
      refresh();
    };
    const fail = (error: unknown) => say(error instanceof Error ? error.message : String(error), "error");

    /** The selection; while drafting, the draft's entry (undefined if it is gone). */
    const selected = (list = host.list()) => {
      if (draft) { const at = list.findIndex(e => e.key === draft!.key); return { list, at, entry: at < 0 ? undefined : list[at] }; }
      const at = Math.max(0, list.findIndex(e => e.key === selectedKey));
      const entry = list[at]; selectedKey = entry?.key; return { list, at, entry };
    };
    const move = (by: number) => {
      const { list, at } = selected();
      if (list.length) selectedKey = list[Math.max(0, Math.min(list.length - 1, at + by))].key;
      confirm = undefined; refresh(); void pollTail();
    };
    const bind = (entry: Entry | undefined) => {
      const run = entry && host.run(entry), target = replyTarget(entry, run);
      return entry && target.mode !== "none" ? { key: entry.key, mode: target.mode, task: target.mode === "steer" ? run?.activeTask : undefined } : undefined;
    };
    // Submitting clears the editor (onChange "") just before onSubmit; keep the binding for it.
    let cleared: typeof draft;
    editor.onChange = text => { if (!text) { cleared = draft; draft = undefined; } else draft ??= bind(selected().entry); };

    // Live data: child changes push, elapsed times tick, other sessions and the peeked screen poll.
    const off = host.subscribe(refresh);
    const ticker = setInterval(refresh, TICK_MS); ticker.unref?.();
    const peers = setInterval(() => void host.refreshPeers().then(refresh, () => {}), PEERS_MS); peers.unref?.();
    void host.refreshPeers().then(refresh, () => {});
    let tailing: AbortController | undefined;
    async function pollTail() {
      const { entry } = selected();
      if (disposed || !peek || !entry || !host.detail(entry).live || tailing) return;
      tailing = new AbortController();
      try { tails.set(entry.key, tailLines(await host.tail(entry, AbortSignal.any([tailing.signal, AbortSignal.timeout(5000)])), PEEK_LINES)); refresh(); }
      catch { tails.delete(entry.key); }
      finally { tailing = undefined; }
    }
    const tailTimer = setInterval(() => void pollTail(), TAIL_MS); tailTimer.unref?.();
    /** Idempotent: from ←/Esc, session end, or Pi disposing the component. */
    const dispose = () => {
      if (disposed) return; disposed = true;
      off(); clearInterval(ticker); clearInterval(peers); clearInterval(tailTimer); if (flashTimer) clearTimeout(flashTimer);
      tailing?.abort(); signal.removeEventListener("abort", close);
    };
    function close() { if (disposed) return; dispose(); done(); }
    signal.addEventListener("abort", close, { once: true });

    editor.onSubmit = value => {
      const text = value.trim(), bound = cleared;
      cleared = undefined;
      if (!text) return;
      editor.setText(text); // The editor clears itself; keep the text until it is delivered.
      draft = bound;
      const { entry } = selected();
      if (!entry) { say("That child or session is gone; Esc clears the draft", "error"); return; }
      const now = bind(entry);
      if (!now) { const target = replyTarget(entry, host.run(entry)); say(target.mode === "none" ? target.reason : "Cannot reply", "warning"); return; }
      if (!bound || now.mode !== bound.mode || now.task !== bound.task) {
        draft = now;
        say(now.mode === "followup" ? `${entry.name}'s task ended: Enter again sends this as a new task` : `${entry.name} is on a different task now: Enter again steers that one`, "warning");
        return;
      }
      host.send(entry, text).then(message => {
        if (editor.getText().trim() === text) editor.setText("");
        say(message, "success");
      }, fail);
    };

    function act(key: HubAction | "stop") {
      const { entry } = selected();
      if (!entry) return;
      const run = host.run(entry);
      const action: HubAction = key === "stop" ? (run?.activeTask ? "cancel" : "close") : key;
      if (CONFIRM[key]) {
        const signature = `${action}:${entry.key}:${run?.activeTask ?? ""}`;
        if (confirm?.signature !== signature || Date.now() - confirm.at > CONFIRM_MS) {
          const what = action === "take" ? `take human control of ${entry.name} (the parent stops managing it)`
            : action === "cancel" ? `cancel ${entry.name}'s task` : `close ${entry.name}'s terminal (files are kept)`;
          confirm = { signature, at: Date.now() };
          say(`Press ${key === "take" ? "ctrl+o" : "ctrl+x"} again to ${what}`, "warning"); return;
        }
      }
      confirm = undefined;
      host.act(entry, action).then(message => { if (message) say(message, "success"); else refresh(); }, fail);
    }

    function handleInput(data: string) {
      const empty = !editor.getText();
      if (matchesKey(data, "ctrl+c")) return close();
      if (matchesKey(data, "escape")) {
        if (confirm) { confirm = undefined; flash = undefined; }
        else if (!empty) { editor.setText(""); draft = undefined; }
        else if (help) help = false;
        else if (peek) peek = false;
        else return close();
        return refresh();
      }
      if (empty) {
        if (matchesKey(data, "up")) return move(-1);
        if (matchesKey(data, "down")) return move(1);
        if (matchesKey(data, "left")) return close();
        if (matchesKey(data, "right") || matchesKey(data, "enter")) return act("open");
        if (matchesKey(data, "space")) { peek = !peek; refresh(); void pollTail(); return; }
        if (data === "?") { help = !help; return refresh(); }
        const command = Object.entries(COMMANDS).find(([key]) => matchesKey(data, key))?.[1];
        if (command) return act(command);
        // No reply box for this entry: say why instead of typing into a hidden editor.
        const { entry } = selected(), target = replyTarget(entry, entry && host.run(entry));
        if (target.mode === "none") { if (target.reason) say(target.reason, "warning"); return; }
      }
      editor.handleInput(data); // While drafting, ↑↓ move within the draft; the recipient stays fixed.
      refresh();
    }

    function render(width: number) {
      if (cache && cacheWidth === width) return cache;
      const { list, at, entry } = selected();
      const kids = list.filter(e => e.kind === "child"), others = list.length - kids.length;
      const total = kids.reduce((sum, e) => sum + (e.cost ?? 0), 0);
      const head = [`${theme.fg("accent", theme.bold("Agents"))} ${theme.fg("dim", `· ${kids.length} ${kids.length === 1 ? "child" : "children"} · ${others} other ${others === 1 ? "session" : "sessions"}${total ? ` · ${money(total)}` : ""}`)}`];
      if (!list.length) head.push("", theme.fg("muted", "  No Rex children yet, and no other Pi sessions are listening."), theme.fg("dim", "  Ask Pi to delegate with rex_agent, or start pi in another Rex pane."));
      // Pi clips a component taller than the terminal from the bottom, so the
      // total is a hard bound: Pi's footer and widgets keep a few rows.
      const budget = Math.max(10, (tui.terminal.rows || 40) - 6);
      const target = draft ? (entry ? { mode: draft.mode, label: draft.mode === "steer" ? `Steer ${entry.name}'s task` : `New task for ${entry.name}` } : { mode: "none" as const, reason: "That child or session is gone; Esc clears the draft" })
        : replyTarget(entry, entry && host.run(entry));
      const bottom = [""];
      if (target.mode === "none") { if (target.reason) bottom.push(theme.fg(draft ? "error" : "dim", target.reason)); }
      else bottom.push(theme.fg("muted", `${target.label}${entry?.section === "attention" ? theme.fg("dim", " · a dialog waiting in its pane needs → to answer") : ""}`));
      if (target.mode !== "none" || draft) bottom.push(...editor.render(width).slice(-Math.max(3, Math.floor(budget / 3))));
      if (flash) bottom.push(theme.fg(flash.tone, flash.text));
      bottom.push(theme.fg("dim", draft ? "enter send · shift+enter newline · esc clear" : help ? "? or esc closes the key list"
        : "↑↓ move · space peek · → open · type to reply · ctrl+t pin · ctrl+x stop · ? more · ← back"));
      const room = Math.max(1, budget - head.length - bottom.length);
      // The key list takes the place of the list and peek.
      if (help) {
        cache = [...head, ...HELP.map(([key, what]) => `${theme.fg("accent", key.padEnd(16))}${theme.fg("muted", what)}`).slice(0, room), ...bottom]
          .slice(0, budget).map(line => truncateToWidth(line, width));
        cacheWidth = width; return cache;
      }
      // The peek gets what the list leaves, and only when it can show something.
      const peeked = entry && peek && room >= 6 ? peekLines(entry, width) : undefined;
      const listRoom = peeked ? Math.max(3, Math.min(18, room - Math.min(peeked.facts.length + peeked.body.length + 1, Math.ceil(room * 0.6)))) : Math.min(18, room);
      const overflow = list.length + new Set(list.map(e => e.section)).size > listRoom;
      const view = listLines(list, Math.max(0, at), Math.max(1, listRoom - (overflow ? 2 : 0)));
      // Children and other sessions align separately: one long session name must not pad every child.
      const middle: string[] = [], kidCols = columns(kids, width), peerCols = columns(list.filter(e => e.kind === "peer"), width);
      if (view.above) middle.push(theme.fg("dim", `  ↑ ${view.above} more`));
      for (const line of view.lines) {
        if (line.kind === "section") middle.push(theme.fg(line.section === "attention" ? "warning" : line.section === "peers" ? "muted" : "accent", `${SECTIONS[line.section]}${line.count > 1 ? theme.fg("dim", ` · ${line.count}`) : ""}`));
        else middle.push(entryLine(line.entry, line.index === at, theme, line.entry.kind === "peer" ? peerCols : kidCols));
      }
      if (view.below) middle.push(theme.fg("dim", `  ↓ ${view.below} more`));
      if (peeked) {
        // Facts stay; a live screen keeps its newest lines, a result its beginning.
        const fit = room - middle.length - 1 - peeked.facts.length;
        const body = fit <= 0 ? [] : peeked.body.length <= fit ? peeked.body : peeked.live ? peeked.body.slice(-fit) : peeked.body.slice(0, fit);
        middle.push(theme.fg("dim", "─".repeat(Math.min(width, 120))), ...peeked.facts, ...body);
      }
      cache = [...head, ...middle.slice(0, room), ...bottom].slice(0, budget).map(line => truncateToWidth(line, width)); cacheWidth = width;
      return cache;
    }

    function peekLines(entry: Entry, width: number): { facts: string[]; body: string[]; live: boolean } {
      const detail = host.detail(entry), body: string[] = [];
      if (detail.live) {
        const tail = tails.get(entry.key);
        body.push(...(tail?.length ? tail.map(line => theme.fg("muted", `│ ${line}`)) : [theme.fg("dim", "│ reading its screen…")]));
      } else if (detail.result) {
        let shown = results.get(entry.key);
        if (shown?.width !== width || shown.text !== detail.result) {
          const lines = new Markdown(detail.result, 0, 0, getMarkdownTheme()).render(Math.max(20, width - 2));
          shown = { width, text: detail.result, lines: lines.length > PEEK_LINES ? [...lines.slice(0, PEEK_LINES), theme.fg("dim", `… ${lines.length - PEEK_LINES} more lines · ctrl+r prints it all`)] : lines };
          results.set(entry.key, shown);
        }
        body.push(...shown.lines);
      }
      return { facts: detail.facts.map(f => theme.fg("dim", f)), body, live: detail.live };
    }

    return {
      render, handleInput, dispose, invalidate: () => { cache = undefined; },
      get focused() { return editor.focused; },
      set focused(value: boolean) { editor.focused = value; },
    };
  });
}
