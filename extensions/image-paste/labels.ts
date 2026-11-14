// Shows a pasted image in the editor as `[image #N]` rather than its long
// temporary path. The path goes behind one of Pi's long-paste markers, so the
// editor moves over and deletes it as one character and submits the path,
// which `attach` then turns into the image. Only the display says "image":
// the label keeps the marker's width, so the cursor and wrapping stay right.
import type { FeatureFactory } from "../shared/editor.ts";
import { candidates, isClipboardFile } from "./paths.ts";

const MARKER = /\[paste #(\d+)\]/g;

/**
 * The number each image path gets when the prompt is sent: its place among
 * the image paths in the text, as in `attach`, if every one of them loads.
 */
export function imageNumbers(text: string): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const { path } of candidates(text)) if (!numbers.has(path)) numbers.set(path, numbers.size + 1);
  return numbers;
}

export const pastedImageLabels: FeatureFactory = (editor) => ({
  insert(text) {
    if (!text.startsWith("/") || !isClipboardFile(text)) return text;
    // Pi pastes the path flush against the text around it, where it would not
    // count as a path; space it off as Pi does pasted file paths.
    const { line, col } = editor.getCursor();
    const current = editor.getLines()[line] ?? "";
    const before = col > 0 && !/\s/.test(current[col - 1]) ? " " : "";
    const after = col < current.length && !/\s/.test(current[col]) ? " " : "";
    return before + editor.atom(text) + after;
  },
  line(line) {
    if (!line.includes("[paste #")) return line;
    let numbers: Map<string, number> | undefined;
    return line.replace(MARKER, (marker, id: string) => {
      const path = editor.atomContent(Number(id));
      if (!path || !isClipboardFile(path)) return marker;
      numbers ??= imageNumbers(editor.getExpandedText());
      const n = numbers.get(path);
      const label = `[image #${n}]`;
      return n && label.length === marker.length ? label : marker;
    });
  },
});
