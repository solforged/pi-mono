import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { sharedTarget, shareCargoTarget } from "../extensions/sandbox/cargo.ts";
import { ContainerCli, EXEC_ID, runProcess, STOP_SCRIPT, type RunOptions, type RunResult } from "../extensions/sandbox/container.ts";
import { commandEnv, fdArgs, GREP_SCRIPT, GrepCollector, guestError, parseListing, rgArgs, sniffImage } from "../extensions/sandbox/guest.ts";
import { repath, shareOutput } from "../extensions/sandbox/output.ts";
import { buildPlan, containerName, promptNote, runArgs, type Probe } from "../extensions/sandbox/plan.ts";
import { contextOf, gitContext } from "../extensions/sandbox/probe.ts";
import { imageTag, Sandbox, syncStage, withLock } from "../extensions/sandbox/sandbox.ts";
import { chooseEnabled, DEFAULTS, inheritedSwitch, resolveSettings } from "../extensions/sandbox/settings.ts";
import { savedToggle, saveToggle, togglesFile } from "../extensions/sandbox/toggles.ts";
import { temporary } from "./helpers.ts";

const home = "/Users/me";
function probe(files: Record<string, "file" | "dir"> = {}, patch: Partial<Probe> = {}): Probe {
  return {
    root: "/Users/me/src/app", home, cacheRoot: "/Users/me/.cache/pi-sandbox", commonDir: "/Users/me/src/app/.git",
    wikiDir: "/Users/me/.local/share/wiki", contextDirs: ["/Users/me/.agents/skills"], identity: { name: "Me", email: "me@example.com" },
    kind: (path) => files[path], ...patch,
  };
}

test("settings come from defaults, then globals, then the closest project entry", () => {
  assert.deepEqual(resolveSettings(undefined, "/x", home), DEFAULTS);
  assert.equal(DEFAULTS.enabled, false);
  const raw = {
    enabled: true, cpus: 4, mounts: ["~/src/shared"],
    projects: { "~/src": { memory: "4G" }, "~/src/app": { enabled: false, mounts: [{ path: "/opt/data", readonly: false }] } },
  };
  const app = resolveSettings(raw, "/Users/me/src/app", home);
  assert.equal(app.enabled, false);
  assert.equal(app.cpus, 4);
  assert.equal(app.memory, "4G");
  assert.deepEqual(app.mounts, [{ path: "/Users/me/src/shared", readonly: true }, { path: "/opt/data", readonly: false }]);
  assert.equal(resolveSettings(raw, "/Users/me/other", home).enabled, true);
  assert.throws(() => resolveSettings({ wiki: "yes" }, "/x", home), /wiki/);
  assert.throws(() => resolveSettings({ mounts: ["relative/path"] }, "/x", home), /absolute/);
  assert.throws(() => resolveSettings({ enable: true }, "/x", home), /Unknown setting sandbox.enable/);
});

test("the flag beats the inherited environment, then the saved toggle, then settings", () => {
  assert.deepEqual(chooseEnabled("off", "on", true, { enabled: true }), { enabled: false, source: "flag" });
  assert.deepEqual(chooseEnabled(undefined, "off", true, { enabled: true }), { enabled: false, source: "environment" });
  assert.deepEqual(chooseEnabled(undefined, undefined, false, { enabled: true }), { enabled: false, source: "saved" });
  assert.deepEqual(chooseEnabled(undefined, undefined, undefined, { enabled: false }), { enabled: false, source: "settings" });
  assert.throws(() => chooseEnabled("maybe", undefined, undefined, { enabled: true }), /--sandbox/);
});

test("a session moved from a checkout with the sandbox on keeps it on", () => {
  // enter_worktree is a model-callable move; the worktree's settings must not turn the sandbox off.
  assert.deepEqual(chooseEnabled(undefined, undefined, undefined, { enabled: false }, true), { enabled: true, source: "session" });
  assert.deepEqual(chooseEnabled(undefined, undefined, undefined, { enabled: true }, true), { enabled: true, source: "settings" });
  // The user's own choices for the new checkout still win.
  assert.deepEqual(chooseEnabled(undefined, undefined, false, { enabled: false }, true), { enabled: false, source: "saved" });
  assert.deepEqual(chooseEnabled("off", undefined, undefined, { enabled: false }, true), { enabled: false, source: "flag" });
});

test("a process ignores the PI_SANDBOX it set itself, but children honor it", () => {
  assert.equal(inheritedSwitch({ PI_SANDBOX: "off", PI_SANDBOX_FROM: "42" }, 42), undefined);
  assert.equal(inheritedSwitch({ PI_SANDBOX: "off", PI_SANDBOX_FROM: "42" }, 43), "off");
  assert.equal(inheritedSwitch({ PI_SANDBOX: "on" }, 43), "on");
});

test("toggles are saved per project only while they differ from settings", async (t) => {
  const file = togglesFile(await temporary(t));
  assert.equal(savedToggle(file, "/a"), undefined);
  saveToggle(file, "/a", false, true);
  saveToggle(file, "/b", true, false);
  assert.equal(savedToggle(file, "/a"), false);
  assert.equal(savedToggle(file, "/b"), true);
  saveToggle(file, "/a", true, true);
  assert.equal(savedToggle(file, "/a"), undefined);
  assert.equal(savedToggle(file, "/b"), true);
  writeFileSync(file, "not json");
  assert.equal(savedToggle(file, "/b"), undefined);
});

