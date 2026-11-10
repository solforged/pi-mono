import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Browser, GUEST_SSHD, normalizeUrl, parseCommand, sshConfig } from "../extensions/sandbox/browser.ts";
import type { RunOptions, RunResult } from "../extensions/sandbox/container.ts";
import { temporary } from "./helpers.ts";

test("web addresses become http(s) URLs; local files and other schemes are refused", () => {
  assert.equal(normalizeUrl("3000"), "http://localhost:3000/");
  assert.equal(normalizeUrl("localhost:5173/app?x=1"), "http://localhost:5173/app?x=1");
  assert.equal(normalizeUrl("127.0.0.1:8000"), "http://127.0.0.1:8000/");
  assert.equal(normalizeUrl("[::1]:8080"), "http://[::1]:8080/");
  assert.equal(normalizeUrl("example.com/docs"), "https://example.com/docs");
  assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
  for (const bad of [
    "file:///etc/passwd", "/Users/me/.ssh/id_ed25519", "./plan.html", "~/notes.md", "javascript:alert(1)",
    "data:text/html,hi", "view-source:https://example.com", "terminal-browser-file://file/etc/hosts", "chrome://version", "",
  ]) assert.throws(() => normalizeUrl(bad), /Only http|Not a web address/, bad);
});

test("page commands pass; host files, the clipboard, host fetches and setup flags are refused", () => {
  assert.deepEqual(parseCommand(["open", "localhost:3000"]), { kind: "open", url: "http://localhost:3000/" });
  assert.deepEqual(parseCommand(["goto", "https://example.com"]), { kind: "open", url: "https://example.com/" });
  assert.deepEqual(parseCommand(["close"]), { kind: "close" });
  for (const args of [
    ["snapshot", "-i", "-c"], ["snapshot", "-s", "#main", "--depth", "3"], ["click", "@e3"], ["fill", "@e2", "hello"],
    ["press", "Enter"], ["eval", "document.title"], ["get", "text", "h1"], ["set", "viewport", "390", "844"],
    ["wait", "--text", "Saved"], ["wait", "#spinner", "--state", "hidden"], ["wait", "#x", "--state=detached"],
    ["scroll", "down", "-200"], ["network", "route", "**/api", "--body", "{}"], ["cookies", "set", "a", "b", "--url", "http://localhost"],
    ["read"], ["tab"], ["tab", "list"], ["tab", "2"], ["tab", "close", "t3"], ["diff", "snapshot"], ["console", "--clear"],
  ]) assert.deepEqual(parseCommand(args), { kind: "action", args }, args.join(" "));
  assert.deepEqual(parseCommand(["tab", "new", "localhost:3000"]), { kind: "action", args: ["tab", "new", "http://localhost:3000/"] });

  const refused: Array<[string[], RegExp]> = [
    [["upload", "#f", "/Users/me/.ssh/id_ed25519"], /does not run upload/],
    [["download", "@e1", "/tmp/x"], /does not run download/],
    [["pdf", "/tmp/x.pdf"], /does not run pdf/],
    [["clipboard", "read"], /does not run clipboard/],
    [["state", "load", "/tmp/s.json"], /does not run state/],
    [["record", "start", "/tmp/a.webm"], /does not run record/],
    [["batch", "upload x y"], /does not run batch/],
    [["chat", "hello"], /does not run chat/],
    [["auth", "show", "github"], /does not run auth/],
    [["connect", "9222"], /does not run connect/],
    [["read", "http://localhost:631"], /fetch from the host/],
    [["open", "file:///etc/passwd"], /Only http/],
    [["tab", "new", "file:///etc/passwd"], /Only http/],
    [["click", "@e3", "--new-tab"], /does not pass --new-tab/],
    [["wait", "--download", "/tmp/x"], /does not pass --download/],
    [["wait", "#x", "--state", "/tmp/state.json"], /does not pass --state/],
    [["snapshot", "--state", "hidden"], /does not pass --state/],
    [["snapshot", "--init-script=/tmp/x.js"], /does not pass --init-script/],
    [["eval", "1", "--allow-file-access"], /does not pass --allow-file-access/],
    [["get", "cdp-url"], /Allowed after get/],
    [["network", "har", "stop", "/tmp/x.har"], /Allowed after network/],
    [["diff", "screenshot", "--baseline", "/tmp/a.png"], /does not pass --baseline/],
    [["--json", "snapshot"], /Start with the command/],
    [["open", "localhost:3000", "--headed"], /does not pass --headed/],
    [[], /list of strings/],
  ];
  for (const [args, message] of refused) assert.throws(() => parseCommand(args), message, args.join(" "));
});

