import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Key, Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi, type EditorTheme } from "@earendil-works/pi-tui";
import { Form, notesOf, parseMulti, type Answer, type Question } from "./model.ts";

/** Discuss and interrupted endings carry what was entered, so the transcript keeps it. */
export type Ending = { outcome: "answered" | "discuss" | "interrupted"; answers: (Answer | undefined)[] };
/** A Rex child's user cannot chat with it, so "discuss" hands the questions back to the parent. */
const DISCUSS = process.env.PI_REX_CHILD ? "Hand back to the parent agent" : "Discuss in chat instead";

const PREVIEW_LINES = 16;
const OWN = "Type your own answer";

/** The terminal questionnaire. Resolves "interrupted" when the run is aborted. */
export function askInTerminal(ctx: ExtensionContext, questions: Question[], signal: AbortSignal | undefined): Promise<Ending> {
  if (signal?.aborted) return Promise.resolve({ outcome: "interrupted", answers: [] });
  return ctx.ui.custom<Ending>((tui, theme, keybindings, done) => {
    const form = new Form(questions);
    // "custom" edits the own-answer row; "note" edits a note on the focused option.
    let editing: false | "custom" | "note" = false, cache: string[] | undefined, cacheWidth = 0, closed = false;
    const finish = (ending: Ending) => {
      if (closed) return;
      closed = true; signal?.removeEventListener("abort", abort); done(ending);
    };
    const abort = () => finish({ outcome: "interrupted", answers: form.result });
    signal?.addEventListener("abort", abort, { once: true });
    const editorTheme: EditorTheme = {
      borderColor: s => theme.fg("accent", s),
      selectList: { selectedPrefix: s => theme.fg("accent", s), selectedText: s => theme.fg("accent", s), description: s => theme.fg("muted", s),
        scrollInfo: s => theme.fg("dim", s), noMatch: s => theme.fg("warning", s) },
    };
    const editor = new Editor(tui, editorTheme);
    const refresh = () => { cache = undefined; tui.requestRender(); };
    const step = (next: ReturnType<Form["enter"]>) => {
      if (next === "submit") return finish({ outcome: "answered", answers: form.result });
      if (next === "discuss") return finish({ outcome: "discuss", answers: form.result });
      if (next === "edit") { editing = "custom"; editor.setText(form.answers[form.tab]?.custom ?? form.drafts[form.tab] ?? ""); }
      if (next === "note") { editing = "note"; editor.setText(form.noteText); }
      refresh();
    };
    editor.onSubmit = value => {
      const mode = editing;
      editing = false; editor.setText("");
      step(mode === "note" ? form.note(value) : form.custom(value));
    };

    function handleInput(data: string) {
      if (editing) {
        // Esc keeps the text: a note stays on its option without choosing it; own-answer text is restored on reopening.
        if (matchesKey(data, Key.escape)) {
          if (editing === "note") form.note(editor.getText(), false);
          else form.drafts[form.tab] = editor.getText();
          editing = false; editor.setText("");
        } else editor.handleInput(data);
        return refresh();
      }
      if (keybindings.matches(data, "tui.select.cancel")) return finish({ outcome: "discuss", answers: form.result });
      if (form.tabs > 1 && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) { form.go(1); return refresh(); }
      if (form.tabs > 1 && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) { form.go(-1); return refresh(); }
      if (keybindings.matches(data, "tui.select.up")) { form.move(-1); return refresh(); }
      if (keybindings.matches(data, "tui.select.down")) { form.move(1); return refresh(); }
      if (data === " " || matchesKey(data, Key.space)) { form.toggle(); return refresh(); }
      if (keybindings.matches(data, "tui.select.confirm")) return step(form.enter());
      if (data === "n" || matchesKey(data, "n")) return step(form.startNote());
      if (/^[1-9]$/.test(data)) return step(form.number(Number(data)));
    }

    function render(width: number): string[] {
      if (cache && cacheWidth === width) return cache;
      const w = Math.max(10, width), lines: string[] = [];
      const add = (text: string, indent = 1) => {
        for (const part of wrapTextWithAnsi(text, Math.max(1, w - indent))) lines.push(" ".repeat(indent) + part);
      };
      // A note keeps its line breaks; continuation lines align under the text after the marker.
      const addNote = (text: string, indent: number, chosen: boolean, label?: string) => text.split("\n").forEach((row, i) => {
        const head = i ? "  " : theme.fg(chosen ? "accent" : "dim", "✎ ");
        const tail = !i && label ? theme.fg("dim", ` ${label}`) : "";
        for (const [j, part] of wrapTextWithAnsi(`${theme.fg(chosen ? "text" : "muted", row)}${tail}`, Math.max(1, w - indent - 2)).entries())
          lines.push(" ".repeat(indent) + (j ? "  " : head) + part);
      });
      lines.push(theme.fg("accent", "─".repeat(w)));
      if (form.tabs > 1) {
        const tabs = questions.map((q, i) => {
          const label = ` ${form.answers[i] ? "■" : "□"} ${q.header ?? `Q${i + 1}`} `;
          return i === form.tab ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(form.answers[i] ? "success" : "muted", label);
        });
        const review = " Review ";
        tabs.push(form.reviewing ? theme.bg("selectedBg", theme.fg("text", review)) : theme.fg("dim", review));
        add(tabs.join(" ")); lines.push("");
      }
      const q = form.question;
      if (!q) {
        add(theme.fg("accent", theme.bold("Review")));
        lines.push("");
        questions.forEach((item, i) => {
          const answer = form.answers[i], chosen = answer?.picked.map(n => item.options[n]?.label).filter(Boolean) ?? [];
          const own = answer?.custom ? `own answer: "${answer.custom}"` : "";
          const text = [chosen.join(", "), own].filter(Boolean).join("; ");
          add(`${theme.fg("muted", `${item.header ?? `Q${i + 1}`}: `)}${text || theme.fg("dim", "no answer (the agent decides)")}`, 2);
          for (const note of notesOf(item, form.answer(i))) addNote(note.text, 4, note.chosen, note.chosen ? `(${note.option})` : `(${note.option}, not chosen)`);
        });
        lines.push("");
        ["Submit answers", DISCUSS].forEach((label, i) => add(`${i === form.review ? theme.fg("accent", "› ") : "  "}${i === form.review ? theme.fg("accent", label) : label}`));
      } else {
        add(theme.bold(q.question));
        lines.push("");
        const answer = form.answers[form.tab], notes = form.notes[form.tab]!, cursor = form.cursor[form.tab]!;
        q.options.forEach((option, i) => {
          const at = i === cursor, picked = answer?.picked.includes(i);
          const mark = q.multi ? (picked ? "[x] " : "[ ] ") : picked ? "● " : "";
          const tag = i === q.recommended ? theme.fg("success", " (recommended)") : "";
          add(`${at ? theme.fg("accent", "› ") : "  "}${theme.fg(at ? "accent" : "text", `${i + 1}. ${mark}${option.label}`)}${tag}`);
          if (option.description) add(theme.fg("muted", option.description), 6);
          // The note editor opens in place of the note, under the option it belongs to.
          if (at && editing === "note") for (const part of editor.render(Math.max(1, w - 6))) lines.push(`      ${part}`);
          else if (notes[i]) addNote(notes[i]!, 6, !!picked, picked ? "" : "(not chosen; still sent)");
        });
        const own = cursor === form.ownRow;
        add(`${own ? theme.fg("accent", "› ") : "  "}${theme.fg(own ? "accent" : "dim", `${form.ownRow + 1}. ${answer?.custom ? `✎ "${answer.custom}"` : `${OWN}…`}`)}`);
        if (editing === "custom") {
          lines.push("");
          for (const part of editor.render(Math.max(1, w - 2))) lines.push(` ${part}`);
        }
        const preview = q.options[cursor]?.preview;
        if (preview && !editing) {
          lines.push("");
          const body = new Markdown(preview, 0, 0, getMarkdownTheme()).render(Math.max(1, w - 4));
          for (const part of body.slice(0, PREVIEW_LINES)) lines.push(`${theme.fg("dim", " │ ")}${part}`);
          if (body.length > PREVIEW_LINES) lines.push(theme.fg("dim", ` │ … ${body.length - PREVIEW_LINES} more lines`));
        }
      }
      lines.push("");
      const onOption = !!q && form.cursor[form.tab]! < form.ownRow;
      const keys = editing === "note" ? `enter ${q?.multi ? "check" : "choose"} with this note · esc keep note only · blank removes it · shift+enter newline`
        : editing ? "enter save (blank: the agent decides) · shift+enter newline · esc keep draft"
        : [form.tabs > 1 ? "tab/←→ question" : "", "↑↓ move", q?.multi ? "space toggle · enter next" : "enter choose", onOption ? (form.noteText ? "n edit note" : "n add a note") : "",
          process.env.PI_REX_CHILD ? "esc hand back" : "esc discuss in chat"].filter(Boolean).join(" · ");
      add(theme.fg("dim", keys));
      lines.push(theme.fg("accent", "─".repeat(w)));
      cache = lines.map(text => truncateToWidth(text, w));
      cacheWidth = width;
      return cache;
    }

    return { render, handleInput, invalidate: () => { cache = undefined; } };
  });
}