test("a worktree mounts its Git metadata and guards config, hooks, and its .git pointer", () => {
  const worktree = "/Users/me/.pi/wt/app--task";
  const plan = buildPlan(probe({
    [`${worktree}/.git`]: "file", "/Users/me/src/app/.git/config": "file", "/Users/me/src/app/.git/hooks": "dir",
    [`${worktree}/Cargo.toml`]: "file", [`${worktree}/.pi`]: "dir",
  }, { root: worktree, wikiDir: undefined }), DEFAULTS, "img");
  const mounts = plan.mounts.map((m) => [m.target, m.readonly]);
  assert.deepEqual(mounts.slice(0, 3), [[worktree, false], ["/Users/me/src/app/.git", false], ["/Users/me/.agents/skills", true]]);
  assert(plan.mounts.some((m) => m.target === `${worktree}/target` && m.source.startsWith("/Users/me/.cache/pi-sandbox/worktrees/")));
  assert.deepEqual(plan.readOnlyPaths.sort(), [`${worktree}/.git`, `${worktree}/.pi`, "/Users/me/src/app/.git/config", "/Users/me/src/app/.git/hooks"].sort());
  assert.equal(plan.env.MISE_TRUSTED_CONFIG_PATHS, worktree);
  assert.equal(plan.env.GIT_AUTHOR_EMAIL, "me@example.com");
  assert.equal(plan.env.LLM_WIKI_DIR, undefined);
});

test("a Git directory with guarded files is a mount of its own, so the guest cannot rename it away", () => {
  // A read-only path protects only itself: `mv .git old && mkdir .git` would leave the guards behind.
  const git = "/Users/me/src/app/.git", wiki = "/Users/me/.local/share/wiki";
  const plan = buildPlan(probe({ [git]: "dir", [`${git}/config`]: "file", [`${wiki}/.git`]: "dir" }), DEFAULTS, "img");
  const own = plan.mounts.filter((m) => m.label === "Git directory");
  assert.deepEqual(own, [git, `${wiki}/.git`].map((dir) => ({ source: dir, target: dir, readonly: false, label: "Git directory" })));
  assert(plan.mounts.findIndex((m) => m.target === git) > plan.mounts.findIndex((m) => m.target === "/Users/me/src/app"), "a nested mount follows the one around it");
  assert(runArgs(plan).includes(`type=bind,source=${git},target=${git}`));
  assert.deepEqual(plan.readOnlyPaths.filter((path) => path.startsWith(git)).sort(), [`${git}/config`, `${git}/hooks`]);
  assert.doesNotMatch(promptNote(plan), /Git directory/);
  // A linked worktree's shared Git directory is mounted already, and a read-only wiki needs no guards.
  const worktree = "/Users/me/.pi/wt/app--task";
  const linked = buildPlan(probe({ [`${worktree}/.git`]: "file" }, { root: worktree, wikiDir: undefined }), DEFAULTS, "img");
  assert.deepEqual(linked.mounts.filter((m) => m.target === git).map((m) => m.label), ["Git metadata"]);
  const ro = buildPlan(probe({ [git]: "dir", [`${wiki}/.git`]: "dir" }), { ...DEFAULTS, wiki: "ro" }, "img");
  assert.deepEqual(ro.mounts.filter((m) => m.label === "Git directory").map((m) => m.target), [git]);
});

test("a repository that reads config.worktree gets one the guest cannot write", () => {
  const git = "/Users/me/src/app/.git";
  const off = buildPlan(probe({ [git]: "dir" }, { wikiDir: undefined }), DEFAULTS, "img");
  assert.deepEqual(off.hostFiles, []);
  const on = buildPlan(probe({ [git]: "dir" }, { wikiDir: undefined, worktreeConfig: true }), DEFAULTS, "img");
  assert.deepEqual(on.hostFiles, [`${git}/config.worktree`]);
  assert(on.readOnlyPaths.includes(`${git}/config.worktree`));
  const existing = buildPlan(probe({ [git]: "dir", [`${git}/config.worktree`]: "file" }, { wikiDir: undefined, worktreeConfig: true }), DEFAULTS, "img");
  assert.deepEqual(existing.hostFiles, []);
  assert(existing.readOnlyPaths.includes(`${git}/config.worktree`));
});

test("missing hooks are created on the host so the guest cannot add them", () => {
  const plan = buildPlan(probe({ "/Users/me/src/app/.git": "dir" }, { wikiDir: undefined }), DEFAULTS, "img");
  assert(plan.hostDirs.includes("/Users/me/src/app/.git/hooks"));
  assert(plan.readOnlyPaths.includes("/Users/me/src/app/.git/hooks"));
  assert(!plan.readOnlyPaths.includes("/Users/me/src/app/.git/config"));
});

