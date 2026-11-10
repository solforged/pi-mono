import { geometry, NEWLINE_GLYPH, renderFrame, type RenderedFrame, type Shape } from "./render.ts";

export const PRESERVE_KEY = "snapcompact";
export const MAX_FRAMES = 80;
export const FRAME_DATA_BYTES_BUDGET = 3_000_000;
const TOOL_RESULT_MAX = 2000;
const TOOL_ARG_MAX = 500;
const TOOL_CALL_MAX = 2000;
const HEAD_RATIO = 0.6;

export type ContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
};

export type LlmMessage = {
  role: string;
  content?: string | ContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

export type Archive = {
  frames: RenderedFrame[];
  /** Older pages kept in `text` but not rendered: they would not fit a request. */
  omittedFrames?: number;
  totalChars: number;
  truncatedChars: number;
  text?: string;
  textHead?: string;
  textTail?: string;
};

export type HistoryBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type CompactResult = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: {
    readFiles: string[];
    modifiedFiles: string[];
    [PRESERVE_KEY]: Archive;
  };
};

export function isVision(model?: { input?: string[] } | null) {
  return Array.isArray(model?.input) && model.input.includes("image");
}

export function resolveShape(model?: { id?: string; provider?: string; api?: string } | null): Shape {
  const id = `${model?.id ?? ""} ${model?.provider ?? ""} ${model?.api ?? ""}`;
  if (/claude.*(fable|mythos)|claude-?opus-?4[.-][7-9]/i.test(id)) return { cellWidth: 11, cellHeight: 16, frameSize: 1932 };
  if (/claude/i.test(id)) return { cellWidth: 11, cellHeight: 16, frameSize: 1568 };
  if (/gemini/i.test(id)) return { cellWidth: 8, cellHeight: 22, frameSize: 2048 };
  if (/kimi|glm/i.test(id)) return { cellWidth: 8, cellHeight: 16, frameSize: 1568 };
  if (/gpt|codex|grok|openai|xai/i.test(id)) return { cellWidth: 8, cellHeight: 22, frameSize: 1568 };
  return { cellWidth: 11, cellHeight: 16, frameSize: 1568 };
}

const CHAR_FOLD: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201c": '"', "\u201d": '"', "\u201e": '"',
  "\u2010": "-", "\u2011": "-", "\u2013": "-", "\u2014": "-", "\u2212": "-",
  "\u2026": "...", "\u2022": "*", "\u2190": "<-", "\u2192": "->", "\u2194": "<->",
  "\u21d2": "=>", "\u2713": "v", "\u2717": "x",
};
const EMOJI_FOLD: Record<string, string> = {
  "✅": "[OK]", "❌": "[FAIL]", "⚠": "[WARN]", "📁": "[DIR]", "📄": "[FILE]", "📝": "[NOTE]",
};
const ANSI = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const COLLAPSIBLE = /[\s\p{Cf}]+/gu;
const COMBINING = /\p{M}+/gu;
const EDGE_RUNS = /^[ \u2588]+|[ \u2588]+$/g;

function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  const head = Math.max(0, Math.floor(max * HEAD_RATIO));
  const tail = Math.max(0, max - head);
  return `${text.slice(0, head)}\n…[${text.length - max} chars truncated]…\n${text.slice(-tail)}`;
}

function textOf(content: string | ContentBlock[] | undefined) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block.type === "text" && block.text).map((block) => block.text!).join("");
}

