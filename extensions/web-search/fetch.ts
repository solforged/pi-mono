import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { htmlToText, tidy } from "./html.ts";

/** Characters of page text returned per call. */
export const PAGE_CHARS = 12_000;
const BODY_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const REDIRECTS = 5;
const CACHE_MS = 5 * 60_000, CACHE_PAGES = 8;
const CONTEXT_CHARS = 300, MATCHES = 1000;
const HEADERS = { accept: "text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1", "user-agent": "Mozilla/5.0 (compatible; pi-web-fetch)" };
const TEXTUAL = /^text\/|^application\/(?:json|xml|javascript|yaml|x-yaml|toml|x-ndjson)$|\+(?:json|xml)$/;

export type Page = { url: string; title?: string; text: string; clipped: boolean };
/** A page, or the download that will give it: `until` is Infinity while it runs, for `waiting` calls. */
type Kept = { page: Promise<Page>; until: number; waiting: number; stop: AbortController };
export type PageCache = Map<string, Kept>;
export type FetchOptions = {
  links?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  cache?: PageCache;
  allowPrivate?: boolean;
};

// Paging and find calls reread the same page, so recent ones are kept briefly.
const pages: PageCache = new Map();

// The tool runs on the host, outside the sandbox: a page must not be able to
// point it at services that only this machine or its network can reach.
const internal = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) internal.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) internal.addSubnet(net, bits, "ipv6");
export function isInternal(address: string): boolean {
  return internal.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}
const systemResolve = async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address);

function target(input: string): URL {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("url must be an absolute http(s) URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url must be an absolute http(s) URL");
  if (url.username || url.password) throw new Error("URLs that carry credentials are not fetched");
  url.hash = "";
  // GitHub's file page is an application shell; the raw host serves the file.
  const blob = url.hostname === "github.com" && /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
  return blob ? new URL(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`) : url;
}

async function body(response: Response): Promise<{ bytes: Buffer; clipped: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  while (reader && size <= BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
  }
  if (size > BODY_BYTES) await reader?.cancel().catch(() => {});
  return { bytes: Buffer.concat(chunks).subarray(0, BODY_BYTES), clipped: size > BODY_BYTES };
}

async function read(response: Response, url: URL, links: boolean): Promise<Page> {
  const header = response.headers.get("content-type") ?? "", type = header.split(";")[0]!.trim().toLowerCase();
  if (type && !TEXTUAL.test(type)) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Cannot read ${type} content`);
  }
  const { bytes, clipped } = await body(response);
  if (bytes.subarray(0, 1024).includes(0)) throw new Error("Cannot read binary content");
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(header)?.[1] ?? /<meta[^>]{0,100}charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 2048).toString("latin1"))?.[1];
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder(); }
  const source = decoder.decode(bytes);
  const html = type.includes("html") || !type && /^\s*<(?:!doctype html|html)[\s>]/i.test(source.slice(0, 500));
  const { title, text } = html ? htmlToText(source, { base: url.href, links }) : { title: undefined, text: tidy(source) };
  if (!text) throw new Error(`No readable text at ${url.href}; the page may be drawn by scripts`);
  return { url: url.href, title, text, clipped };
}

export async function loadPage(input: string, options: FetchOptions = {}): Promise<Page> {
  const url = target(input), { signal } = options;
  signal?.throwIfAborted();
  const cache = options.cache ?? pages, key = `${options.links ? "links" : "text"} ${url.href}`;
  let kept = cache.get(key);
  cache.delete(key);
  if (!kept || kept.until <= Date.now()) {
    // Kept from the start, so calls made while a page downloads share that
    // download: a model often asks for several find terms at once.
    const stop = new AbortController(), started: Kept = { page: download(url, input, options, stop.signal), until: Infinity, waiting: 0, stop };
    started.page.then(() => { started.until = Date.now() + CACHE_MS; }, () => { if (cache.get(key) === started) cache.delete(key); });
    kept = started;
  }
  const entry = kept;
  cache.set(key, entry);
  while (cache.size > CACHE_PAGES) cache.delete(cache.keys().next().value!);
  entry.waiting++;
  if (!signal) return entry.page;
  let leave!: () => void;
  const left = new Promise<never>((_, reject) => {
    leave = () => {
      // A cancelled call stops waiting; the last one to go takes the download with it.
      if (--entry.waiting === 0 && entry.until === Infinity) {
        if (cache.get(key) === entry) cache.delete(key);
        entry.stop.abort(signal.reason);
      }
      reject(signal.reason);
    };
  });
  signal.addEventListener("abort", leave, { once: true });
  try { return await Promise.race([entry.page, left]); }
  finally { signal.removeEventListener("abort", leave); }
}