test("a missing project .pi is created on the host and guarded; other mounts keep only what exists", () => {
  const wiki = "/Users/me/.local/share/wiki";
  const plan = buildPlan(probe({ "/Users/me/src/app/.git": "dir", [`${wiki}/.git`]: "dir" }), DEFAULTS, "img");
  assert(plan.hostDirs.includes("/Users/me/src/app/.pi"));
  assert(plan.readOnlyPaths.includes("/Users/me/src/app/.pi"));
  assert(!plan.hostDirs.includes(`${wiki}/.pi`) && !plan.readOnlyPaths.includes(`${wiki}/.pi`));
  // A file named .pi cannot hold project resources, and cannot be replaced by a directory.
  const file = buildPlan(probe({ "/Users/me/src/app/.pi": "file" }, { wikiDir: undefined }), DEFAULTS, "img");
  assert(!file.hostDirs.includes("/Users/me/src/app/.pi") && !file.readOnlyPaths.includes("/Users/me/src/app/.pi"));
});

test("files that point Git at another config are guarded wherever they exist", () => {
  const common = "/Users/me/src/app/.git", worktree = "/Users/me/.pi/wt/app--task";
  const plan = buildPlan(probe({
    [`${worktree}/.git`]: "file", [`${common}/config`]: "file", [`${common}/hooks`]: "dir",
    [`${common}/worktrees/app--task/commondir`]: "file", [`${common}/worktrees/app--task/config.worktree`]: "file",
    [`${common}/worktrees/other/commondir`]: "file",
  }, { root: worktree, wikiDir: undefined, worktreeGitDirs: [`${common}/worktrees/app--task`, `${common}/worktrees/other`] }), DEFAULTS, "img");
  for (const path of ["worktrees/app--task/commondir", "worktrees/app--task/config.worktree", "worktrees/other/commondir"]) assert(plan.readOnlyPaths.includes(`${common}/${path}`), path);
  // Linked worktrees take their hooks from the common directory, so none are created here.
  assert(!plan.hostDirs.some((dir) => dir.includes("/worktrees/app--task/")));
  // Nothing can be guarded where the file is absent, as in a main checkout.
  assert(!plan.readOnlyPaths.includes(`${common}/commondir`));
});

test("the wiki mounts at its path with a Linux binary over bin/ and guarded Git", () => {
  const wiki = "/Users/me/.local/share/wiki";
  const plan = buildPlan(probe({ [`${wiki}/cmd/wiki`]: "dir", [`${wiki}/.git`]: "dir", [`${wiki}/.git/config`]: "file" }), DEFAULTS, "img");
  assert(plan.mounts.some((m) => m.target === wiki && !m.readonly));
  assert(plan.mounts.some((m) => m.target === `${wiki}/bin` && m.source === "/Users/me/.cache/pi-sandbox/wiki-bin"));
  assert(plan.readOnlyPaths.includes(`${wiki}/.git/config`));
  assert.equal(plan.env.LLM_WIKI_DIR, wiki);
  assert(plan.wikiBuild);
  const off = buildPlan(probe(), { ...DEFAULTS, wiki: "off" }, "img");
  assert(!off.mounts.some((m) => m.target === wiki));
  const ro = buildPlan(probe(), { ...DEFAULTS, wiki: "ro" }, "img");
  assert(ro.mounts.some((m) => m.target === wiki && m.readonly));
});

test("broad or missing mounts are refused", () => {
  assert.throws(() => buildPlan(probe({}, { root: home }), DEFAULTS, "img"), /home directory/);
  assert.throws(() => buildPlan(probe({}, { root: "/" }), DEFAULTS, "img"), /home directory/);
  assert.throws(() => buildPlan(probe(), { ...DEFAULTS, mounts: [{ path: "/Users", readonly: true }] }, "img"), /home directory/);
  assert.throws(() => buildPlan(probe(), { ...DEFAULTS, mounts: [{ path: "/opt/none", readonly: true }] }, "img"), /does not exist/);
  const shared = buildPlan(probe({ "/opt/shared": "dir" }), { ...DEFAULTS, mounts: [{ path: "/opt/shared", readonly: true }] }, "img");
  assert(shared.mounts.some((m) => m.target === "/opt/shared" && m.readonly));
});

test("run arguments carry mounts, guards, labels, and environment but no host secrets", () => {
  const plan = buildPlan(probe({ "/Users/me/src/app/.git/config": "file" }), DEFAULTS, "pi-sandbox:abc");
  const args = runArgs(plan);
  assert.deepEqual(args.slice(0, 6), ["run", "--detach", "--rm", "--init", "--name", containerName(plan.root)]);
  assert(args.includes("type=bind,source=/Users/me/.agents/skills,target=/Users/me/.agents/skills,readonly"));
  assert(args.includes("/Users/me/src/app/.git/config"));
  assert(args.includes(`pi.sandbox.config=${plan.labels["pi.sandbox.config"]}`));
  assert.deepEqual(args.slice(-3), ["pi-sandbox:abc", "sleep", "infinity"]);
  assert(!args.some((arg) => /API_KEY|TOKEN/.test(arg)));
  assert.match(promptNote(plan), /git_commit/);
  // Long bash output is kept where the guest can read it, at the host's path, and not listed in the prompt.
  assert.equal(plan.outputDir, `/Users/me/.cache/pi-sandbox/output/${plan.name}`);
  assert(args.includes(`type=bind,source=${plan.outputDir},target=${plan.outputDir},readonly`));
  assert(plan.hostDirs.includes(plan.outputDir));
  assert.doesNotMatch(promptNote(plan), /output/);
  assert.notEqual(buildPlan(probe(), { ...DEFAULTS, cpus: 2 }, "pi-sandbox:abc").labels["pi.sandbox.config"], plan.labels["pi.sandbox.config"]);
});

