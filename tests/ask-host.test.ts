import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import { root } from "./helpers.ts";

// Real Pi with a fixed-response provider: no credentials or model requests.
const args = ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-session",
  "-e", "./extensions/ask/index.ts", "-e", "./tests/fixtures/ask-provider.ts", "--provider", "ask-smoke", "--model", "ask-smoke/fixture"];

test("print mode never offers the tool", t => {
  const result = spawnSync("pi", [...args, "-p", "tools"], { cwd: root, encoding: "utf8", timeout: 30_000 });
  if ((result.error as NodeJS.ErrnoException)?.code === "ENOENT") return t.skip("Pi is not installed");
  assert.match(result.stdout, /FIXTURE TOOLS /);
  assert.doesNotMatch(result.stdout, /ask_user_question/);
});

test("RPC hosts answer through Pi's own dialogs", async t => {
  if (spawnSync("pi", ["--version"]).error) return t.skip("Pi is not installed");
  const pi = spawn("pi", [...args, "--mode", "rpc"], { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => pi.kill());
  const send = (value: object) => pi.stdin.write(`${JSON.stringify(value)}\n`);
  const requests: any[] = [];
  const echo = new Promise<string>((resolve, reject) => {
    setTimeout(() => reject(new Error(`Timed out; requests ${JSON.stringify(requests)}`)), 20_000).unref();
    createInterface({ input: pi.stdout }).on("line", line => {
      const record = JSON.parse(line);
      if (record.type === "extension_ui_request" && record.method === "select") {
        requests.push(record);
        send({ type: "extension_ui_response", id: record.id, value: record.options.find((o: string) => o.startsWith("2. ")) });
      }
      if (record.type === "extension_ui_request" && record.method === "input") {
        requests.push(record);
        send({ type: "extension_ui_response", id: record.id, value: "1, 2; reads only" });
      }
      const text = record.type === "message_end" && record.message?.role === "assistant" ? record.message.content?.[0]?.text : undefined;
      if (text?.startsWith("FIXTURE ECHO")) resolve(text);
    });
  });
  send({ type: "prompt", message: "go" });
  const text = await echo;
  assert.deepEqual(requests.map(r => r.method), ["select", "input"]);
  assert.match(requests[0].options.at(-1), /Discuss in chat/);
  assert.match(text, /Which database should the service use\? → Postgres/);
  assert.match(text, /Which caches should we add\? → HTTP, Query; own answer: "reads only"/);
});

// Answers the dialog with "Discuss in chat" and returns the run's records.
async function discuss(t: { after: (fn: () => unknown) => unknown }, prompt: string) {
  const pi = spawn("pi", [...args, "--mode", "rpc"], { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => pi.kill());
  const send = (value: object) => pi.stdin.write(`${JSON.stringify(value)}\n`);
  const records: any[] = [];
  const end = new Promise<void>((resolve, reject) => {
    setTimeout(() => reject(new Error(`Timed out; ${JSON.stringify(records.map(r => r.type))}`)), 20_000).unref();
    createInterface({ input: pi.stdout }).on("line", line => {
      const record = JSON.parse(line); records.push(record);
      if (record.type === "extension_ui_request" && record.method === "select") send({ type: "extension_ui_response", id: record.id, value: record.options.at(-1) });
      if (record.type === "agent_end") resolve();
    });
  });
  send({ type: "prompt", message: prompt });
  await end;
  return {
    ended: records.filter(r => r.type === "tool_execution_end").map(r => [r.toolName, !!r.isError]),
    replies: records.filter(r => r.type === "message_end" && r.message?.role === "assistant").map(r => r.message),
  };
}

test("discussing stops the run, blocking tool calls after the ask", async t => {
  if (spawnSync("pi", ["--version"]).error) return t.skip("Pi is not installed");
  const { ended, replies } = await discuss(t, "mixed");
  assert.deepEqual(ended, [["ask_user_question", false], ["read", true]]);
  assert.equal(replies.length, 1);
});

test("a call that ran before the ask leaves the model one reply, which is told to end the turn", async t => {
  if (spawnSync("pi", ["--version"]).error) return t.skip("Pi is not installed");
  const { ended, replies } = await discuss(t, "before");
  // Pi ends a batch early only when every result terminates, and the read's does not.
  assert.deepEqual(ended, [["read", false], ["ask_user_question", false]]);
  assert.equal(replies.length, 2);
  assert.match(replies[1].content[0].text, /^FIXTURE ECHO .*Nothing was answered\. End your turn now, without calling tools, and wait for their message\.$/);
});