export function serializeConversation(messages: LlmMessage[]) {
  const parts: string[] = [];
  let last = "";
  const push = (prefix: string, content: string) => {
    if (!content) return;
    if (parts.length > 0 && last === prefix) {
      const sep = parts.at(-1)!.endsWith("\n") || content.startsWith("\n") ? "" : "\n";
      parts[parts.length - 1] += sep + content;
    } else {
      parts.push(prefix + content);
      last = prefix;
    }
  };
  const results = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    const text = textOf(msg.content);
    if (text && msg.toolCallId) results.set(msg.toolCallId, text);
  }
  const merged = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "developer") {
      const content = textOf(msg.content);
      if (content) push("¶user:", content);
    } else if (msg.role === "assistant") {
      let thinking: string[] = [];
      let text: string[] = [];
      const flush = () => {
        if (thinking.length) push("¶think:", thinking.join("\n"));
        if (text.length) push("¶ai:", text.join("\n"));
        thinking = [];
        text = [];
      };
      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        if (block.type === "text" && block.text?.trim()) text.push(block.text);
        else if (block.type === "thinking" && block.thinking?.trim()) thinking.push(block.thinking);
        else if (block.type === "toolCall" && block.name) {
          flush();
          const args = Object.entries(block.arguments ?? {})
            .map(([key, value]) => `${key}=${truncate(JSON.stringify(value) ?? "undefined", TOOL_ARG_MAX)}`)
            .join(", ");
          const call = `${block.name}(${truncate(args, TOOL_CALL_MAX)})`;
          const result = block.id ? results.get(block.id) : undefined;
          if (block.id) merged.add(block.id);
          const body = result ? `\n<out>\n${truncate(result, TOOL_RESULT_MAX)}\n</out>` : "";
          push("¶call:", call + body);
        }
      }
      flush();
    } else if (msg.role === "toolResult" && msg.toolCallId && !merged.has(msg.toolCallId)) {
      const result = results.get(msg.toolCallId);
      if (result) push("¶call:", `\n<out>\n${truncate(result, TOOL_RESULT_MAX)}\n</out>`);
    }
  }
  return parts.join("\n\n");
}

export function normalize(text: string) {
  const collapsed = text.replace(ANSI, "").replace(COLLAPSIBLE, (run) => (/[\n\r\u2028\u2029]/.test(run) ? NEWLINE_GLYPH : " "));
  const out: string[] = [];
  for (const ch of collapsed) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (ch === NEWLINE_GLYPH || (cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff)) {
      out.push(cp >= 0xa0 && cp <= 0xff ? "?" : ch);
      continue;
    }
    if (EMOJI_FOLD[ch]) { out.push(EMOJI_FOLD[ch]!); continue; }
    if (CHAR_FOLD[ch]) { out.push(CHAR_FOLD[ch]!); continue; }
    if (cp >= 0x2500 && cp <= 0x257f) {
      out.push(cp === 0x2502 || cp === 0x2503 ? "|" : cp === 0x2500 || cp === 0x2501 ? "-" : "+");
      continue;
    }
    const folded = ch.normalize("NFKD").replace(COMBINING, "");
    if (folded && [...folded].every((part) => {
      const n = part.codePointAt(0) ?? 0;
      return (n >= 0x20 && n < 0x7f) || CHAR_FOLD[part];
    })) {
      out.push([...folded].map((part) => CHAR_FOLD[part] ?? part).join(""));
    } else if (!/[\p{Cc}\p{Mn}\p{Me}\p{Cs}\p{Extended_Pictographic}]/u.test(ch)) {
      out.push("?");
    }
  }
  return out.join("").replace(/ +/g, " ").replace(EDGE_RUNS, "");
}

function pages(text: string, capacity: number) {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += capacity) out.push(chars.slice(i, i + capacity).join(""));
  return out;
}

export function planArchive(text: string, shape: Shape, maxFrames = MAX_FRAMES) {
  const cap = geometry(shape).capacity;
  if (text.length <= 2 * cap) return { frames: [] as string[], textHead: text, textTail: "", keptText: text, truncatedChars: 0 };
  const textHead = text.slice(0, cap);
  const textTail = text.slice(-cap);
  const middle = text.slice(cap, text.length - cap);
  let kept = pages(middle, cap);
  let truncatedChars = 0;
  if (kept.length > maxFrames) {
    const dropped = kept.slice(0, kept.length - maxFrames);
    truncatedChars = dropped.join("").length;
    kept = kept.slice(-maxFrames);
  }
  return { frames: kept, textHead, textTail, keptText: textHead + kept.join("") + textTail, truncatedChars };
}

export function getArchive(details: unknown): Archive | undefined {
  const candidate = details && typeof details === "object" ? (details as Record<string, unknown>)[PRESERVE_KEY] : undefined;
  if (!candidate || typeof candidate !== "object") return undefined;
  const archive = candidate as Archive;
  const frames = Array.isArray(archive.frames)
    ? archive.frames.filter((frame) => frame && typeof frame.data === "string" && frame.data.length > 0)
    : [];
  const text = typeof archive.text === "string" && archive.text ? archive.text : undefined;
  const textHead = typeof archive.textHead === "string" && archive.textHead ? archive.textHead : undefined;
  const textTail = typeof archive.textTail === "string" && archive.textTail ? archive.textTail : undefined;
  if (!frames.length && !text && !textHead && !textTail) return undefined;
  return {
    frames,
    totalChars: typeof archive.totalChars === "number" ? archive.totalChars : 0,
    truncatedChars: typeof archive.truncatedChars === "number" ? archive.truncatedChars : 0,
    ...(typeof archive.omittedFrames === "number" && archive.omittedFrames > 0 ? { omittedFrames: archive.omittedFrames } : {}),
    ...(text ? { text } : {}),
    ...(textHead ? { textHead } : {}),
    ...(textTail ? { textTail } : {}),
  };
}

