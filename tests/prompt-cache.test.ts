// Two extension patterns make Pi fold every system message into the leading one,
// so any later tool or prompt section change rewrites the cached prefix: Anthropic
// then drops all earlier thinking blocks and re-bills the whole context.
// - before_agent_start returning systemPrompt (or setting forceSystemPrompt): use sections.
// - a context handler returning a changed list: use context_with_system.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { root } from "./helpers.ts";

// The systemPrompt rules apply only where before_agent_start is handled; side
// completions elsewhere may pass their own systemPrompt freely.
const AGENT_START = /\.on\(\s*["'`]before_agent_start["'`]/;
const RULES: [RegExp, string, boolean][] = [
  [/\.on\(\s*["'`]context["'`]/, "registers a context handler; use context_with_system", false],
  [/\bsystemPrompt\s*:(?!\s*(?:string|undefined)\b)|\{\s*systemPrompt\s*[,}]/, "returns systemPrompt; set systemPromptOptions.sections instead", true],
  [/\bforceSystemPrompt\b/, "forces the system prompt; set systemPromptOptions.sections instead", false],
];

// Line comments only where they start a token, so URLs in strings survive.
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const cacheBreakers = (source: string) => {
  const text = code(source), agentStart = AGENT_START.test(text);
  return RULES.filter(([pattern, , scoped]) => (!scoped || agentStart) && pattern.test(text)).map(([, why]) => why);
};

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(e => e.isDirectory() ? sources(join(dir, e.name)) : Promise.resolve(e.name.endsWith(".ts") ? [join(dir, e.name)] : [])));
  return nested.flat();
}

test("the cache tripwire catches each pattern and ignores comments and parameters", () => {
  assert.equal(cacheBreakers('pi.on("before_agent_start", async (event) => {\n  if (on) return { systemPrompt: `${event.systemPrompt}\\n\\nnote` };\n});').length, 1);
  assert.equal(cacheBreakers('pi.on("before_agent_start", () => { return { systemPrompt }; });').length, 1);
  assert.deepEqual(cacheBreakers("complete(model, { systemPrompt, messages });"), [], "side completions keep their own prompt");
  assert.equal(cacheBreakers("options.forceSystemPrompt = text;").length, 1);
  assert.equal(cacheBreakers("pi.on('context', (event) => ({ messages: event.messages.slice(1) }));").length, 1);
  assert.deepEqual(cacheBreakers('pi.on("context_with_system", e => e);'), []);
  assert.deepEqual(cacheBreakers("// not a returned systemPrompt: a forced prompt\n/* pi.on(\"context\") */"), []);
  assert.deepEqual(cacheBreakers("function run(name: string, systemPrompt: string, extra?: undefined) {}\nconst url = \"https://x\"; options.sections.note = event.systemPrompt;"), []);
});

test("no extension forces the system prompt or rewrites context without system messages", async () => {
  const problems: string[] = [];
  for (const file of await sources(join(root, "extensions"))) {
    for (const why of cacheBreakers(await readFile(file, "utf8"))) problems.push(`${relative(root, file)} ${why}`);
  }
  assert.deepEqual(problems, []);
});