test("container names are stable, short, and distinct per root", () => {
  assert.equal(containerName("/a/My App!"), containerName("/a/My App!"));
  assert.match(containerName("/a/My App!"), /^pi-sbx-my-app-[0-9a-f]{10}$/);
  assert.notEqual(containerName("/a/app"), containerName("/b/app"));
});

test("listings, grep events, and fd arguments match Pi's tools", () => {
  const listing = parseListing(Buffer.from("D\0dsrc\0fREADME.md\0lbroken\0"));
  assert.equal(listing.kind, "dir");
  assert.deepEqual([...listing.entries], [["src", true], ["README.md", false], ["broken", false]]);
  assert.equal(parseListing(Buffer.from("M\0")).kind, "missing");

  assert.deepEqual(rgArgs({ pattern: "x", ignoreCase: true, literal: true, glob: "*.ts", context: 2 }),
    ["--no-config", "--json", "--line-number", "--color=never", "--hidden", "--ignore-case", "--fixed-strings", "--glob", "*.ts", "--context", "2", "--", "x"]);
  assert.deepEqual(rgArgs({ pattern: "x", glob: "!./src/*.ts" }).slice(5, 7), ["--glob", "!src/*.ts"]);
  const event = (type: string, line: number, text: string, path = "/r/src/a.ts") => JSON.stringify({ type, data: { path: { text: path }, line_number: line, lines: { text: `${text}\n` } } });
  const collector = new GrepCollector(2);
  for (const raw of [JSON.stringify({ type: "begin" }), event("match", 1, "one"), event("context", 2, "ctx"), event("match", 3, "two"), event("context", 4, "after")]) assert(collector.push(raw));
  assert.equal(collector.push(event("match", 9, "three")), false);
  assert(collector.limitReached);
  const { output } = collector.format("/r", true, (text) => ({ text, wasTruncated: false }));
  assert.deepEqual(output, ["src/a.ts:1: one", "src/a.ts-2- ctx", "src/a.ts:3: two", "src/a.ts-4- after"]);
  assert.deepEqual(collector.format("/r/src/a.ts", false, (text) => ({ text, wasTruncated: false })).output[0], "a.ts:1: one");
  // A directory is searched as ".", so ripgrep reports paths from there.
  const relative = new GrepCollector(5);
  relative.push(event("match", 1, "one", "./src/a.ts"));
  assert.deepEqual(relative.format("/r", true, (text) => ({ text, wasTruncated: false })).output, ["src/a.ts:1: one"]);

  assert.deepEqual(fdArgs("src/*.ts", "/r", 50, ["**/node_modules/**", "**/.git/**"]),
    ["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", "50", "--exclude", "node_modules", "--exclude", ".git", "--full-path", "--", "**/src/*.ts", "/r"]);
});

test("a grep glob with a slash matches from the searched directory", async (t) => {
  try { execFileSync("rg", ["--version"], { stdio: "ignore" }); } catch { t.skip("ripgrep is not installed"); return; }
  const dir = await temporary(t);
  await mkdir(join(dir, "src", "deep"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "needle\n");
  await writeFile(join(dir, "src", "deep", "b.ts"), "needle\n");
  await writeFile(join(dir, "c.ts"), "needle\n");
  // The script the guest runs, here on the host and from another directory.
  const run = (path: string, glob?: string) => {
    const out = execFileSync("sh", ["-c", GREP_SCRIPT, "sh", path, ...rgArgs({ pattern: "needle", glob })], { encoding: "utf8", cwd: "/" });
    const [kind, ...events] = out.trim().split("\n");
    const collector = new GrepCollector(100);
    for (const raw of events) collector.push(raw);
    return { kind, files: collector.format(path, kind === "D", (text) => ({ text, wasTruncated: false })).output.map((line) => line.split(":")[0]).sort() };
  };
  assert.deepEqual(run(dir, "src/*.ts"), { kind: "D", files: ["src/a.ts"] });
  assert.deepEqual(run(dir, "./src/**/*.ts").files, ["src/a.ts", "src/deep/b.ts"]);
  assert.deepEqual(run(dir).files, ["c.ts", "src/a.ts", "src/deep/b.ts"]);
  assert.deepEqual(run(join(dir, "c.ts")), { kind: "F", files: ["c.ts"] });
  assert.equal(run(join(dir, "absent")).kind, "M");
});

test("guest errors and environment stay narrow", () => {
  assert.equal(guestError("cat: /x: No such file or directory", "/x", "open").code, "ENOENT");
  assert.match(guestError("sh: can't create /x: Read-only file system", "/x", "open").message, /read-only in the sandbox/);
  assert.deepEqual(commandEnv({ PI_SESSION_ID: "s", ANTHROPIC_API_KEY: "k", PATH: "/bin", PI_SESSION_FILE: "/f" }), { PI_SESSION_ID: "s" });
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffImage(Buffer.from("text")), null);
});

