// Explicitly loaded only by the regression suite. No model or network calls.
import assert from "node:assert/strict";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import install from "../../extensions/markdown-br/index.ts";

const stripAnsi = (text: string) =>
  text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

export default function (pi: ExtensionAPI) {
  install(pi);
  pi.registerCommand("markdown-br-smoke", {
    description: "Verify <br> rendering inside Markdown tables and inline code",
    handler: async () => {
      const source = [
        "| Item | Scope | Notes |",
        "| --- | --- | --- |",
        "| alpha | **first** (`long_token_name`)<br>`Second -> Line` | Line one.<br/>Line two with `<br>` in code. |",
      ].join("\n");
      const rendered = stripAnsi(new Markdown(source, 0, 0, getMarkdownTheme()).render(100).join("\n"));
      assert.doesNotMatch(rendered, /\)<br>Second/);
      assert.doesNotMatch(rendered, /Line one\.<br\/>Line two/);
      assert.match(rendered, /first \(long_token_name\)/);
      assert.match(rendered, /Second -> Line/);
      assert.match(rendered, /Line two with <br> in code\./);
      console.log("markdown-br integration: table <br> line breaks and inline code preservation passed");
    },
  });
}