async function download(first: URL, input: string, options: FetchOptions, stop: AbortSignal): Promise<Page> {
  let url = first;
  const allowPrivate = options.allowPrivate ?? process.env.PI_WEB_FETCH_PRIVATE === "1";
  const fetchImpl = options.fetchImpl ?? fetch, resolve = options.resolve ?? systemResolve;
  const timeout = AbortSignal.timeout(TIMEOUT_MS), signal = AbortSignal.any([stop, timeout]);
  const abandoned = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const load = async (): Promise<Page> => {
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted();
      if (!allowPrivate) {
        const host = url.hostname.replace(/^\[|\]$/g, ""), addresses = isIP(host) ? [host] : await resolve(host);
        if (!addresses.length || addresses.some(isInternal)) throw new Error(`${url.host} is a local or private address; PI_WEB_FETCH_PRIVATE=1 allows those`);
      }
      // Redirects are followed by hand so that each hop is checked.
      const response = await fetchImpl(url, { redirect: "manual", signal, headers: HEADERS });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) {
        if (response.ok) return read(response, url, Boolean(options.links));
        await response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status} from ${url.href}`);
      }
      await response.body?.cancel().catch(() => {});
      if (hop >= REDIRECTS) throw new Error(`Too many redirects from ${input}`);
      url = target(new URL(location, url).href);
    }
  };
  try { return await Promise.race([load(), abandoned]); }
  catch (error) {
    if (timeout.aborted && !stop.aborted) throw new Error(`${url.host} did not answer within ${TIMEOUT_MS / 1000} s`);
    throw error;
  }
}

/** One part of a page: from `offset`, or only the passages that contain `find`. */
export function pageView(page: Page, options: { offset?: number; find?: string } = {}): string {
  const { text } = page, total = text.length, offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= total) throw new Error(`offset must be between 0 and ${total - 1}`);
  const find = options.find?.trim();
  if (find) return passages(text, find, offset);
  let end = Math.min(total, offset + PAGE_CHARS);
  if (end < total) {
    const line = text.lastIndexOf("\n", end);
    if (line > offset + PAGE_CHARS / 2) end = line;
  }
  // A page that opens with its own heading needs no title line.
  const title = offset === 0 && page.title && !text.startsWith("#") && !text.slice(0, 300).includes(page.title) ? `${page.title}\n\n` : "";
  const more = end < total ? `\n\n[chars ${offset}-${end} of ${total}; offset=${end} continues, find=<term> returns matching passages]`
    : page.clipped ? `\n\n[page cut off at ${BODY_BYTES / 1024 / 1024} MiB]` : "";
  return `${title}${text.slice(offset, end)}${more}`.toWellFormed();
}

function passages(text: string, find: string, offset: number): string {
  if (find.length > 200) throw new Error("find must be at most 200 characters");
  const windows: Array<{ from: number; to: number }> = [];
  let count = 0;
  for (const match of text.matchAll(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"))) {
    if (match.index < offset) continue;
    if (++count > MATCHES) break;
    const stop = match.index + match[0].length;
    let from = Math.max(offset, match.index - CONTEXT_CHARS), to = Math.min(text.length, stop + CONTEXT_CHARS);
    // Whole lines where a line break is in reach; otherwise the cut is marked.
    // Only the window is searched, so a page that is one long line stays cheap.
    const first = from > 0 ? text.slice(from - 1, match.index).indexOf("\n") : -1, last = to < text.length ? text.slice(stop, to + 1).lastIndexOf("\n") : -1;
    if (first >= 0) from += first;
    while (text[from] === "\n") from++;
    if (last >= 0) to = stop + last;
    const previous = windows.at(-1);
    if (previous && from <= previous.to) previous.to = Math.max(previous.to, to); else windows.push({ from, to });
  }
  const quoted = JSON.stringify(find);
  if (!windows.length) return `No ${quoted} ${offset ? `from offset ${offset}` : "on this page"} (${text.length} chars).`;
  const parts: string[] = [];
  let used = 0, next: number | undefined;
  for (const window of windows) {
    const { from } = window, room = PAGE_CHARS - used;
    if (window.to - from > room && parts.length) { next = from; break; }
    // Matches close together merge into one passage, which may itself be a page long.
    let to = window.to;
    if (to - from > room) {
      const line = text.lastIndexOf("\n", from + room);
      to = next = line > from + room / 2 ? line + 1 : from + room;
    }
    const cutStart = from > 0 && text[from - 1] !== "\n", cutEnd = to < text.length && text[to] !== "\n" && text[to - 1] !== "\n";
    parts.push(`[@${from}] ${cutStart ? "…" : ""}${text.slice(from, to).trimEnd()}${cutEnd ? "…" : ""}`);
    used += to - from;
    if (next !== undefined) break;
  }
  const head = `${count > MATCHES ? `${MATCHES}+` : count} match${count === 1 ? "" : "es"} for ${quoted}; offset=<@n> reads on from a passage.`;
  const more = next === undefined ? "" : `\n\n[more matches; offset=${next} with the same find continues]`;
  return `${head}\n\n${parts.join("\n\n")}${more}`.toWellFormed();
}
