import { DynamicBorder, getMarkdownTheme, rawKeyHint, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Markdown, matchesKey, Text, truncateToWidth, visibleWidth, type EditorTheme } from "@earendil-works/pi-tui";
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
    let selectedKey: string | undefined, peek = false, help = false, cache: string[] | undefined, cacheWidth = 0, cacheHeight = 0, disposed = false;
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
    const editor = new Editor(tui, editorTheme, { paddingX: 1 });
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

    // Use the same frame, margins and hint styling as Pi's selectors. Reserve
    // the editor and controls first; only the list and peek share the remainder.
    const border = new DynamicBorder(s => theme.fg("accent", s));
    const divider = new DynamicBorder(s => theme.fg("border", s));
    const hints = (pairs: [string, string][]) => pairs.map(([key, what]) => rawKeyHint(key, what)).join("  ");
    function render(width: number) {
      const height = tui.terminal.rows || 40;
      if (cache && cacheWidth === width && cacheHeight === height) return cache;
      const inner = Math.max(1, width - 2);
      const line = (text: string) => new Text(truncateToWidth(text, inner), 1, 0).render(width)[0];
      const { list, at, entry } = selected();
      const kids = list.filter(e => e.kind === "child"), others = list.length - kids.length;
      const total = kids.reduce((sum, e) => sum + (e.cost ?? 0), 0);
      const title = line(`${theme.fg("accent", theme.bold("Agents"))} ${theme.fg("dim", `· ${kids.length} ${kids.length === 1 ? "child" : "children"} · ${others} other ${others === 1 ? "session" : "sessions"}${total ? ` · ${money(total)}` : ""}`)}`);
      const target = draft ? (entry ? { mode: draft.mode, label: draft.mode === "steer" ? `Steer ${entry.name}'s task` : `New task for ${entry.name}` } : { mode: "none" as const, reason: "That child or session is gone; Esc clears the draft" })
        : replyTarget(entry, entry && host.run(entry));
      const reply: string[] = [];
      // Help replaces the list, peek and empty reply box, so every key fits at 80×24.
      if (!help || draft) {
        if (target.mode === "none") { if (target.reason) reply.push(line(theme.fg(draft ? "error" : "dim", target.reason))); }
        else reply.push(line(theme.fg("muted", `${target.label}${entry?.section === "attention" ? " · → answers the dialog in its pane" : ""}`)));
        if (target.mode !== "none" || draft) reply.push(...editor.render(width));
      }
      const primary: [string, string][] = [["↑↓", "move"], ["space", "peek"], ["→", "open"]];
      if (target.mode !== "none") primary.push(["type", "reply"]);
      const exit: [string, string][] = [["?", "more"], ["←", "back"]];
      const full = hints([...primary, ...(entry?.kind === "child" ? [["ctrl+t", "pin"], ["ctrl+x", "stop"]] as [string, string][] : []), ...exit]);
      const keyLine = draft ? hints([["enter", "send"], ["shift+enter", "newline"], ["esc", "clear"]])
        : help ? hints([["?", "close keys"], ["esc", "back"]]) : visibleWidth(full) <= inner ? full : hints([...primary, ...exit]);
      const controls = [...(flash ? [line(theme.fg(flash.tone, flash.text))] : []), line(keyLine)];
      // Pi keeps its own footer/widgets below us. Never clip the final frame:
      // doing so would drop the controls or the editor's cursor.
      const budget = Math.max(10, height - 6);
      const sections = new Set(list.map(e => e.section)).size;
      const listSize = list.length + sections;
      const peeked = !help && entry && peek ? peekLines(entry, inner) : undefined;
      const fixed = 3 + reply.length + controls.length; // two borders and the title
      const minimumBody = help ? HELP.length : Math.min(listSize || 2, 8) + (peeked ? 6 : 0);
      const spacious = budget - fixed >= minimumBody + 4 + Math.max(0, sections - 1);
      const gap = spacious ? [""] : [];
      const head = [...border.render(width), ...gap, title, ...gap];
      const bottom = [...(reply.length ? [...gap, ...reply] : []), ...gap, ...controls, ...border.render(width)];
      const room = Math.max(0, budget - head.length - bottom.length);
      const middle: string[] = [];
      if (help) {
        middle.push(...HELP.slice(0, room).map(([key, what]) => line(`${theme.fg("dim", key.padEnd(16))}${theme.fg("muted", what)}`)));
      } else if (!list.length) {
        middle.push(...[line(theme.fg("muted", "No Rex children yet, and no other Pi sessions are listening.")),
          line(theme.fg("dim", "Ask Pi to delegate, or start Pi in another Rex pane."))].slice(0, room));
      } else if (room) {
        const preview = peeked && room >= 7 ? peeked : undefined;
        const previewSize = preview ? preview.facts.length + preview.body.length + 1 + gap.length : 0;
        const listRoom = Math.min(18, room - Math.min(previewSize, Math.floor(room * 0.6)));
        const overflow = listSize + (spacious ? sections - 1 : 0) > listRoom;
        const countLine = overflow && listRoom > 1 ? 1 : 0;
        const view = listLines(list, Math.max(0, at), listRoom - countLine, spacious);
        const kidCols = columns(kids, inner), peerCols = columns(list.filter(e => e.kind === "peer"), inner);
        for (const row of view.lines) {
          middle.push(row.kind === "gap" ? "" : line(row.kind === "section"
            ? theme.fg(row.section === "attention" ? "warning" : row.section === "peers" ? "muted" : "accent", `${SECTIONS[row.section]}${row.count > 1 ? theme.fg("dim", ` · ${row.count}`) : ""}`)
            : entryLine(row.entry, row.index === at, theme, row.entry.kind === "peer" ? peerCols : kidCols)));
        }
        if (countLine) middle.push(line(theme.fg("dim", `  (${at + 1}/${list.length})`)));
        if (preview) {
          const available = room - middle.length - gap.length - 1;
          const facts = preview.facts.slice(0, available);
          const fit = Math.max(0, available - facts.length);
          const body = fit === 0 ? [] : preview.live ? preview.body.slice(-fit) : preview.body.slice(0, fit);
          middle.push(...gap, ...divider.render(width), ...[...facts, ...body].map(line));
        }
      }
      cache = [...head, ...middle, ...bottom]; cacheWidth = width; cacheHeight = height;
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
          const lines = new Markdown(detail.result, 0, 0, getMarkdownTheme()).render(Math.max(1, width));
          shown = { width, text: detail.result, lines: lines.length > PEEK_LINES ? [...lines.slice(0, PEEK_LINES), theme.fg("dim", `… ${lines.length - PEEK_LINES} more lines · ctrl+r prints it all`)] : lines };
          results.set(entry.key, shown);
        }
        body.push(...shown.lines);
      }
      return { facts: detail.facts.map(f => theme.fg("dim", f)), body, live: detail.live };
    }

    return {
      render, handleInput, dispose, invalidate: () => { cache = undefined; results.clear(); },
      get focused() { return editor.focused; },
      set focused(value: boolean) { editor.focused = value; },
    };
  });
}
