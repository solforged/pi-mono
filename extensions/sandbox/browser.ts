// The sandbox's browser: terminal-browser on the host, in a Rex pane beside Pi,
// with all of its traffic tunnelled into the container (`--ssh`), so localhost
// and every other address mean what they mean to the guest. The SSH connection
// runs over `container exec`, so the guest opens no port.
//
// The browser runs on the host, so the model never reaches it directly:
// commands and flags come from an allowlist, URLs must be http(s), and files
// pass through the guest. Raw agent-browser commands could read or write any
// host path (upload, download, screenshot paths, state files), read the host
// clipboard, or fetch from the host's own network.
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./container.ts";
import { withLock } from "./sandbox.ts";

export const GUEST_SSHD = "/usr/local/libexec/pi-sandbox/browser-sshd";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/**
 * An http(s) URL, or about:blank. A bare port means the guest's localhost.
 * terminal-browser would read a bare path or its own file scheme from the host.
 */
export function normalizeUrl(raw: string): string {
  const input = raw.trim();
  if (input === "about:blank") return input;
  if (/^\d{1,5}$/.test(input)) return `http://localhost:${input}/`;
  let text = input;
  // localhost:3000/path or example.com, without a scheme.
  const bare = /^(\[[0-9a-f:.]+\]|[a-z0-9][a-z0-9.-]*)(:\d+)?([/?#].*)?$/i.exec(input);
  if (bare && !/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    const host = bare[1].toLowerCase();
    text = `${LOCAL_HOSTS.has(host) || /^[\d.]+$/.test(host) ? "http" : "https"}://${input}`;
  }
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`Not a web address: ${raw}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https pages open in the sandbox browser, not ${url.protocol} (${raw}). Serve local files from the sandbox, for example with python3 -m http.server --bind 127.0.0.1.`);
  }
  return url.toString();
}

// Commands that act on the open page. Anything that names a host file, reads
// the clipboard, fetches outside the page, or changes the browser's setup is
// left out.
const COMMANDS = new Set([
  "back", "forward", "reload", "click", "dblclick", "type", "fill", "press", "key", "keydown", "keyup",
  "keyboard", "hover", "focus", "check", "uncheck", "select", "drag", "scroll", "scrollintoview", "wait",
  "snapshot", "eval", "console", "errors", "highlight", "frame", "dialog", "is", "find", "mouse",
  "cookies", "storage", "react",
]);
const SUBCOMMANDS: Record<string, Set<string>> = {
  get: new Set(["text", "html", "value", "attr", "title", "url", "count", "box", "styles"]),
  set: new Set(["viewport", "device", "geo", "offline", "headers", "credentials", "media"]),
  network: new Set(["route", "unroute", "requests", "request"]),
  diff: new Set(["snapshot"]),
};
const FLAGS = new Set([
  "--json", "-i", "--interactive", "-c", "--compact", "-d", "--depth", "-s", "--selector",
  "--full", "--annotate", "--text", "--url", "--load", "--fn", "--timeout", "--name", "--exact",
  "--abort", "--body", "--resource-type", "--filter", "--clear", "--domain", "--path", "--secure",
  "--http-only", "--httpOnly", "--same-site", "--sameSite", "--expires", "--delta", "--button",
]);
// `wait SELECTOR --state hidden`; the global `--state` loads a host file.
const WAIT_STATES = new Set(["visible", "hidden", "attached", "detached"]);
const IMAGE_PATH = /\.(png|jpe?g|webp)$/i;

export type Command =
  | { kind: "open"; url: string }
  | { kind: "close" }
  | { kind: "screenshot"; selector?: string; save?: string; flags: string[] }
  | { kind: "action"; args: string[] };

function checkFlags(args: string[], command: string) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-") || /^-\d/.test(arg)) continue;
    const [name, inline] = arg.split(/=(.*)/s);
    if (name === "--state" && command === "wait") {
      const value = inline ?? args[++i];
      if (WAIT_STATES.has(value)) continue;
    }
    if (!FLAGS.has(name)) {
      throw new Error(`The browser tool does not pass ${name}. Allowed flags: ${[...FLAGS].join(" ")}, and --state ${[...WAIT_STATES].join("|")} after wait.`);
    }
  }
}