test("long bash output moves to the folder the guest can read", async (t) => {
  const dir = await temporary(t);
  const log = join(dir, "tmp", "pi-bash-0123456789abcdef.log");
  await mkdir(join(dir, "tmp"));
  await writeFile(log, "all of it\n");
  const moved = await shareOutput(log, join(dir, "output"));
  assert.equal(moved, join(dir, "output", "pi-bash-0123456789abcdef.log"));
  assert.equal(await readFile(moved, "utf8"), "all of it\n");
  assert(!existsSync(log));
  // The result, and an error thrown for a failed or cancelled command, name the new path.
  const result = { content: [{ type: "text", text: `tail\n[Showing lines 5-9 of 9. Full output: ${log}]` }], details: { fullOutputPath: log, truncation: { truncated: true, totalLines: 9 } }, structuredContent: { full_output_path: log, exit_code: 0 } };
  assert.deepEqual(repath(result, log, moved), { content: [{ type: "text", text: `tail\n[Showing lines 5-9 of 9. Full output: ${moved}]` }], details: { fullOutputPath: moved, truncation: { truncated: true, totalLines: 9 } }, structuredContent: { full_output_path: moved, exit_code: 0 } });
  const error = new Error(`[Showing lines 5-9 of 9. Full output: ${log}]\nCommand aborted`);
  assert.equal(repath(error, log, moved), error);
  assert.equal(error.message, `[Showing lines 5-9 of 9. Full output: ${moved}]\nCommand aborted`);
});

test("image tags follow the image directory contents", async (t) => {
  const dir = await temporary(t);
  await writeFile(join(dir, "Containerfile"), "FROM a");
  const first = await imageTag(dir);
  assert.match(first, /^pi-sandbox:[0-9a-f]{12}$/);
  await writeFile(join(dir, "Containerfile"), "FROM b");
  assert.notEqual(await imageTag(dir), first);
});

test("locks wait for live holders and break dead ones", async (t) => {
  const dir = join(await temporary(t), "lock");
  await mkdir(dir);
  await writeFile(join(dir, "pid"), "999999");
  assert.equal(await withLock(dir, async () => "taken", (pid) => pid !== 999999), "taken");
  await mkdir(dir);
  await writeFile(join(dir, "pid"), "424242");
  await assert.rejects(withLock(dir, async () => "never", () => true, 300), /Timed out/);
});

// A plan whose host directories live under a temporary directory.
const livePlan = (dir: string) => buildPlan(probe({}, {
  root: join(dir, "app"), home: "/nonexistent", commonDir: undefined, wikiDir: undefined, contextDirs: [], cacheRoot: join(dir, "cache"),
}), DEFAULTS, "img");

// A fake `container` CLI that tracks one running container per name.
function fakeCli() {
  const running = new Map<string, Record<string, string>>();
  const calls: string[][] = [];
  const ok = (stdout = "", code = 0, stderr = ""): RunResult => ({ code, stdout: Buffer.from(stdout), stderr, aborted: false, timedOut: false, truncated: false });
  const cli = new ContainerCli(async (_bin, args) => {
    calls.push(args);
    const [cmd] = args;
    if (cmd === "system") return ok();
    if (cmd === "image") return ok("", 0);
    if (cmd === "inspect") {
      const labels = running.get(args[1]);
      return labels ? ok(JSON.stringify([{ status: "running", configuration: { labels } }])) : ok("", 1);
    }
    if (cmd === "list") return ok(JSON.stringify([...running].map(([id, labels]) => ({ status: "running", configuration: { id, labels } }))));
    if (cmd === "run") {
      const name = args[args.indexOf("--name") + 1];
      const labels = Object.fromEntries(args.flatMap((arg, i) => args[i - 1] === "--label" ? [arg.split(/=(.*)/s).slice(0, 2)] : []));
      running.set(name, labels);
      return ok(name);
    }
    if (cmd === "delete") { running.delete(args.at(-1)!); return ok(); }
    if (cmd === "exec") {
      const name = args.find((arg) => arg.startsWith("pi-sbx-"))!;
      if (!running.has(name)) return ok("", 1, `Error: get failed: container ${name} not found`);
      return execs.shift()?.(name) ?? ok("out");
    }
    return ok();
  });
  cli.removeDetached = (name) => { running.delete(name); };
  // Queued outcomes for the next exec calls against a running container.
  const execs: Array<(name: string) => RunResult> = [];
  return { cli, running, calls, execs, ok };
}

test("a cancelled exec is stopped inside the guest, not by signalling the client", async () => {
  // container 1.5.0 does not pass signals on, and a killed client leaves its guest process running.
  const calls: Array<{ args: string[]; options?: RunOptions }> = [];
  const cli = new ContainerCli(async (_bin, args, options) => {
    calls.push({ args, options });
    return { code: 0, stdout: Buffer.alloc(0), stderr: "", aborted: false, timedOut: false, truncated: false };
  });
  await cli.exec("pi-sbx-app-0000000000", ["sleep", "600"], { env: { PI_MODEL: "m" } });
  const [{ args, options }] = calls;
  const tag = args.find((arg) => arg.startsWith(`${EXEC_ID}=`))!;
  assert.match(tag, /=[0-9a-f]{16}$/);
  assert(args.includes("PI_MODEL=m"));
  options!.onStop!();
  assert.deepEqual(calls[1].args, ["exec", "pi-sbx-app-0000000000", "sh", "-c", STOP_SCRIPT, "sh", tag.split("=")[1]]);
  // Each exec has its own ID, so stopping one leaves the others.
  await cli.exec("pi-sbx-app-0000000000", ["true"]);
  assert.notEqual(calls[2].args.find((arg) => arg.startsWith(`${EXEC_ID}=`)), tag);

  // The process is left to end by itself once the caller has stopped the work.
  const abort = new AbortController();
  let stops = 0;
  const started = Date.now();
  const running = runProcess("sh", ["-c", "trap 'kill $!; exit 143' USR1; sleep 31 >/dev/null 2>&1 & wait"], {
    signal: abort.signal,
    onStop: () => { stops++; execFileSync("pkill", ["-USR1", "-f", "exit 143' USR1; sleep 31"]); },
  });
  setTimeout(() => { abort.abort(); abort.abort(); }, 200);
  const result = await running;
  assert.deepEqual([result.aborted, result.code, stops], [true, 143, 1]);
  assert(Date.now() - started < 3000, "waited for the kill timer");
});

