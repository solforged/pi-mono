// Loaded explicitly by rex-hub.test.ts in installed Pi, so the assertions use
// its real components without a terminal, Rex server, credentials or model calls.
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { openHub, type HubHost } from "../../extensions/rex/hub.ts";
import { HELP, type Entry } from "../../extensions/rex/hub-model.ts";
import { installLeftArrow } from "../../extensions/rex/left-editor.ts";

const child = (name: string, section: Entry["section"] = "running"): Entry => ({ key: `child:${name}`, childId: name, kind: "child", section,
  glyph: "●", tone: "accent", name, role: "scout", state: "Running", title: `Task for ${name}` });
const peer = (name: string): Entry => ({ ...child(name, "peers"), key: `peer:${name}`, kind: "peer", role: "", state: "working", glyph: "◆" });
const items = [child("oak"), child("birch", "done"), ...["system--audit-nix-setup", "pi-mono--improve-pi-rex", "pi-mono", "dotfiles"].map(peer)];
const keys = { matches: () => false, getKeys: () => [] };

export default function (pi: ExtensionAPI) {
  pi.registerCommand("rex-hub-check", {
    description: "Exercise the hub with Pi's real renderers, offline",
    handler: async (_args, ctx) => {
      let checks = 0;
      for (const width of [40, 80, 120, 160]) for (const height of [24, 32, 40, 65]) {
        let component: any, list = items, unsubscribed = false;
        const tui = { terminal: { columns: width, rows: height }, requestRender() {} };
        const host: HubHost = {
          list: () => list, subscribe: () => () => { unsubscribed = true; }, refreshPeers: async () => {},
          run: e => e.kind === "child" ? { owner: "managed", activeTask: "task", status: "running" } : undefined,
          detail: () => ({ facts: ["oak · scout", "Task: Hold fixture"], live: true }),
          tail: async () => "live screen line\nlatest live line", send: async () => "Sent to oak", act: async () => "Action receipt",
        };
        const signal = new AbortController();
        const closed = openHub({ ui: { custom: (factory: any) => new Promise<void>(done => {
          component = factory(tui, ctx.ui.theme, keys, done); component.focused = true;
        }) } } as any, host, signal.signal);
        const render = () => {
          const lines: string[] = component.render(width), plain = lines.map(stripAnsi);
          assert(lines.length <= tui.terminal.rows - 6, `${width}×${tui.terminal.rows}: ${lines.length} rows\n${plain.join("\n")}`);
          assert(lines.every(l => visibleWidth(l) <= width), `width ${width}`);
          assert.equal(plain[0], "─".repeat(width), "top accent border");
          assert.equal(plain.at(-1), "─".repeat(width), "bottom accent border never clipped");
          assert(plain.some(l => l.startsWith(" Agents ·")), "header uses Pi's margin");
          checks++;
          return { lines, plain, text: plain.join("\n") };
        };
        try {
          let view = render();
          assert.match(view.text, /→ ● oak/);
          if (width >= 80) assert.match(view.text, /← back/);
          if (height >= 40) {
            assert.equal(view.plain[1], "", "space after the opening border");
            assert.equal(view.plain[3], "", "space after the title");
            const next = view.plain.findIndex(l => l.trim() === "Done");
            assert.equal(view.plain[next - 1], "", "space between sections");
          }
          component.handleInput(" "); await new Promise(r => setTimeout(r, 0));
          view = render();
          assert.match(view.text, /Task: Hold fixture/);
          assert.match(view.text, /latest live line/);
          component.handleInput("?"); view = render();
          assert.match(view.text, /back to the prompt/);
          assert.match(view.text, /close keys/);
          assert.doesNotMatch(view.text, /Steer oak/);
          for (const [key] of HELP) assert(view.text.includes(key), `help key ${key} fits`);
          component.handleInput("?");
          component.handleInput("\x18"); view = render();
          assert.match(view.text, /Press ctrl\+x again/);
          component.handleInput("\x1b"); // clear confirmation
          // A long draft uses Pi's own editor viewport; do not slice its cursor away.
          component.handleInput("\x1b[200~" + "reply 中 é 👋 ".repeat(100) + "\x1b[201~");
          for (const input of ["", "\x1b[A", "\x1b[B", "\x01"]) {
            if (input) component.handleInput(input);
            view = render();
            assert(view.lines.some(l => l.includes(CURSOR_MARKER)), "draft cursor is visible");
            assert.match(view.text, /enter send/);
          }
          component.handleInput("\x1b"); // clear draft
          // A height-only resize must not reuse a taller cached render.
          tui.terminal.rows = 24; view = render();
          if (width >= 80) assert.match(view.text, /← back/);
          // Keep the selection in view with a long, scrolling list.
          list = Array.from({ length: 30 }, (_, i) => child(`child-${i}`, i < 15 ? "running" : "done"));
          component.invalidate();
          for (let i = 0; i < 29; i++) component.handleInput("\x1b[B");
          view = render(); assert.match(view.text, /→ ● child-29/); assert.match(view.text, /\(30\/30\)/);
          // Peer-only is the user's screenshot: no empty editor or child-action hints.
          list = items.filter(e => e.kind === "peer"); component.invalidate(); view = render();
          assert.match(view.text, /Other Pi sessions/); assert.doesNotMatch(view.text, /type reply|ctrl\+t pin/);
          list = []; component.invalidate(); view = render();
          assert.match(view.text, /No Rex children/);
        } finally { signal.abort(); await closed; assert(unsubscribed, "close disposes the live subscriptions"); }
      }

      // The guarded ← hint stays in the editor border, clears on the next key,
      // and expires. No ui.notify API is even provided to this editor.
      let factory: any, opened = 0;
      const leftCtx = { ui: { theme: ctx.ui.theme, getEditorComponent: () => undefined, setEditorComponent: (f: any) => { factory = f; } } };
      assert(installLeftArrow(leftCtx as any, () => { opened++; }, "Press ← again for agents"));
      const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} };
      const editorTheme = { borderColor: (s: string) => s, selectList: {} };
      const editor = factory(tui, editorTheme, keys);
      const arm = () => { editor.handleInput("x"); editor.handleInput("\x7f"); editor.handleInput("\x1b[D"); };
      try {
        arm(); assert.match(editor.render(80)[0], /Press ← again for agents/);
        assert.equal(visibleWidth(editor.render(12)[0]), 12);
        editor.handleInput("\x1b[D"); assert.equal(opened, 1); assert.doesNotMatch(editor.render(80)[0], /Press/);
        arm(); editor.handleInput("z"); assert.doesNotMatch(editor.render(80)[0], /Press/);
        editor.handleInput("\x7f"); arm();
        await new Promise(r => setTimeout(r, 2100)); assert.doesNotMatch(editor.render(80)[0], /Press/);
      } finally { editor.dispose(); }
      console.log(`Rex hub: ${checks} native layout checks and the transient editor hint passed`);
    },
  });
}
