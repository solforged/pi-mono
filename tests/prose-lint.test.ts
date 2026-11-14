import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import extension from "../extensions/prose-lint/index.ts";
import { type Alert, introduced, isProse, note, vale } from "../extensions/prose-lint/lint.ts";
import { which } from "../extensions/shared/system.ts";
import { temporary } from "./helpers.ts";

const alert = (Check: string, Match: string, Line = 1): Alert => ({ Check, Match, Line, Message: `${Check} message`, Severity: "warning" });

test("introduced keeps only alerts beyond those the file already had, ignoring line shifts", () => {
  const before = [alert("Voice.Arrows", "→", 3), alert("Voice.Arrows", "→", 9), alert("Voice.Tics", "honestly", 4)];
  const after = [alert("Voice.Arrows", "→", 5), alert("Voice.Arrows", "→", 11), alert("Voice.Arrows", "→", 12), alert("Voice.Tics", "honestly", 6), alert("Voice.Openers", "Great question", 1)];
  assert.deepEqual(introduced(before, after).map(a => [a.Check, a.Line]), [["Voice.Arrows", 12], ["Voice.Openers", 1]]);
  assert.deepEqual(introduced(after, before), []);
});

test("note lists alerts by line and caps the list", () => {
  const one = note([alert("Voice.BoldLabels", "- **A:**", 7)], "README.md");
  assert.equal(one, "Vale: this edit added 1 style alert to README.md. Revise the prose, or keep a passage that is right as written.\n- line 7, Voice.BoldLabels: Voice.BoldLabels message");
  const many = note(Array.from({ length: 9 }, (_, i) => alert("Voice.Tics", `w${i}`, 9 - i)), "a.md");
  const lines = many.split("\n");
  assert.equal(lines.length, 8);
  assert.match(lines[1], /^- line 1,/);
  assert.equal(lines.at(-1), "- and 3 more");
});

test("isProse matches Markdown and React component paths", () => {
  assert.ok(isProse("docs/guide.md") && isProse("a.MDX") && isProse("notes.markdown") && isProse("web/App.tsx") && isProse("b.jsx"));
  assert.ok(!isProse("index.ts") && !isProse("README") && !isProse("md"));
});

const bin = which("vale");

/** A project with its own Vale style; the user's global configuration is hidden. */
async function project(t: Parameters<typeof temporary>[0]) {
  const dir = await temporary(t);
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, "no-global");
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  await mkdir(join(dir, "styles", "T"), { recursive: true });
  await writeFile(join(dir, ".vale.ini"), "StylesPath = styles\nMinAlertLevel = error\n\n[*.md]\nT.Arrow = YES\nT.Spelling = YES\n\n[**/README.md]\nT.Readme = YES\n");
  await writeFile(join(dir, "styles", "T", "Arrow.yml"), "extends: existence\nmessage: \"Arrow '%s'.\"\nlevel: warning\nnonword: true\ntokens:\n  - '→'\n");
  await writeFile(join(dir, "styles", "T", "Spelling.yml"), "extends: existence\nmessage: \"Spelling '%s'.\"\nlevel: error\ntokens:\n  - colour\n");
  await writeFile(join(dir, "styles", "T", "Readme.yml"), "extends: existence\nmessage: \"Readme '%s'.\"\nlevel: warning\ntokens:\n  - install\n");
  return dir;
}

test("vale lints stdin as the named file, with warnings, without spelling", { skip: !bin && "vale is not installed" }, async t => {
  const dir = await project(t);
  const text = "# Notes\n\nA miss → a slow read. The colour is gray. Then install it.\n";
  const notes = await vale(text, join(dir, "notes.md"), { bin });
  assert.deepEqual(notes.map(a => a.Check), ["T.Arrow"]);
  const readme = await vale(text, join(dir, "sub", "README.md"), { bin });
  assert.deepEqual(readme.map(a => a.Check).sort(), ["T.Arrow", "T.Readme"]);
  assert.deepEqual(await vale(text, join(dir, "notes.md"), { bin: join(dir, "missing-vale") }), []);
});

test("the extension appends only the alerts a Markdown edit introduced", { skip: !bin && "vale is not installed" }, async t => {
  const dir = await project(t);
  const handlers = new Map<string, Function>();
  extension({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
  const ctx = { cwd: dir, signal: undefined };
  const file = join(dir, "notes.md");
  await writeFile(file, "# Notes\n\nA miss → a slow read.\n");

  const run = async (id: string, path: string, next: string | undefined, isError = false) => {
    await handlers.get("tool_call")!({ toolName: "edit", toolCallId: id, input: { path } }, ctx);
    if (next !== undefined) await writeFile(join(dir, path), next);
    return handlers.get("tool_result")!({ toolName: "edit", toolCallId: id, input: { path }, content: [{ type: "text", text: "Edited." }], isError }, ctx);
  };

  const result = await run("1", "notes.md", "# Notes\n\nA miss → a slow read.\n\nA hit → a fast read.\n");
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].text, "Edited.");
  assert.match(result.content[1].text, /^Vale: this edit added 1 style alert to notes\.md\./);
  assert.match(result.content[1].text, /- line 5, T\.Arrow: Arrow '→'\./);

  assert.equal(await run("2", "notes.md", "# Notes\n\nA hit → a fast read.\n\nA miss → a slow read.\n"), undefined, "reordering adds nothing");
  assert.equal(await run("3", "notes.md", "# Notes\n\nA → b → c → d.\n", true), undefined, "a failed edit is left alone");
  assert.equal(await run("4", "notes.md", undefined), undefined, "an unchanged file is left alone");
  await handlers.get("tool_call")!({ toolName: "edit", toolCallId: "5", input: { path: "index.ts" } }, ctx);
  assert.equal(await handlers.get("tool_result")!({ toolName: "edit", toolCallId: "5", input: { path: "index.ts" }, content: [], isError: false }, ctx), undefined);
});