test("processes in one worktree share a container; the last one out removes it", async (t) => {
  const stateRoot = await temporary(t);
  const { cli, running, calls } = fakeCli();
  const plan = livePlan(stateRoot);
  const alive = new Set([1, 2]);
  const options = { cli, stateRoot, alive: (pid: number) => alive.has(pid) };
  const one = new Sandbox(plan, { ...options, pid: 1 });
  const two = new Sandbox(plan, { ...options, pid: 2 });
  plan.hostFiles.push(join(stateRoot, "app", "config.worktree"));
  await mkdir(join(stateRoot, "app"));
  await one.ensure();
  await two.ensure();
  assert.equal(await readFile(plan.hostFiles[0], "utf8"), "", "files to guard are created before the container starts");
  assert.equal(calls.filter(([cmd]) => cmd === "run").length, 1);
  assert.deepEqual((await readdir(join(stateRoot, "containers", plan.name, "leases"))).sort(), ["1", "2"]);
  await one.release();
  assert(running.has(plan.name));
  await two.release();
  assert(!running.has(plan.name));
});

test("a stale container from a dead session is replaced, and orphans are swept", async (t) => {
  const stateRoot = await temporary(t);
  const { cli, running, calls } = fakeCli();
  const plan = livePlan(stateRoot);
  running.set(plan.name, { ...plan.labels, "pi.sandbox.config": "old" });
  running.set("pi-sbx-orphan-0000000000", { "pi.sandbox": "1" });
  running.set("unrelated", {});
  const box = new Sandbox(plan, { cli, stateRoot, pid: 7, alive: (pid) => pid === 7 });
  await box.ensure();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(running.get(plan.name)?.["pi.sandbox.config"], plan.labels["pi.sandbox.config"]);
  assert(calls.some((args) => args[0] === "delete" && args.at(-1) === plan.name));
  assert(!running.has("pi-sbx-orphan-0000000000"));
  assert(running.has("unrelated"));
});

test("an exec against a vanished container starts it once more", async (t) => {
  const stateRoot = await temporary(t);
  const { cli, running } = fakeCli();
  const plan = livePlan(stateRoot);
  const box = new Sandbox(plan, { cli, stateRoot, pid: 3, alive: () => true });
  await box.ensure();
  running.delete(plan.name);
  const result = await box.exec(["true"]);
  assert.equal(result.code, 0);
  assert(running.has(plan.name));
});

test("a failing command is not mistaken for a missing container, and a killed one is not repeated", async (t) => {
  const stateRoot = await temporary(t);
  const { cli, running, calls, execs, ok } = fakeCli();
  const plan = livePlan(stateRoot);
  const box = new Sandbox(plan, { cli, stateRoot, pid: 4, alive: () => true });
  await box.ensure();
  const count = (cmd: string) => calls.filter((args) => args[0] === cmd).length;
  const inspects = count("inspect");
  // An ordinary failure, even one that talks about things not found, costs no inspect.
  execs.push(() => ok("", 1, "grep: needle: not found"), () => ok("", 2));
  assert.equal((await box.exec(["grep", "needle"], { onData: () => {} })).code, 1);
  assert.equal((await box.exec(["false"])).code, 2);
  assert.equal(count("inspect"), inspects);
  // Killed while the container still runs (an out-of-memory kill, say): its own failure.
  execs.push(() => ok("", 137));
  assert.equal((await box.exec(["big"])).stderr, "");
  // Killed because the container went away: restarted, reported, and not run again.
  const streamed: string[] = [];
  execs.push((name) => { running.delete(name); return ok("", 137); });
  const execsBefore = count("exec");
  const killed = await box.exec(["sh", "-c", "deploy"], { onData: (chunk) => { streamed.push(chunk.toString()); } });
  assert.equal(killed.code, 137);
  assert.match(killed.stderr, /container stopped while this command was running/);
  assert.match(streamed.join(""), /Repeat the command if that is safe/);
  assert.equal(count("exec"), execsBefore + 1);
  assert(running.has(plan.name));
});

