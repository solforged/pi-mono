// Loaded explicitly by image-paste.test.ts in installed Pi, so the checks use
// its real editor without a terminal or model calls.
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { useEditorFeature } from "../../extensions/shared/editor.ts";
import { pastedImageLabels } from "../../extensions/image-paste/labels.ts";

const keys = { matches: () => false, getKeys: () => [] };

export default function (pi: ExtensionAPI) {
  pi.registerCommand("image-paste-smoke", {
    description: "Check pasted image labels in Pi's real editor, offline",
    handler: async () => {
      let factory: any;
      const ctx = { ui: { getEditorComponent: () => undefined, setEditorComponent: (f: any) => { factory = f; } } };
      assert(useEditorFeature(ctx as any, "image-paste", pastedImageLabels));
      const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} };
      const editor = factory(tui, { borderColor: (s: string) => s, selectList: {} }, keys);
      const shot = "/var/folders/xy/T/pi-clipboard-4611c360-8175-4336-851d-b4ad18b1f839.png";
      // Without the border, styling or the cursor's position marker.
      const body = () => stripAnsi(editor.render(80).slice(1, -1).join("\n").replace(/\x1b_[^\x07]*\x07/g, ""));
      let submitted: string | undefined;
      editor.onSubmit = (text: string) => { submitted = text; };
      try {
        // Pasted flush against a word, the path is spaced off and shown as one short label.
        for (const key of "look") editor.handleInput(key);
        editor.insertTextAtCursor(shot);
        assert.equal(editor.getText(), "look [paste #1]");
        assert.equal(editor.getExpandedText(), `look ${shot}`);
        assert.match(body(), /^look \[image #1\]/);
        assert.doesNotMatch(body(), /pi-clipboard|paste #/);

        // A second image is numbered as attach will number it, by its place in the text.
        editor.handleInput("\x01"); // ctrl+a: start of line
        editor.insertTextAtCursor(shot.replace("4611", "9999"));
        assert.equal(editor.getText(), "[paste #2] look [paste #1]");
        assert.match(body(), /^\[image #1\] look \[image #2\]/);

        // Other inserted text is left alone.
        editor.setText("");
        editor.insertTextAtCursor("/tmp/notes.png");
        assert.equal(editor.getText(), "/tmp/notes.png");

        // A backspace removes a whole label.
        editor.setText("");
        editor.insertTextAtCursor(shot);
        editor.handleInput("\x7f");
        assert.equal(editor.getText(), "");

        // Submitting sends the path, for attach to turn into the image.
        editor.insertTextAtCursor(shot);
        editor.handleInput("\r");
        assert.equal(submitted, shot);
      } finally { editor.dispose(); }
      console.log("image-paste: pasted image labels passed");
    },
  });
}