/** Checks one agent-browser command from the model. */
export function parseCommand(args: string[]): Command {
  if (!Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== "string")) throw new Error("Give a command as a list of strings, such as [\"snapshot\"].");
  const [command, ...rest] = args;
  if (command.startsWith("-")) throw new Error("Start with the command name, then its arguments and flags.");
  checkFlags(rest, command);
  const positional = rest.filter((arg, i) => !arg.startsWith("-") && !(i > 0 && rest[i - 1] === "--state"));
  if (command === "open" || command === "goto" || command === "navigate") {
    if (positional.length !== 1 || rest.length !== 1) throw new Error(`Usage: ${command} URL`);
    return { kind: "open", url: normalizeUrl(positional[0]) };
  }
  if (command === "close") {
    if (rest.length) throw new Error("close takes no arguments; it closes the browser pane.");
    return { kind: "close" };
  }
  if (command === "screenshot") {
    const save = positional.filter((arg) => IMAGE_PATH.test(arg) && !/^[@#.\[]/.test(arg));
    const selector = positional.filter((arg) => !save.includes(arg));
    if (save.length > 1 || selector.length > 1) throw new Error("Usage: screenshot [SELECTOR] [PATH.png] [--full] [--annotate]");
    return { kind: "screenshot", selector: selector[0], save: save[0], flags: rest.filter((arg) => arg.startsWith("-")) };
  }
  if (command === "read") {
    if (positional.length) throw new Error("read takes no URL here: it would fetch from the host. Use read alone for the open page, or open the URL first.");
    return { kind: "action", args };
  }
  if (command === "tab") {
    const [sub, value] = positional;
    if (sub === "new") return { kind: "action", args: value ? ["tab", "new", normalizeUrl(value)] : ["tab", "new"] };
    if (sub === undefined || sub === "list" || sub === "close" || /^t?\d+$/.test(sub)) return { kind: "action", args };
    throw new Error("Usage: tab [list | new [URL] | close [ID] | ID]");
  }
  const subs = SUBCOMMANDS[command];
  if (subs) {
    if (!subs.has(positional[0])) throw new Error(`Allowed after ${command}: ${[...subs].join(", ")}.`);
    return { kind: "action", args };
  }
  if (COMMANDS.has(command)) return { kind: "action", args };
  throw new Error(`The browser tool does not run ${command}. Commands: open URL, close, screenshot, read, tab, get, set, network, diff snapshot, ${[...COMMANDS].join(", ")}.`);
}

/**
 * An OpenSSH config whose only route into the guest is `container exec`. It
 * replaces the user's configuration (`-F`), never uses their agent or keys,
 * and skips host key checks: the transport is the local container.
 */
export function sshConfig(o: { host: string; container: string; key: string; publicKey: string }): string {
  const [type, body] = o.publicKey.trim().split(/\s+/);
  if (type !== "ssh-ed25519" || !/^[A-Za-z0-9+/]+=*$/.test(body ?? "")) throw new Error("Unexpected browser tunnel key");
  if (/\s/.test(o.key)) throw new Error(`The browser tunnel key path has spaces: ${o.key}`);
  // ssh expands % tokens in both; ProxyCommand also goes through a shell.
  const percent = (value: string) => value.replace(/%/g, "%%");
  const quote = (value: string) => `'${percent(value).replace(/'/g, `'\\''`)}'`;
  return [
    `Host ${o.host}`,
    "  User root",
    `  IdentityFile ${percent(o.key)}`,
    "  IdentitiesOnly yes",
    "  IdentityAgent none",
    "  ForwardAgent no",
    "  ForwardX11 no",
    "  StrictHostKeyChecking no",
    "  UserKnownHostsFile /dev/null",
    "  GlobalKnownHostsFile /dev/null",
    "  LogLevel ERROR",
    `  ProxyCommand ${quote(o.container)} exec -i ${o.host} ${GUEST_SSHD} ${type} ${body}`,
    "",
  ].join("\n");
}

const output = (stdout: Buffer, stderr: string) => `${stdout.toString("utf8")}\n${stderr}`
  // Electron prints this on every run of the CLI.
  .split("\n").filter((line) => !/node_main\.cc|Node\.js environment variables are disabled/.test(line)).join("\n").trim();

export interface BrowserOptions {
  run: Runner;
  /** Absolute paths, found on the host's PATH. */
  terminalBrowser: string;
  rex?: string;
  container: string;
  /** Host-only directory for the tunnel's key and SSH config. */
  stateRoot: string;
  env: { REX_SESSION?: string; REX_BLOCK?: string };
}

/** One browser per Pi process, kept across session switches. */
export class Browser {
  key?: string;
  pane?: string;
  container?: string;
  readonly options: BrowserOptions;
  constructor(options: BrowserOptions) { this.options = options; }

  private async tb(args: string[], signal?: AbortSignal, timeoutMs = 120_000) {
    const result = await this.options.run(this.options.terminalBrowser, args, { signal, timeoutMs, maxBytes: 8 * 1024 * 1024 });
    if (result.aborted) throw new Error("aborted");
    const text = output(result.stdout, result.stderr);
    if (result.timedOut) throw new Error(`terminal-browser timed out${text ? `: ${text}` : ""}`);
    return { ok: result.code === 0, text };
  }

  /** Writes the tunnel's key and config once per container; returns the --ssh target. */
  async tunnel(name: string): Promise<string> {
    const dir = join(this.options.stateRoot, "browser", name);
    if (/\s/.test(dir)) throw new Error(`The browser tunnel needs a state directory without spaces: ${dir}`);
    const key = join(dir, "id_ed25519"), config = join(dir, "ssh_config");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await withLock(join(dir, "lock"), async () => {
      let publicKey = await readFile(`${key}.pub`, "utf8").catch(() => "");
      if (!publicKey) {
        const fresh = join(dir, `new-${process.pid}`);
        await rm(fresh, { force: true }); await rm(`${fresh}.pub`, { force: true });
        const made = await this.options.run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "pi-sandbox-browser", "-f", fresh], { timeoutMs: 15_000 });
        if (made.code !== 0) throw new Error(`ssh-keygen failed: ${made.stderr.trim()}`);
        await rename(fresh, key);
        await rename(`${fresh}.pub`, `${key}.pub`);
        publicKey = await readFile(`${key}.pub`, "utf8");
      }
      await writeFile(config, sshConfig({ host: name, container: this.options.container, key, publicKey }), { mode: 0o600 });
    }, undefined, 30_000);
    return `-F ${config} ${name}`;
  }

  private forget() { this.key = undefined; this.pane = undefined; this.container = undefined; }

  /** Runs an allowed command against this Pi's browser. */
  async action(args: string[], signal?: AbortSignal): Promise<string> {
    if (!this.key) throw new Error("No browser is open. Start one with [\"open\", URL].");
    const { ok, text } = await this.tb(["action", "--browser", this.key, "--", ...args], signal);
    if (ok) return text;
    // The error would list the user's other browsers and their pages.
    if (/^no browser /m.test(text)) { this.forget(); throw new Error("The browser was closed. Start a new one with [\"open\", URL]."); }
    throw new Error(text || "terminal-browser action failed");
  }

  /** Navigates the open browser, or opens one beside Pi tunnelled into `name`. */
  async open(url: string, name: string, signal?: AbortSignal): Promise<string> {
    if (this.key && this.container === name) {
      // `open` would add a tab; goto navigates the active one.
      try { await this.action(["goto", url], signal); return `Opened ${url} in the browser beside Pi.`; }
      catch (error) { if (this.key) throw error; }
    } else if (this.key) {
      await this.close();
    }
    const { REX_SESSION: session, REX_BLOCK: block } = this.options.env;
    if (!session || !block) throw new Error("The browser needs Pi running in a Rex pane.");
    const target = await this.tunnel(name);
    const opened = await this.tb(["open", "--ssh", target, "--split", "right", "--no-merge", url], signal, 60_000);
    const key = opened.ok ? /\bopened (\S+)/.exec(opened.text)?.[1] : undefined;
    if (!key) throw new Error(`Could not open the browser: ${opened.text || "no output"}`);
    Object.assign(this, { key, container: name, pane: await this.paneOf(key, 10) });
    // The new pane takes focus; give it back to Pi so typing carries on there.
    if (this.options.rex) await this.options.run(this.options.rex, ["focus", "-s", session, block], { timeoutMs: 10_000 }).catch(() => {});
    return `Opened ${url} in a browser beside Pi. Its network is the sandbox's, so localhost is the guest's.`;
  }

  /** The Rex block showing a browser; a new one can take a moment to register. */
  async paneOf(key: string, tries = 1): Promise<string | undefined> {
    for (let attempt = 1; ; attempt++) {
      const listed = await this.tb(["ls", "--all", "--json"], undefined, 15_000).catch(() => undefined);
      try {
        const browser = (JSON.parse(listed?.text ?? "").browsers as any[]).find((entry) => entry.key === key);
        if (typeof browser?.pane?.pane === "string") return browser.pane.pane;
      } catch {}
      if (attempt >= tries) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  /** A PNG of the page or one element, taken through a private host directory. */
  async screenshot(selector: string | undefined, flags: string[], signal?: AbortSignal): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), "pi-sandbox-browser-"));
    try {
      const file = join(dir, "page.png");
      await this.action(["screenshot", ...(selector ? [selector] : []), file, ...flags], signal);
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Closes the browser's pane. Rex never reuses block IDs, so a pane the user
   * already closed only makes this fail.
   */
  async close(): Promise<boolean> {
    const { pane } = this;
    this.forget();
    if (!pane || !this.options.rex || !this.options.env.REX_SESSION) return false;
    const result = await this.options.run(this.options.rex, ["block", "close", "-s", this.options.env.REX_SESSION, pane], { timeoutMs: 10_000 });
    return result.code === 0;
  }
}
