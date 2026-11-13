// Live acceptance check for extensions/sandbox: needs Apple container services
// and may build the image on first use. Run with `pm-sandbox-smoke`.
// Uses a throwaway repository; no model calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import install from "../../extensions/sandbox/index.ts";
import { containerName } from "../../extensions/sandbox/plan.ts";
import { resolveSettings } from "../../extensions/sandbox/settings.ts";
import { savedToggle, togglesFile } from "../../extensions/sandbox/toggles.ts";

// Removes the throwaway repository's saved toggle, even after a failure.
const forget = (root: string) => {
  const file = togglesFile(getAgentDir());
  try {
    const toggles = JSON.parse(readFileSync(file, "utf8"));
    if (root in toggles) { delete toggles[root]; writeFileSync(file, `${JSON.stringify(toggles, null, 2)}\n`); }
  } catch {}
};
const text = (result: any) => result.content.map((part: any) => part.text ?? "").join("");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const running = (name: string) => {
  try { return JSON.parse(execFileSync("container", ["inspect", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0]?.status?.state === "running"; } catch { return false; }
};

export default function (pi: ExtensionAPI) {
  const tools: Record<string, any> = {}, events: Record<string, any> = {}, commands: Record<string, any> = {};
  const segments: any[] = [];
  const marker = () => segments.at(-1);
  let flag: string | undefined = "on";
  let active = ["read", "write", "edit", "bash", "ls", "find", "grep", "git_commit"];
  const load = () => install({
    on: (event: string, fn: any) => { events[event] = fn; },
    events: { emit: (_name: string, data: any) => { segments.push(data); }, on: () => {} },
    registerTool: (definition: any) => { tools[definition.name] = definition; },
    registerCommand: (name: string, options: any) => { commands[name] = options; },
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => flag,
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
        // Skills and the user's Git files are often links to somewhere the guest
        // does not have. They must read the same there, by the paths Pi names.
        const names = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };
        const skills = join(homedir(), ".agents", "skills"), gitFiles = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git");
        const shared = [
          ...names(skills).map((skill) => join(skills, skill, "SKILL.md")),
          ...names(gitFiles).filter((file) => !file.startsWith("credentials")).map((file) => join(gitFiles, file)),
        ].filter((file) => { try { return statSync(file).isFile() && !file.includes("'"); } catch { return false; } });
        if (shared.length) {
          const sums = text(await call("bash", { command: `sha256sum ${shared.map((file) => `'${file}'`).join(" ")}` }));
          for (const file of shared) assert(sums.includes(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${file}`), `${file} differs in the guest:\n${sums}`);
          console.log(`${shared.length} skill and Git files read the same in the guest`);
        }
        assert.doesNotMatch(text(await call("bash", { command: `ls -a '${gitFiles}' 2>/dev/null; true` })), /credentials|hooks/);
        // The marker shows only while the sandbox is on.
        assert.deepEqual(marker(), { key: "sandbox", text: "\u{F01A6}", color: "success", priority: 8 });

        // File tools act on the host's files through the same paths.
        await call("write", { path: "src/hello.txt", content: "hello from the guest\n" });
        assert.equal(readFileSync(join(repo, "src/hello.txt"), "utf8"), "hello from the guest\n");
        await call("edit", { path: "src/hello.txt", edits: [{ oldText: "guest", newText: "sandbox" }] });
        assert.match(text(await call("read", { path: `${repo}/src/hello.txt` })), /hello from the sandbox/);
        assert.match(text(await call("ls", { path: "." })), /src\//);
        assert.match(text(await call("find", { pattern: "*.txt" })), /src\/hello\.txt/);
        assert.match(text(await call("grep", { pattern: "beta", context: 1 })), /notes\.txt:2: beta/);
        assert.match(text(await call("grep", { pattern: "absent-needle" })), /No matches found/);
        // A glob with a slash is matched from the searched directory, as on the host.
        assert.match(text(await call("grep", { pattern: "hello", glob: "src/*.txt" })), /^src\/hello\.txt:1: hello/);
        assert.match(text(await call("grep", { pattern: "hello", path: "src", glob: "./*.txt" })), /^hello\.txt:1: hello/);

        // Long output is saved where the guest's own tools can read it.
        const long = text(await call("bash", { command: "seq 1 5000" }));
        const log = /Full output: (\S+)\]/.exec(long)?.[1] ?? "";
        assert.match(log, /\/pi-sandbox\/output\/pi-sbx-[^/]+\/pi-bash-[0-9a-f]+\.log$/, long.slice(-300));
        assert.equal(readFileSync(log, "utf8").split("\n").length, 5001);
        assert.match(text(await call("read", { path: log, limit: 2 })), /^1\n2\n/);
        assert.match(text(await call("bash", { command: `sed -n 3p ${log}; wc -l < ${log}; touch ${log}.x 2>&1 || echo read-only` })), /^3\n5000\n[\s\S]*read-only/);
        // A failing command reports its own exit status, with no restart.
        assert.match(text(await call("bash", { command: "echo container x not found >&2; exit 3" })), /exited with code 3/);
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
        // File tools stop with their call too: a read that can never finish leaves no `cat` behind.
        await call("bash", { command: "mkfifo /tmp/pi-smoke-fifo" });
        const stopRead = new AbortController();
        const reading = call("read", { path: "/tmp/pi-smoke-fifo" }, stopRead.signal);
        await sleep(1500);
        stopRead.abort();
        await assert.rejects(reading, /abort/i);
        await sleep(1000);
        assert.match(text(await call("bash", { command: "pgrep -x cat || echo none-left" })), /none-left/);
        await assert.rejects(call("find", { pattern: "*.txt", path: "nowhere" }), /Path not found/);
        // So does a timeout, without waiting for the client to be killed.
        const timing = Date.now();
        await assert.rejects(call("bash", { command: "sleep 602", timeout: 1 }), /timed out after 1 seconds/);
        assert(Date.now() - timing < 4000, `a timeout took ${Date.now() - timing} ms`);
        assert.match(text(await call("bash", { command: "pgrep -f 'sleep 60[2]' || echo none-left" })), /none-left/);
        // A search that stops at its limit ends ripgrep too.
        await call("bash", { command: "mkdir -p many && for i in $(seq 1 300); do echo needle > many/$i.txt; done" });
        const limited = Date.now();
        assert.match(text(await call("grep", { pattern: "needle", path: "many", limit: 5 })), /5 matches limit reached/);
        assert(Date.now() - limited < 4000, `a limited grep took ${Date.now() - limited} ms`);

        // The guards cannot be left behind by moving the Git directory away.
        assert.match(text(await call("bash", { command: "mv .git .git-moved 2>&1 || echo guarded" })), /guarded/);
        assert(existsSync(join(repo, ".git", "HEAD")) && !existsSync(join(repo, ".git-moved")));
        // A commondir file can still be added. Plain host Git then takes its
        // config from the guest; the host tools name the repository themselves.
        await call("bash", { command: [
          "mkdir .evil && cp .git/config .evil/config",
          `printf '[core]\\n\\tfsmonitor = %s/trap.sh\\n' "$PWD" >> .evil/config`,
          'for n in objects refs HEAD info; do ln -s "$PWD/.git/$n" .evil/$n; done',
          `printf '#!/bin/sh\\nuname -s >> %s/trap-ran\\n' "$PWD" > trap.sh && chmod +x trap.sh`,
          'echo "$PWD/.evil" > .git/commondir',
        ].join(" && ") });
        // The guest's own Git runs it too, in the guest: only a run on macOS counts.
        const ranOnHost = () => existsSync(join(repo, "trap-ran")) && readFileSync(join(repo, "trap-ran"), "utf8").includes("Darwin");
        git("status", "--porcelain");
        assert(ranOnHost(), "the planted commondir did not redirect plain Git; the check below proves nothing");
        rmSync(join(repo, "trap-ran"));

        // Commits: the guest refuses, the host tool commits what the guest staged.
        await call("bash", { command: "git add src/hello.txt" });
        assert.match(text(await call("bash", { command: "git commit -m 'feat: tried' 2>&1; echo rc=$?" })), /created on the host[\s\S]*rc=1/);
        process.env.GIT_CONFIG_GLOBAL = "/dev/null";
        assert.match(text(await call("git_commit", { message: "feat: committed from the sandbox" })), /committed from the sandbox/);
        delete process.env.GIT_CONFIG_GLOBAL;
        assert(!ranOnHost(), "the host commit ran a program the guest named");
        rmSync(join(repo, ".git", "commondir"));
        assert.match(git("log", "-1", "--format=%s"), /committed from the sandbox/);

        // The prompt says where tools run; turning it off routes tools to the host.
        const options: { sections: Record<string, string> } = { sections: {} };
        await events.before_agent_start({ systemPromptOptions: options }, fake);
        assert.match(options.sections.sandbox, /Debian Linux arm64 container/);
        assert.doesNotMatch(options.sections.sandbox, /pi-sandbox\/output/);
        await commands.sandbox.handler("off", fake);
        assert.deepEqual(marker(), { key: "sandbox" });
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

        // A toggle is remembered for the project's next launch, where no flag is
        // given, and only while it differs from the settings.
        const toggles = togglesFile(getAgentDir());
        let global: unknown;
        try { global = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")).sandbox; } catch {}
        const byDefault = resolveSettings(global, repo).enabled;
        await commands.sandbox.handler("off", fake);
        assert.equal(savedToggle(toggles, repo), byDefault ? false : undefined);
        await events.session_shutdown({ reason: "quit" }, fake);
        for (let i = 0; i < 30 && running(name); i++) await sleep(500);
        assert(!running(name), "the container outlived its last session");
        flag = undefined;
        load();
        await events.session_start({ reason: "startup" }, fake);
        assert.match(text(await call("bash", { command: "uname -s" })), /Darwin/);
        await commands.sandbox.handler("on", fake);
        assert.equal(savedToggle(toggles, repo), byDefault ? undefined : true);
        assert.match(text(await call("bash", { command: "uname -s" })), /Linux/);

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
        forget(repo);
        rmSync(repo, { recursive: true, force: true });
      }
    },
  });
}
