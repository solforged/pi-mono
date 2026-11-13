import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import {
  blockBrCount,
  normalizeBrTokens,
  patchMarkdown,
  REREVIEW_DATE,
  rereviewNotice,
} from "../extensions/markdown-br/patch.ts";
import { noModel, root } from "./helpers.ts";

test("normalizeBrTokens maps inline HTML <br> tags to Marked br tokens and leaves other tokens intact", () => {
  const original = [{ type: "text", text: "plain" }, { type: "codespan", text: "<br>" }];
  assert.equal(normalizeBrTokens(original), original, "allocates nothing when no HTML <br> token is present");

  const mixed = [
    { type: "text", text: "first" },
    { type: "html", raw: "<br>", text: "<br>" },
    { type: "text", text: "second" },
    { type: "html", raw: " <BR /> <br/> ", text: " <BR /> <br/> " },
    { type: "codespan", text: "<br>" },
    { type: "html", raw: "<span>kept</span>", text: "<span>kept</span>" },
  ];
  assert.deepEqual(normalizeBrTokens(mixed), [
    { type: "text", text: "first" },
    { type: "br", raw: "<br>" },
    { type: "text", text: "second" },
    { type: "br", raw: "<br>" },
    { type: "br", raw: "<br>" },
    { type: "codespan", text: "<br>" },
    { type: "html", raw: "<span>kept</span>", text: "<span>kept</span>" },
  ]);
  assert.equal(blockBrCount({ type: "html", raw: "<br><br/>" }), 2);
  assert.equal(blockBrCount({ type: "html", raw: "<div>x</div>" }), 0);
  assert.equal(blockBrCount({ type: "paragraph", raw: "<br>" }), 0);
});

test("patchMarkdown wraps idempotently and skips when upstream already renders <br> as newline", () => {
  class FakeMarkdown {
    renderInlineTokens(tokens: any[]): string {
      return tokens
        .map((t) => {
          if (t.type === "br") return "\n";
          if (t.type === "strong") return this.renderInlineTokens(t.tokens);
          return t.raw ?? t.text ?? "";
        })
        .join("");
    }
    renderToken(token: any): string[] {
      return [token.raw ?? token.text ?? ""];
    }
  }

  const first = patchMarkdown(FakeMarkdown);
  const second = patchMarkdown(FakeMarkdown);
  assert.deepEqual(first, { active: true, upstreamFixed: false });
  assert.deepEqual(second, { active: true, upstreamFixed: false });

  const instance = new FakeMarkdown();
  assert.equal(
    instance.renderInlineTokens([
      { type: "strong", tokens: [{ type: "text", text: "a" }, { type: "html", raw: "<br>" }, { type: "text", text: "b" }] },
    ]),
    "a\nb",
  );
  assert.deepEqual(instance.renderToken({ type: "html", raw: "<br/>" }), [""]);

  class FixedUpstreamMarkdown {
    renderInlineTokens(tokens: any[]): string {
      return tokens.map((t) => (t.type === "br" || (t.type === "html" && t.raw === "<br>") ? "\n" : t.text ?? "")).join("");
    }
  }
  assert.deepEqual(patchMarkdown(FixedUpstreamMarkdown), { active: false, upstreamFixed: true });
});

test("the wrappers pass on every argument Pi gives, and the probe sees a fix that uses its instance", () => {
  const seen: unknown[][] = [];
  class WiderMarkdown {
    renderInlineTokens(tokens: any[], ...rest: unknown[]): string { seen.push(rest); return tokens.map((t) => t.type).join(","); }
    renderToken(token: any, ...rest: unknown[]): string[] { seen.push(rest); return [token.type]; }
  }
  assert.deepEqual(patchMarkdown(WiderMarkdown), { active: true, upstreamFixed: false });
  const wide = new WiderMarkdown();
  assert.equal(wide.renderInlineTokens([{ type: "html", raw: "<br>" }], "style", "added later"), "br");
  assert.deepEqual(wide.renderToken({ type: "paragraph" }, 80, "space", "style", "added later"), ["paragraph"]);
  assert.deepEqual(seen.slice(-2), [["style", "added later"], [80, "space", "style", "added later"]]);

  // A fixed renderer that draws the break through its theme and a method of its own.
  class FixedThroughInstance {
    theme: { text: (text: string) => string };
    constructor(_text: string, _paddingX: number, _paddingY: number, theme: any) { this.theme = theme; }
    lineBreak() { return this.theme.text("\n"); }
    renderInlineTokens(tokens: any[]): string {
      return tokens.map((t) => (t.type === "br" || (t.type === "html" && t.raw === "<br>") ? this.lineBreak() : t.text ?? "")).join("");
    }
  }
  assert.deepEqual(patchMarkdown(FixedThroughInstance), { active: false, upstreamFixed: true });
});

test("rereviewNotice stays silent before REREVIEW_DATE and reports status once due", () => {
  assert.equal(REREVIEW_DATE, "2026-12-10");
  const before = Date.parse("2026-11-25T00:00:00Z");
  const onDate = Date.parse("2026-12-10T00:00:00Z");
  assert.equal(rereviewNotice({ active: true, upstreamFixed: false }, before), undefined);
  assert.match(rereviewNotice({ active: true, upstreamFixed: false }, onDate)!, /still renders <br> literally/);
  assert.match(rereviewNotice({ active: false, upstreamFixed: true }, onDate)!, /renders <br> natively/);
});

test("installed Pi renders <br> inside Markdown tables as line breaks", (t) => {
  const env = { ...process.env };
  for (const key of ["PI_REX_CHILD", "PI_WORKFLOW_CHILD_CONFIG"]) delete env[key];
  const check = spawnSync(
    "pi",
    [
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-session",
      "-e",
      join(root, "tests/fixtures/markdown-br-smoke.ts"),
      ...noModel,
      "-p",
      "/markdown-br-smoke",
    ],
    { cwd: root, encoding: "utf8", timeout: 30_000, env },
  );
  if (check.error && (check.error as any).code === "ENOENT") {
    t.skip("Pi is not installed");
    return;
  }
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /markdown-br integration:.*passed/);
});