test("what a container leaves on the host goes once its project is gone", async (t) => {
  const dir = await temporary(t);
  const { cli } = fakeCli();
  const plan = livePlan(dir);
  const cache = join(dir, "cache");
  const make = async (name: string, root?: string) => {
    for (const path of [join(dir, "containers", name, "leases"), join(dir, "browser", name), join(cache, "worktrees", name, "target"), join(cache, "output", name)]) await mkdir(path, { recursive: true });
    if (root) await writeFile(join(dir, "containers", name, "root"), root);
  };
  const live = join(dir, "live-project");
  await mkdir(live);
  await make("pi-sbx-gone-0000000001", join(dir, "deleted-project"));
  await make("pi-sbx-live-0000000002", live);
  await make("pi-sbx-recent-0000000003");
  await make("pi-sbx-old-0000000004");
  const longAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  for (const path of [join(dir, "containers"), join(dir, "browser"), join(cache, "worktrees"), join(cache, "output")]) await utimes(join(path, "pi-sbx-old-0000000004"), longAgo, longAgo);
  // A session still holds the gone project's neighbour; and a name this code did not make is left alone.
  await make("pi-sbx-held-0000000005", join(dir, "deleted-project"));
  await writeFile(join(dir, "containers", "pi-sbx-held-0000000005", "leases", "77"), "");
  await mkdir(join(cache, "worktrees", "notes"));
  await mkdir(plan.outputDir, { recursive: true });
  await writeFile(join(plan.outputDir, "pi-bash-old.log"), "old");
  await writeFile(join(plan.outputDir, "pi-bash-new.log"), "new");
  await utimes(join(plan.outputDir, "pi-bash-old.log"), longAgo, longAgo);

  const box = new Sandbox(plan, { cli, stateRoot: dir, cacheRoot: cache, pid: 8, alive: (pid) => pid === 8 || pid === 77 });
  await box.ensure();
  for (let i = 0; i < 100 && existsSync(join(cache, "worktrees", "pi-sbx-old-0000000004")); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const left = async (path: string) => (await readdir(path)).filter((name) => name !== plan.name).sort();
  const kept = ["pi-sbx-held-0000000005", "pi-sbx-live-0000000002", "pi-sbx-recent-0000000003"];
  assert.deepEqual(await left(join(dir, "containers")), kept);
  assert.deepEqual(await left(join(dir, "browser")), kept);
  assert.deepEqual(await left(join(cache, "worktrees")), ["notes", ...kept]);
  assert.deepEqual(await left(join(cache, "output")), kept);
  assert.equal(await readFile(join(dir, "containers", plan.name, "root"), "utf8"), plan.root);
  assert.deepEqual(await readdir(plan.outputDir), ["pi-bash-new.log"]);
});

test("start failures are kept so tools fail closed", async (t) => {
  const stateRoot = await temporary(t);
  const cli = new ContainerCli(async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: "XPC connection error", aborted: false, timedOut: false, truncated: false }));
  const plan = livePlan(stateRoot);
  const box = new Sandbox(plan, { cli, stateRoot });
  await assert.rejects(box.ensure(), /container system start/);
  await assert.rejects(box.exec(["true"]), /container system start/);
  assert.equal(box.phase, "error");
});

test("releasing during a start waits for it, then removes the container", async (t) => {
  const stateRoot = await temporary(t);
  const { cli, running } = fakeCli();
  const run = cli.run;
  (cli as any).run = async (bin: string, args: string[], options: any) => {
    if (args[0] === "run") await new Promise((resolve) => setTimeout(resolve, 50));
    return run(bin, args, options);
  };
  const plan = livePlan(stateRoot);
  const box = new Sandbox(plan, { cli, stateRoot, pid: 5, alive: () => true });
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const before = timers();
  box.ensure().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  await box.release();
  assert(!running.has(plan.name));
  // A leftover timer would keep a print-mode process alive after its last tool call.
  assert.equal(timers(), before);
});

test("a sandbox kept across a session switch fits only the same plan while healthy", async (t) => {
  const stateRoot = await temporary(t);
  const { cli } = fakeCli();
  const plan = livePlan(stateRoot);
  const box = new Sandbox(plan, { cli, stateRoot, pid: 6, alive: () => true });
  await box.ensure();
  assert(box.fits(livePlan(stateRoot)));
  assert(!box.fits(buildPlan(probe({}, { root: join(stateRoot, "app"), home: "/nonexistent", commonDir: undefined, wikiDir: undefined, contextDirs: [], cacheRoot: join(stateRoot, "cache") }), { ...DEFAULTS, memory: "16G" }, "img")));
  assert(!box.fits(livePlan(join(stateRoot, "other"))));
  box.phase = "error";
  assert(!box.fits(plan));
});

test("host bash in a linked Rust worktree builds into the main checkout's target/", async (t) => {
  const dir = await temporary(t), main = join(dir, "main"), lane = join(dir, "lane");
  const git = async (...args: string[]) => assert.equal((await runProcess("git", ["-C", main, ...args], { timeoutMs: 10000 })).code, 0);
  await mkdir(main);
  await git("init", "-q");
  // Only this disposable repository bypasses host hooks, including post-checkout.
  await git("config", "core.hooksPath", await temporary(t));
  await writeFile(join(main, "Cargo.toml"), "[workspace]\n");
  await git("add", "Cargo.toml");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-qm", "test: created fixture");
  await git("worktree", "add", "-q", lane);
  await mkdir(join(lane, "src"));
  assert.equal(sharedTarget(join(lane, "src")), join(main, "target"));
  // The main checkout keeps its default; a lane without Cargo.toml or outside Git gets nothing.
  assert.equal(sharedTarget(main), undefined);
  assert.equal(sharedTarget(dir), undefined);
  await git("worktree", "add", "-q", "--detach", join(dir, "plain"));
  await rm(join(dir, "plain", "Cargo.toml"));
  assert.equal(sharedTarget(join(dir, "plain")), undefined);
  // A submodule-style .git file has no commondir.
  await mkdir(join(dir, "sub", "modules"), { recursive: true });
  await writeFile(join(dir, "sub", ".git"), "gitdir: modules\n");
  await writeFile(join(dir, "sub", "Cargo.toml"), "");
  assert.equal(sharedTarget(join(dir, "sub")), undefined);

  const spawn = { command: "cargo build", cwd: lane, env: { PATH: "/bin" } };
  assert.deepEqual(shareCargoTarget(spawn).env, { PATH: "/bin", CARGO_TARGET_DIR: join(main, "target") });
  const own = { ...spawn, env: { CARGO_TARGET_DIR: "/tmp/isolated" } };
  assert.equal(shareCargoTarget(own), own);
  assert.equal(shareCargoTarget({ ...spawn, cwd: main }).env, spawn.env);
});

