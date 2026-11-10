// Live acceptance check for extensions/sandbox: needs Apple container services
// and may build the image on first use. Run with `mise run sandbox:smoke`.
// Uses a throwaway repository; no model calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import install from "../../extensions/sandbox/index.ts";
import { containerName } from "../../extensions/sandbox/plan.ts";

const text = (result: any) => result.content.map((part: any) => part.text ?? "").join("");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const running = (name: string) => {
  try { return JSON.parse(execFileSync("container", ["inspect", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0]?.status?.state === "running"; } catch { return false; }
};

export default function (pi: ExtensionAPI) {
  const tools: Record<string, any> = {}, events: Record<string, any> = {}, commands: Record<string, any> = {};
  const segments: any[] = [];
  const marker = () => segments.at(-1);
  let active = ["read", "write", "edit", "bash", "ls", "find", "grep", "git_commit"];
  const load = () => install({
    on: (event: string, fn: any) => { events[event] = fn; },
    events: { emit: (_name: string, data: any) => { segments.push(data); }, on: () => {} },
    registerTool: (definition: any) => { tools[definition.name] = definition; },
    registerCommand: (name: string, options: any) => { commands[name] = options; },
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => "on",
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
  } as any);
  load();

  pi.registerCommand("sandbox-smoke", {
    description: "Exercise the sandbox extension against a live container",
    handler: async (_args, ctx) => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-smoke-")));
      const name = containerName(repo);
      const notes: string[] = [];
      const fake = {
        ...ctx, cwd: repo, hasUI: true,
        ui: { theme: { fg: (_c: string, s: string) => s }, setStatus: () => {}, notify: (message: string) => { notes.push(message); } },
      };
      const call = (tool: string, params: any, signal?: AbortSignal) => tools[tool].execute("call", params, signal, undefined, fake);
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      try {
        git("init", "-q");
        git("config", "user.name", "Smoke");
        git("config", "user.email", "smoke@example.com");
        git("config", "commit.gpgsign", "false");
        writeFileSync(join(repo, "package.json"), "{}\n");
        writeFileSync(join(repo, "notes.txt"), "alpha\nbeta\n");
        git("add", "-A");
        git("commit", "-q", "-m", "chore: seeded");

        await events.session_start({ reason: "new" }, fake);
        const started = Date.now();
        assert.match(text(await call("bash", { command: "uname -s && id -u" })), /Linux\n0/);
        console.log(`first command after ${Date.now() - started} ms (includes any image build and container start)`);
        // The marker leads the status line and differs clearly between on and off.
        assert.deepEqual(marker(), { key: "sandbox", text: "\u{F01A6}", color: "success", priority: 8, position: "start" });

        // File tools act on the host's files through the same paths.
        await call("write", { path: "src/hello.txt", content: "hello from the guest\n" });
        assert.equal(readFileSync(join(repo, "src/hello.txt"), "utf8"), "hello from the guest\n");
        await call("edit", { path: "src/hello.txt", edits: [{ oldText: "guest", newText: "sandbox" }] });
        assert.match(text(await call("read", { path: `${repo}/src/hello.txt` })), /hello from the sandbox/);
        assert.match(text(await call("ls", { path: "." })), /src\//);
        assert.match(text(await call("find", { pattern: "*.txt" })), /src\/hello\.txt/);
        assert.match(text(await call("grep", { pattern: "beta", context: 1 })), /notes\.txt:2: beta/);
        assert.match(text(await call("grep", { pattern: "absent-needle" })), /No matches found/);
        await assert.rejects(call("read", { path: "/etc/hostname-nope" }), /ENOENT|not found/i);

        // Host-only paths are absent; guards and overlays hold.
        assert.match(text(await call("bash", { command: "test -e ~/.ssh && echo ssh-visible || echo ssh-hidden" })), /ssh-hidden/);
        assert.match(text(await call("bash", { command: "echo x >> .git/config 2>&1 || echo guarded" })), /guarded/);
        assert.match(text(await call("bash", { command: "touch .git/hooks/pre-commit 2>&1 || echo guarded" })), /guarded/);
        await call("bash", { command: "mkdir -p node_modules && echo linux > node_modules/marker" });
        assert(!existsSync(join(repo, "node_modules/marker")), "node_modules writes reached the host");
        assert.equal(text(await call("bash", { command: "env | grep -c -E 'API_KEY|TOKEN' || true" })).trim(), "0");

        // Cancellation reaches background children in the guest.
        const abort = new AbortController();
        const pending = call("bash", { command: "sleep 600 & sleep 601 & wait" }, abort.signal);
        await sleep(1500);
        abort.abort();
        await assert.rejects(pending, /abort/i);
        await sleep(2500);
        assert.match(text(await call("bash", { command: "pgrep -f 'sleep 60[01]' || echo none-left" })), /none-left/);

        // Commits: the guest refuses, the host tool commits what the guest staged.
        await call("bash", { command: "git add src/hello.txt" });
        assert.match(text(await call("bash", { command: "git commit -m 'feat: tried' 2>&1; echo rc=$?" })), /created on the host[\s\S]*rc=1/);
        process.env.GIT_CONFIG_GLOBAL = "/dev/null";
        assert.match(text(await call("git_commit", { message: "feat: committed from the sandbox" })), /committed from the sandbox/);
        delete process.env.GIT_CONFIG_GLOBAL;
        assert.match(git("log", "-1", "--format=%s"), /committed from the sandbox/);

        // The prompt says where tools run; turning it off routes tools to the host.
        const prompt = await events.before_agent_start({ systemPrompt: "base" }, fake);
        assert.match(prompt.systemPrompt, /Debian Linux arm64 container/);
        await commands.sandbox.handler("off", fake);
        assert.deepEqual([marker().text, marker().color], ["\u{F141D} off", "warning"]);
        assert.match(text(await call("bash", { command: "uname -s" })), /Darwin/);
        assert(!active.includes("git_commit"));
        await commands.sandbox.handler("on", fake);
        assert(active.includes("git_commit"));
        assert.match(text(await call("bash", { command: "uname -s" })), /Linux/);

        if (process.env.LLM_WIKI_DIR) {
          let built = "";
          for (let i = 0; i < 60 && !built.includes("ELF"); i++) {
            built = text(await call("bash", { command: 'file -b "$LLM_WIKI_DIR/bin/wiki" 2>/dev/null || true' }));
            if (!built.includes("ELF")) await sleep(2000);
          }
          assert.match(built, /ELF 64-bit.*aarch64/, "the Linux wiki binary was not built");
          assert.match(execFileSync("file", ["-b", join(process.env.LLM_WIKI_DIR, "bin/wiki")], { encoding: "utf8" }), /Mach-O/);
        }

        // A session switch replaces the extension instance; the container and
        // what runs in it carry over to the next one.
        await call("bash", { command: "setsid nohup sleep 700 >/dev/null 2>&1 & echo started" });
        await events.session_shutdown({ reason: "new" }, fake);
        load();
        await events.session_start({ reason: "new" }, fake);
        assert(running(name), "the container did not survive a session switch");
        assert.match(text(await call("bash", { command: "pgrep -f 'sleep 700' >/dev/null && echo survived || echo restarted" })), /survived/);

        await events.session_shutdown({ reason: "quit" }, fake);
        for (let i = 0; i < 30 && running(name); i++) await sleep(500);
        assert(!running(name), "the container outlived its last session");
        assert.deepEqual(notes.filter((note) => /unavailable/i.test(note)), []);
        console.log("Sandbox smoke: passed");
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
        await events.session_shutdown?.({ reason: "quit" }, fake);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  });
}