test("screenshots split a selector from a path to save in the sandbox", () => {
  assert.deepEqual(parseCommand(["screenshot"]), { kind: "screenshot", selector: undefined, save: undefined, flags: [] });
  assert.deepEqual(parseCommand(["screenshot", "@e4", "out/card.png", "--full"]), { kind: "screenshot", selector: "@e4", save: "out/card.png", flags: ["--full"] });
  assert.deepEqual(parseCommand(["screenshot", ".hero.png"]), { kind: "screenshot", selector: ".hero.png", save: undefined, flags: [] });
  assert.throws(() => parseCommand(["screenshot", "a.png", "b.png"]), /Usage: screenshot/);
  assert.throws(() => parseCommand(["screenshot", "--screenshot-dir", "/tmp"]), /does not pass --screenshot-dir/);
});

test("the tunnel's SSH config reaches the guest only through container exec", () => {
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMFcxGTIJbnOxwIqmGJHgx7LAqR/YF3YljwyAylhT0/T pi-sandbox-browser\n";
  const config = sshConfig({ host: "pi-sbx-app-0123456789", container: "/Applications/My Tools/100%/container", key: "/state/browser/pi-sbx-app-0123456789/id_ed25519", publicKey: key });
  assert.match(config, /^Host pi-sbx-app-0123456789\n/);
  assert.match(config, /\n  ProxyCommand '\/Applications\/My Tools\/100%%\/container' exec -i pi-sbx-app-0123456789 \/usr\/local\/libexec\/pi-sandbox\/browser-sshd ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMFcxGTIJbnOxwIqmGJHgx7LAqR\/YF3YljwyAylhT0\/T\n/);
  for (const line of ["IdentitiesOnly yes", "IdentityAgent none", "ForwardAgent no", "UserKnownHostsFile /dev/null"]) assert.match(config, new RegExp(`\\n  ${line}\\n`));
  assert(config.includes(GUEST_SSHD));
  assert.throws(() => sshConfig({ host: "h", container: "c", key: "/k", publicKey: "ssh-rsa AAAA" }), /Unexpected/);
  assert.throws(() => sshConfig({ host: "h", container: "c", key: "/k", publicKey: "ssh-ed25519 AAAA;rm -rf /" }), /Unexpected/);
  assert.throws(() => sshConfig({ host: "h", container: "c", key: "/a b/k", publicKey: key }), /spaces/);
});

const ok = (stdout = "", stderr = ""): RunResult => ({ code: 0, stdout: Buffer.from(stdout), stderr, aborted: false, timedOut: false, truncated: false });
const failed = (stderr: string): RunResult => ({ ...ok("", stderr), code: 1 });

