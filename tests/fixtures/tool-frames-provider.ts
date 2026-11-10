// Loaded explicitly for the tool-frames demo (docs/tool-frames.md). Never deploy
// this fixture as an extension. A scripted model that calls each built-in tool
// once or twice, so every framed row can be looked at in a real TUI. Run it in
// an empty scratch directory: it seeds src/ there when src/ is missing.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "../../extensions/workflows/process.ts";

const SEED: Record<string, string> = {
  "src/app.ts": "import { createServer } from \"node:http\";\nimport { sleep } from \"./util.ts\";\n\nconst PORT = 8080;\nconst RETRIES = 5;\n\nexport async function startServer(): Promise<void> {\n  let attempt = 0;\n  while (attempt <= RETRIES) {\n    try {\n      await listen(PORT);\n      return;\n    } catch (error) {\n      console.error(`listen failed: ${error}`);\n    }\n    await sleep(100);\n  }\n  throw new Error(\"Could not start the server\");\n}\n\nfunction listen(port: number): Promise<void> {\n  return new Promise((resolve, reject) => {\n    const server = createServer((_req, res) => res.end(\"ok\"));\n    server.once(\"error\", reject);\n    server.listen(port, resolve);\n  });\n}\n",
  "src/util.ts": "export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));\n",
  "src/main.ts": "import { startServer } from \"./app.ts\";\nawait startServer();\n",
};

type Call = [string, Record<string, unknown>];
const SCRIPT: Array<{ say: string; calls: Call[] }> = [
  { say: "I'll look at the entry point and where it is used before changing anything.", calls: [
    ["read", { path: "src/app.ts", offset: 1, limit: 30 }],
    ["grep", { pattern: "startServer", path: "src" }],
    ["find", { pattern: "*.ts", path: "src" }],
    ["ls", { path: "." }],
  ] },
  { say: "The port is hard-coded and the retry loop never backs off; both are small edits.", calls: [
    ["edit", { path: "src/app.ts", edits: [
      { oldText: "const PORT = 8080;", newText: "const PORT = Number(process.env.PORT ?? 8080);" },
      { oldText: "    await sleep(100);", newText: "    await sleep(100 * 2 ** attempt);\n    attempt++;" },
    ] }],
  ] },
  { say: "A small helper keeps the parsing out of the entry point.", calls: [
    ["write", { path: "src/env.ts", content: "// Reads settings from the environment with typed defaults.\nexport function port(fallback = 8080): number {\n  const value = Number(process.env.PORT);\n  return Number.isInteger(value) && value > 0 ? value : fallback;\n}\n\nexport function retries(fallback = 5): number {\n  const value = Number(process.env.RETRIES);\n  return Number.isInteger(value) && value >= 0 ? value : fallback;\n}\n" }],
  ] },
  { say: "I'll patch the import with a script, the way a model sometimes does.", calls: [
    ["bash", { command: `cd ${process.cwd()} && python3 - <<'EOF'\np='src/app.ts'\ns=open(p).read()\ns=s.replace('import { sleep } from "./util.ts";','import { sleep } from "./util.ts";\\nimport { port } from "./env.ts";')\nopen(p,'w').write(s)\nEOF\nhead -3 src/app.ts` }],
  ] },
  { say: "Running the tests.", calls: [
    ["bash", { command: "node -e \"for (const t of ['parses PORT', 'falls back to 8080', 'backs off between retries']) console.log('ok - ' + t); console.log('not ok - retries stop after RETRIES'); console.error('  expected 5 attempts, got 6'); process.exit(1)\"" }],
  ] },
  { say: "The loop counts from zero; one more look, then a longer run.", calls: [
    ["read", { path: "src/missing.ts" }],
    ["bash", { command: "for i in $(seq 1 40); do echo \"step $i of 40\"; sleep 0.1; done", timeout: 30 }],
  ] },
];

// TOOL_FRAMES_STEPS=1,3 plays only those steps, to look at a few rows at once.
const STEPS = process.env.TOOL_FRAMES_STEPS?.split(",").map(Number).map((i) => SCRIPT[i]).filter(Boolean) ?? SCRIPT;

export default function (pi: ExtensionAPI) {
  if (!existsSync("src")) {
    mkdirSync("src");
    for (const [file, content] of Object.entries(SEED)) writeFileSync(file, content);
  }
  globalThis.fetch = async () => { throw new Error("Network access forbidden in the tool-frames fixture"); };
  pi.registerProvider("tool-frames-demo", {
    baseUrl: "https://invalid.example", apiKey: "test-only-not-a-credential", api: "tool-frames-demo",
    models: [{ id: "fixture", name: "Tool frames fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const step = STEPS[context.messages.filter((m: any) => m.role === "assistant").length];
      const output: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
        timestamp: Date.now(), stopReason: "stop", content: [], usage: emptyUsage() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: output });
        const text = { type: "text" as const, text: step?.say ?? "That's every tool row." };
        output.content.push(text);
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: output });
        for (const [name, args] of step?.calls ?? []) {
          const block = { type: "toolCall" as const, id: `${name}-${output.content.length}-${Date.now()}`, name, arguments: args };
          output.content.push(block);
          stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: output.content.length - 1, toolCall: block, partial: output });
        }
        output.stopReason = step?.calls.length ? "toolUse" : "stop";
        stream.push({ type: "done", reason: output.stopReason as "toolUse" | "stop", message: output });
        stream.end();
      });
      return stream;
    },
  });
}