function toPlain(text: string) {
  return text.replaceAll(NEWLINE_GLYPH, "\n");
}

export function historyBlocks(archive: Archive, maxFrameDataBytes = FRAME_DATA_BYTES_BUDGET): HistoryBlock[] {
  const blocks: HistoryBlock[] = [];
  let used = 0;
  const kept: RenderedFrame[] = [];
  let omitted = archive.omittedFrames ?? 0;
  for (let i = archive.frames.length - 1; i >= 0; i--) {
    const frame = archive.frames[i]!;
    if (used + frame.data.length > maxFrameDataBytes) { omitted++; continue; }
    used += frame.data.length;
    kept.push(frame);
  }
  kept.reverse();
  const images = kept.map((frame) => ({ type: "image" as const, data: frame.data, mimeType: frame.mimeType }));
  if (archive.textHead) {
    const suffix = images.length ? "\n-------------- imaged middle below\n" : omitted ? "\n-------------- snapcompact image middle omitted\n" : "";
    blocks.push({ type: "text", text: toPlain(archive.textHead) + suffix });
  }
  if (omitted && images.length) blocks.push({ type: "text", text: `${omitted} older snapcompact frames omitted to fit the request budget.` });
  blocks.push(...images);
  if (archive.textTail) {
    const prefix = images.length ? "-------------- imaged middle above\n" : "\n-------------- middle history omitted above\n";
    const tail = prefix + toPlain(archive.textTail);
    const last = blocks.at(-1);
    if (last?.type === "text") last.text += tail;
    else blocks.push({ type: "text", text: tail });
  }
  return blocks;
}

function readingGuide(opts: { frames: number; cols: number; rows: number; truncatedChars: number; files: string }) {
  const imageNote = opts.frames
    ? `- Some middle sections are attached as images. Each image is a page of that same transcript. A solid black cell marks a newline. A frame is a grid ${opts.cols} characters wide and up to ${opts.rows} rows tall: read left to right, top to bottom; words may break across rows.\n`
    : "";
  const truncated = opts.truncatedChars ? `- About ${opts.truncatedChars} characters of older middle history were dropped to fit the archive budget.\n` : "";
  const files = opts.files ? `FILES\n===================\n${opts.files}\n\n` : "";
  return `You are resuming a prior conversation. Its earlier turns were archived to reclaim context and are reproduced under HISTORY below, oldest to newest. Read HISTORY in full, then continue from the live conversation that follows it.

The archived transcript uses compact scopes:
- \`¶user:\`, \`¶think:\`, \`¶ai:\`, and \`¶call:\` open user, assistant reasoning, assistant reply, and tool-call scopes.
- Following lines without a \`¶…:\` prefix remain in the current scope.
- A tool call reads \`¶call:name(args)\`. Its \`<out>…</out>\` block is tool output.

Reading HISTORY:
- Plain-text sections are the verbatim transcript — rely on them exactly.
${imageNote}${truncated}- When an exact earlier detail matters and a section reads unclearly, re-derive it from the workspace rather than guessing.

${files}HISTORY
===================`;
}

function fileList(readFiles: string[], modifiedFiles: string[]) {
  const read = new Set(readFiles);
  const modified = new Set(modifiedFiles);
  const paths = [...new Set([...readFiles, ...modifiedFiles])].slice(0, 20);
  return paths.map((path) => {
    const both = read.has(path) && modified.has(path);
    const mark = both ? "RW" : modified.has(path) ? "Write" : "Read";
    return `${path} (${mark})`;
  }).join("\n");
}

export function fileOpsLists(fileOps: unknown, previous?: unknown) {
  const from = (value: unknown, key: "readFiles" | "modifiedFiles" | "read" | "modified") => {
    if (!value || typeof value !== "object") return [];
    const raw = (value as Record<string, unknown>)[key];
    if (Array.isArray(raw)) return raw.map(String);
    if (raw instanceof Set) return [...raw].map(String);
    return [];
  };
  return {
    readFiles: [...new Set([...from(previous, "readFiles"), ...from(previous, "read"), ...from(fileOps, "readFiles"), ...from(fileOps, "read")])],
    modifiedFiles: [...new Set([...from(previous, "modifiedFiles"), ...from(previous, "modified"), ...from(fileOps, "modifiedFiles"), ...from(fileOps, "modified")])],
  };
}