function fakeHost(dir: string) {
  const calls: string[][] = [];
  const browsers = new Map<string, string>();
  let next = 41;
  const run = async (command: string, args: string[], _options?: RunOptions): Promise<RunResult> => {
    calls.push([command, ...args]);
    if (command === "ssh-keygen") {
      const file = args[args.indexOf("-f") + 1];
      await writeFile(file, "PRIVATE");
      await writeFile(`${file}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKey pi-sandbox-browser\n");
      return ok();
    }
    if (command === "/bin/rex") {
      if (args[0] === "block") browsers.forEach((pane, key) => { if (pane === args[4]) browsers.delete(key); });
      return ok();
    }
    const [sub] = args;
    if (sub === "open") {
      const key = `${next++}-1`;
      browsers.set(key, `block:${key}`);
      return ok(`opened ${key} (terminal-browser ls for details)\n`, "[1109/213408.419854:ERROR:electron/shell/app/node_main.cc:154] Node.js environment variables are disabled\n");
    }
    if (sub === "ls") return ok(JSON.stringify({ browsers: [...browsers].map(([key, pane]) => ({ key, pane: { tab: "window:1", pane } })).concat([{ key: "9-1", pane: { tab: "window:2", pane: "block:user" } }]) }));
    if (sub === "action") {
      const key = args[2], command = args.slice(4);
      if (!browsers.has(key)) return failed(`no browser ${key}\n\nrunning:\n  9-1 https://mail.example.com/inbox`);
      if (command[0] === "screenshot") { await writeFile(command.find((arg) => arg.endsWith(".png"))!, "PNG"); return ok("✓ Screenshot saved"); }
      return ok(`ran ${command.join(" ")}`);
    }
    return failed(`unexpected ${command} ${args.join(" ")}`);
  };
  const browser = new Browser({ run, terminalBrowser: "/bin/tb", rex: "/bin/rex", container: "/bin/container", stateRoot: dir, env: { REX_SESSION: "session:1", REX_BLOCK: "block:pi" } });
  return { browser, calls, browsers };
}

test("opening starts one tunnelled browser beside Pi, then navigates it", async (t) => {
  const dir = await temporary(t);
  const { browser, calls } = fakeHost(dir);
  const name = "pi-sbx-app-0123456789";
  assert.match(await browser.open("http://localhost:3000/", name), /beside Pi/);
  const config = join(dir, "browser", name, "ssh_config");
  assert.deepEqual(calls.find((call) => call[1] === "open"), ["/bin/tb", "open", "--ssh", `-F ${config} ${name}`, "--split", "right", "--no-merge", "http://localhost:3000/"]);
  assert.match(await readFile(config, "utf8"), /ProxyCommand '\/bin\/container' exec -i pi-sbx-app-0123456789 .* ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKey\n/);
  assert.equal((await stat(join(dir, "browser", name))).mode & 0o777, 0o700);
  assert.equal(browser.key, "41-1");
  assert.equal(browser.pane, "block:41-1");
  assert.deepEqual(calls.find((call) => call[0] === "/bin/rex"), ["/bin/rex", "focus", "-s", "session:1", "block:pi"]);

  calls.length = 0;
  await browser.open("http://localhost:3000/next", name);
  assert.deepEqual(calls, [["/bin/tb", "action", "--browser", "41-1", "--", "goto", "http://localhost:3000/next"]]);
  assert.equal(await browser.action(["snapshot", "-i"]), "ran snapshot -i");

  // A second open in the same worktree reuses the key.
  calls.length = 0;
  await browser.close();
  await browser.open("http://localhost:3000/", name);
  assert(!calls.some((call) => call[0] === "ssh-keygen"));
});

test("a browser the user closed is forgotten without showing their other browsers", async (t) => {
  const { browser, browsers } = fakeHost(await temporary(t));
  await browser.open("http://localhost:3000/", "pi-sbx-a-1");
  browsers.clear();
  await assert.rejects(browser.action(["snapshot"]), (error: Error) => /was closed/.test(error.message) && !/mail\.example/.test(error.message));
  assert.equal(browser.key, undefined);
  await assert.rejects(browser.action(["snapshot"]), /No browser is open/);
  // Opening again starts a new pane.
  await browser.open("http://localhost:3000/", "pi-sbx-a-1");
  assert.equal(browser.key, "42-1");
});

test("another worktree's browser closes before one opens for this one", async (t) => {
  const { browser, calls } = fakeHost(await temporary(t));
  await browser.open("http://localhost:3000/", "pi-sbx-a-1");
  await browser.open("http://localhost:3000/", "pi-sbx-b-2");
  assert(calls.some((call) => call.join(" ") === "/bin/rex block close -s session:1 block:41-1"));
  assert.equal(browser.container, "pi-sbx-b-2");
});

test("screenshots go through a private host file that is removed afterwards", async (t) => {
  const { browser, calls } = fakeHost(await temporary(t));
  await browser.open("http://localhost:3000/", "pi-sbx-a-1");
  assert.equal((await browser.screenshot("@e2", ["--full"])).toString(), "PNG");
  const shot = calls.find((call) => call[5] === "screenshot")!;
  assert.deepEqual([shot[6], shot[8]], ["@e2", "--full"]);
  await assert.rejects(stat(shot[7]), /ENOENT/);
});
