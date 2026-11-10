// pi-open:// links: how Pi's transcript and the document pane point at a
// Markdown file for a particular Pi process. The URL names the Pi by process ID,
// so the handler app hands a ⌘-click to the Pi whose pane showed the link.
// No Pi imports: the document viewer uses this too.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEME = "pi-open";
const MARKDOWN = /\.(md|markdown|mdx)$/i;

export const isMarkdown = (path: string) => MARKDOWN.test(path);

/** Percent-encodes everything a Markdown link target or a shell could trip on. */
const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function docUrl(pid: number, path: string, anchor?: string): string {
  return `${SCHEME}://${pid}/${encode(path)}${anchor ? `#${encode(anchor)}` : ""}`;
}

export interface DocRequest { pid: number; path: string; anchor?: string }

/** Reads a pi-open:// URL; undefined unless it names a process and an absolute Markdown path. */
export function parseDocUrl(url: string): DocRequest | undefined {
  const match = new RegExp(`^${SCHEME}://(\\d+)/([^#]*)(?:#(.*))?$`).exec(url.trim());
  if (!match) return undefined;
  try {
    const path = decodeURIComponent(match[2]);
    const anchor = match[3] ? decodeURIComponent(match[3]) : undefined;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !isAbsolute(path) || !isMarkdown(path) || path.includes("\0")) return undefined;
    return { pid, path, ...(anchor ? { anchor } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * A link target or a path as written in a message, resolved against `cwd`:
 * relative, absolute, `~/` or `file://`, with an optional `#anchor`. Only
 * Markdown files qualify; whether the file exists is for the caller to check.
 */
export function resolveTarget(target: string, cwd: string): { path: string; anchor?: string } | undefined {
  let text = target.trim().replace(/^<(.*)>$/, "$1");
  if (!text || /^[a-z][\w+.-]*:/i.test(text) && !text.startsWith("file:")) return undefined;
  const hash = text.indexOf("#");
  const anchor = hash >= 0 ? text.slice(hash + 1) : undefined;
  text = hash >= 0 ? text.slice(0, hash) : text;
  let path: string;
  try {
    if (text.startsWith("file:")) path = fileURLToPath(text);
    else {
      try { path = decodeURIComponent(text); } catch { path = text; }
      if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
      path = isAbsolute(path) ? path : resolve(cwd, path);
    }
  } catch {
    return undefined;
  }
  if (!isMarkdown(path)) return undefined;
  return { path, ...(anchor ? { anchor } : {}) };
}

const TTL_MS = 5_000;
const known = new Map<string, { file: boolean; at: number }>();

/** Whether `path` is a file, remembered briefly: the transformer runs on every render. */
export function isFile(path: string, now = Date.now()): boolean {
  const hit = known.get(path);
  if (hit && now - hit.at < TTL_MS) return hit.file;
  let file = false;
  try { file = statSync(path).isFile(); } catch {}
  if (known.size > 1_000) known.clear();
  known.set(path, { file, at: now });
  return file;
}

// Code fences, which are left alone; then on other lines, in order: URLs (left
// alone), Markdown links and images, inline code, and bare paths.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE = new RegExp([
  /(?<url>\b[a-z][\w+.-]*:\/\/[^\s<>()]+)/.source,
  /(?<link>!?\[(?<label>(?:[^\[\]\\]|\\.)*)\]\((?<target><[^>\n]*>|[^\s()]+)(?<title>\s+"[^"\n]*")?\))/.source,
  /(?<code>(?<ticks>`+)(?<inner>[^`\n]+?)\k<ticks>(?!`))/.source,
  /(?<bare>(?<![\w/.~%@-])(?:~\/|\.{1,2}\/|\/)?[\w@+-][\w.@~+-]*(?:\/[\w.@~+-]+)*\.(?:md|markdown|mdx)(?:#[\w-]+)?(?![\w/]))/.source,
].join("|"), "gi");

/**
 * Turns references to existing Markdown files into links that `url` makes:
 * the targets of Markdown links, inline code that is just a path, and bare
 * paths in text. Code blocks, URLs, and anything that does not resolve to a
 * file stay as they are.
 */
export function linkDocs(markdown: string, cwd: string, url: (path: string, anchor?: string) => string, exists = isFile): string {
  if (!/\.(md|markdown|mdx)\b/i.test(markdown)) return markdown;
  const find = (target: string) => {
    const resolved = resolveTarget(target, cwd);
    return resolved && exists(resolved.path) ? url(resolved.path, resolved.anchor) : undefined;
  };
  let fence: string | undefined;
  return markdown.split("\n").map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = undefined;
      return line;
    }
    if (marker) { fence = marker; return line; }
    return line.replace(INLINE, (match, ...args) => {
      const groups = args.at(-1) as Record<string, string | undefined>;
      if (groups.url) return match;
      if (groups.link !== undefined) {
        if (match.startsWith("!")) return match;
        const target = find(groups.target!);
        return target ? `[${groups.label}](${target}${groups.title ?? ""})` : match;
      }
      if (groups.code !== undefined) {
        const target = find(groups.inner!.trim());
        return target ? `[${match}](${target})` : match;
      }
      const target = find(match);
      return target ? `[${match}](${target})` : match;
    });
  }).join("\n");
}