export function compactText(text: string, shape: Shape, extras?: { previousText?: string; previousSummary?: string; maxFrames?: number; maxFrameDataBytes?: number }) {
  let archiveText = normalize(text);
  if (extras?.previousText) archiveText = archiveText ? `${extras.previousText}${NEWLINE_GLYPH}${archiveText}` : extras.previousText;
  else if (extras?.previousSummary) {
    const head = `[Summary of earlier history] ${normalize(extras.previousSummary)}`;
    archiveText = archiveText ? `${head} [Recent conversation] ${archiveText}` : head;
  }
  const layout = planArchive(archiveText, shape, extras?.maxFrames ?? MAX_FRAMES);
  const geo = geometry(shape);
  // Newest pages first, stopping at the request budget: older frames could
  // never be sent, and each costs render time and session-file space. Their
  // text stays in the archive for later compactions.
  const budget = extras?.maxFrameDataBytes ?? FRAME_DATA_BYTES_BUDGET;
  const frames: RenderedFrame[] = [];
  for (let i = layout.frames.length - 1, used = 0; i >= 0; i--) {
    const frame = renderFrame(layout.frames[i]!, shape);
    if (used + frame.data.length > budget) break;
    used += frame.data.length;
    frames.unshift(frame);
  }
  const omittedFrames = layout.frames.length - frames.length;
  const textChars = layout.textHead.length + layout.textTail.length;
  const totalChars = frames.reduce((sum, frame) => sum + frame.chars, 0) + textChars;
  const archive: Archive = {
    frames,
    totalChars,
    truncatedChars: layout.truncatedChars,
    ...(omittedFrames ? { omittedFrames } : {}),
    ...(layout.keptText ? { text: layout.keptText } : {}),
    ...(layout.textHead ? { textHead: layout.textHead } : {}),
    ...(layout.textTail ? { textTail: layout.textTail } : {}),
  };
  return { archive, geo, frames: frames.length };
}

export function compactMessages(
  messages: LlmMessage[],
  opts: {
    model?: { id?: string; provider?: string; api?: string } | null;
    previousSummary?: string;
    previousArchive?: Archive;
    previousDetails?: unknown;
    fileOps?: unknown;
    firstKeptEntryId: string;
    tokensBefore: number;
  },
): CompactResult {
  const shape = resolveShape(opts.model);
  const packed = compactText(serializeConversation(messages), shape, {
    previousText: opts.previousArchive?.text ?? [opts.previousArchive?.textHead, opts.previousArchive?.textTail].filter(Boolean).join(NEWLINE_GLYPH),
    previousSummary: opts.previousSummary,
  });
  const files = fileOpsLists(opts.fileOps, opts.previousDetails);
  const filesText = fileList(files.readFiles, files.modifiedFiles);
  const summary = packed.archive.frames.length === 0 && !packed.archive.textHead && !packed.archive.textTail && !filesText
    ? "No prior history."
    : readingGuide({
      frames: packed.frames,
      cols: packed.geo.cols,
      rows: packed.geo.rows,
      truncatedChars: packed.archive.truncatedChars,
      files: filesText,
    });
  return {
    summary,
    firstKeptEntryId: opts.firstKeptEntryId,
    tokensBefore: opts.tokensBefore,
    details: { ...files, [PRESERVE_KEY]: packed.archive },
  };
}

export function previousSnapcompact(entries: Array<{ type?: string; details?: unknown }>) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== "compaction") continue;
    return { archive: getArchive(entry.details), details: entry.details };
  }
  return { archive: undefined, details: undefined };
}

export function injectHistory<T extends { role: string; summary?: string; timestamp?: number }>(
  messages: T[],
  archive: Archive | undefined,
  vision: boolean,
) {
  if (!archive) return messages;
  const blocks = vision ? historyBlocks(archive) : historyBlocks({ ...archive, frames: [], omittedFrames: 0 }, 0);
  if (!blocks.length) return messages;
  return messages.map((message) => {
    if (message.role !== "compactionSummary") return message;
    return {
      role: "user",
      content: [{ type: "text", text: message.summary ?? "" }, ...blocks],
      timestamp: message.timestamp,
    } as T;
  });
}