/** Hosts without custom TUI (RPC) get Pi's own dialogs, one question at a time. */
export async function askWithDialogs(ctx: ExtensionContext, questions: Question[], signal: AbortSignal | undefined): Promise<Ending> {
  const answers: (Answer | undefined)[] = [];
  const opts = signal ? { signal } : undefined;
  for (const [n, q] of questions.entries()) {
    if (signal?.aborted) return { outcome: "interrupted", answers };
    const title = `${questions.length > 1 ? `(${n + 1}/${questions.length}) ` : ""}${q.question}`;
    const labels = q.options.map((o, i) => `${i + 1}. ${o.label}${i === q.recommended ? " (recommended)" : ""}${o.description ? ` — ${o.description}` : ""}`);
    if (q.multi) {
      const reply = await ctx.ui.input(`${title}\n${labels.join("\n")}`, "Numbers like 1,3; optional text after ;", opts);
      if (reply === undefined) return { outcome: signal?.aborted ? "interrupted" : "discuss", answers };
      answers.push(parseMulti(reply, q.options.length));
      continue;
    }
    for (;;) {
      const choice = await ctx.ui.select(title, [...labels, `${OWN}…`, DISCUSS], opts);
      if (choice === undefined) return { outcome: signal?.aborted ? "interrupted" : "discuss", answers };
      if (choice === DISCUSS) return { outcome: "discuss", answers };
      if (choice !== `${OWN}…`) { answers.push({ picked: [labels.indexOf(choice)] }); break; }
      // Cancelling the input returns to the options; blank text leaves the question to the agent.
      const text = await ctx.ui.input(q.question, "Your answer (blank: the agent decides)", opts);
      if (signal?.aborted) return { outcome: "interrupted", answers };
      if (text === undefined) continue;
      answers.push(text.trim() ? { picked: [], custom: text.trim() } : undefined); break;
    }
  }
  return { outcome: "answered", answers };
}