test("a context folder with links is planned entry by entry", () => {
  const skills = "/Users/me/.agents/skills";
  const plan = buildPlan(probe({}, { contextDirs: ["/opt/pi"], contextViews: [{ target: skills, entries: [
    { name: "plain", source: `${skills}/plain`, kind: "dir" },
    { name: "linked", source: "/nix/store/abc-skill", kind: "dir" },
    { name: "notes.md", source: "/nix/store/def-notes.md", kind: "file" },
    // A link to a folder that holds the home directory would show all of it.
    { name: "wide", source: "/Users", kind: "dir" },
  ] }] }), DEFAULTS, "img");
  const [stage] = plan.stages;
  assert.match(stage.dir, /^\/Users\/me\/\.cache\/pi-sandbox\/context\/skills-[0-9a-f]+$/);
  assert.deepEqual([stage.dirs, stage.files], [["plain", "linked"], [{ name: "notes.md", from: "/nix/store/def-notes.md" }]]);
  // The staging folder first: the others are mounted on folders inside it.
  assert.deepEqual(plan.mounts.filter((m) => m.label === "context").map((m) => [m.source, m.target, m.readonly]), [
    ["/opt/pi", "/opt/pi", true], [stage.dir, skills, true], [`${skills}/plain`, `${skills}/plain`, true], ["/nix/store/abc-skill", `${skills}/linked`, true],
  ]);
  assert.doesNotMatch(promptNote(plan), /\.agents|nix/);
  assert.deepEqual(buildPlan(probe(), DEFAULTS, "img").stages, []);
});

test("links in context folders are resolved on the host, and the Git folder never shows credentials", async (t) => {
  const dir = await temporary(t);
  const skills = join(dir, "skills"), store = join(dir, "store"), git = join(dir, "git");
  await mkdir(join(skills, "plain"), { recursive: true });
  await mkdir(join(store, "skill"), { recursive: true });
  assert.deepEqual(contextOf(skills), { dir: skills }, "a folder without links is mounted as it is");
  assert.deepEqual(contextOf(join(dir, "missing")), {});
  await symlink(join(store, "skill"), join(skills, "linked"));
  await symlink(join(dir, "missing"), join(skills, "dangling"));
  await writeFile(join(store, "notes.md"), "notes\n");
  await symlink(join(store, "notes.md"), join(skills, "notes.md"));
  assert.deepEqual(contextOf(skills), { view: { target: skills, entries: [
    { name: "linked", source: join(store, "skill"), kind: "dir" },
    { name: "notes.md", source: join(store, "notes.md"), kind: "file" },
    { name: "plain", source: join(skills, "plain"), kind: "dir" },
  ] } });
  // A folder that is itself a link keeps the path Pi names it by.
  await symlink(skills, join(dir, "alias"));
  assert.equal(contextOf(join(dir, "alias")).view?.target, join(dir, "alias"));

  await mkdir(join(git, "hooks"), { recursive: true });
  for (const name of ["credentials", "credentials.lock", "config"]) await writeFile(join(git, name), "x\n");
  await symlink(join(store, "notes.md"), join(git, "ignore"));
  assert.deepEqual(gitContext(git), { target: git, entries: [
    { name: "config", source: join(git, "config"), kind: "file" }, { name: "ignore", source: join(store, "notes.md"), kind: "file" },
  ] });
  assert.equal(gitContext(join(dir, "missing")), undefined);
});

test("a staging folder holds copies of the files and a mount point for each folder, and nothing else", async (t) => {
  const dir = await temporary(t);
  const stage = join(dir, "stage"), from = join(dir, "ignore");
  await writeFile(from, "one\n");
  await chmod(from, 0o444); // As files in a Nix store are.
  await mkdir(join(stage, "old-skill", "left"), { recursive: true });
  await writeFile(join(stage, "old.md"), "stale\n");
  await mkdir(join(stage, "ignore")); // Was a folder last time.
  await syncStage({ dir: stage, files: [{ name: "ignore", from }, { name: "gone", from: join(dir, "missing") }], dirs: ["skill"] });
  assert.deepEqual((await readdir(stage)).sort(), ["ignore", "skill"]);
  assert.equal(await readFile(join(stage, "ignore"), "utf8"), "one\n");
  await chmod(from, 0o644);
  await writeFile(from, "two\n");
  await syncStage({ dir: stage, files: [{ name: "ignore", from }], dirs: ["skill"] });
  assert.equal(await readFile(join(stage, "ignore"), "utf8"), "two\n");
});
