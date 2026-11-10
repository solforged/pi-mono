// Syntax highlighting with the highlight.js build that ships with Pi for HTML
// export. The viewer loads it from Pi's installation when the extension passes
// its path; without it, diffs render uncolored.
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import vm from "node:vm";

export type Token = "comment" | "keyword" | "function" | "variable" | "string" | "number" | "type" | "operator" | "punctuation";
export const TOKENS: Token[] = ["comment", "keyword", "function", "variable", "string", "number", "type", "operator", "punctuation"];
export interface Piece { text: string; token?: Token }

interface Hljs {
  highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
  getLanguage(name: string): unknown;
}

export interface Highlighter {
  language(path: string): string | undefined;
  /** A code fence's language, by highlight.js name or alias or by file extension. */
  named(name: string): string | undefined;
  /** One array of pieces per input line; joined, each array equals its line. */
  highlight(lines: string[], language: string): Piece[][];
}

const EXTENSIONS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", json5: "json", md: "markdown", markdown: "markdown", mdx: "markdown",
  py: "python", pyi: "python", rs: "rust", go: "go", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", properties: "ini",
  css: "css", scss: "scss", less: "less", html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", plist: "xml",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "csharp", java: "java",
  kt: "kotlin", kts: "kotlin", swift: "swift", rb: "ruby", php: "php", lua: "lua", sql: "sql", r: "r",
  pl: "perl", pm: "perl", m: "objectivec", mm: "objectivec", graphql: "graphql", gql: "graphql",
  mk: "makefile", diff: "diff", patch: "diff",
};
const NAMES: Record<string, string> = {
  makefile: "makefile", gnumakefile: "makefile", gemfile: "ruby", rakefile: "ruby",
  ".bashrc": "bash", ".zshrc": "bash", ".profile": "bash", ".bash_profile": "bash", ".zprofile": "bash",
  ".gitconfig": "ini", ".editorconfig": "ini",
};

/** Maps highlight.js scopes, innermost first, to Pi's syntax colors. `null` resets to plain text. */
export function tokenFor(scope: string): Token | null | undefined {
  const name = scope.replace(/hljs-/g, "").trim();
  const [head] = name.split(/[ .]/);
  if (head === "subst" || head === "params" || head === "emphasis" || head === "strong" || head === "addition" || head === "deletion") return null;
  if (head === "comment" || head === "quote") return "comment";
  if (head === "title") return /class_|inherited/.test(name) ? "type" : "function";
  if (head === "variable") return /language/.test(name) ? "keyword" : "variable";
  if (head === "keyword" || head === "literal" || head === "doctag" || head === "meta" || head === "tag" || head === "name" || head === "selector-tag" || head === "bullet") return "keyword";
  if (head === "built_in" || head === "type" || head === "class") return "type";
  if (head === "string" || head === "regexp" || head === "symbol" || head === "char" || head === "link" || head === "code" || head === "template-tag") return "string";
  if (head === "number") return "number";
  if (head === "attr" || head === "attribute" || head === "property" || head === "template-variable" || head.startsWith("selector-")) return "variable";
  if (head === "section") return "function";
  if (head === "operator") return "operator";
  if (head === "punctuation") return "punctuation";
  return undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#x27": "'", "#39": "'" };
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, name: string) => ENTITIES[name]);

/** Splits highlight.js HTML into per-line pieces. */
export function piecesFromHtml(html: string): Piece[][] {
  const lines: Piece[][] = [[]];
  const stack: Array<Token | null | undefined> = [];
  const current = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i] !== undefined) return stack[i] ?? undefined;
    return undefined;
  };
  for (const match of html.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/g)) {
    if (match[1] !== undefined) { stack.push(tokenFor(match[1])); continue; }
    if (match[2] === undefined) { stack.pop(); continue; }
    const token = current();
    decode(match[2]).split("\n").forEach((text, i) => {
      if (i) lines.push([]);
      if (!text) return;
      const line = lines[lines.length - 1];
      const last = line.at(-1);
      if (last && last.token === token) last.text += text;
      else line.push(token ? { text, token } : { text });
    });
  }
  return lines;
}

const MAX_CHARS = 400_000;

export function createHighlighter(hljs: Hljs): Highlighter {
  return {
    language(path) {
      const name = basename(path).toLowerCase();
      const language = NAMES[name] ?? EXTENSIONS[extname(name).slice(1)];
      return language && hljs.getLanguage(language) ? language : undefined;
    },
    named(name) {
      const lower = name.toLowerCase();
      if (!/^[\w+#.-]+$/.test(lower)) return undefined;
      const language = EXTENSIONS[lower] ?? lower;
      return hljs.getLanguage(language) ? language : undefined;
    },
    highlight(lines, language) {
      const code = lines.join("\n");
      if (code.length > MAX_CHARS) return lines.map((text) => [{ text }]);
      const pieces = piecesFromHtml(hljs.highlight(code, { language, ignoreIllegals: true }).value);
      // Any mismatch means the markup was not what we expect: fall back to plain lines.
      return lines.map((text, i) => pieces[i]?.map((piece) => piece.text).join("") === text ? pieces[i] : [{ text }]);
    },
  };
}

/** Loads Pi's bundled highlight.js browser build in an isolated context. */
export function loadHighlighter(file: string | undefined): Highlighter | undefined {
  if (!file) return undefined;
  try {
    const context = vm.createContext({});
    vm.runInContext(readFileSync(file, "utf8"), context, { filename: file, timeout: 2_000 });
    const hljs = (context as { hljs?: Hljs }).hljs;
    return hljs && typeof hljs.highlight === "function" ? createHighlighter(hljs) : undefined;
  } catch {
    return undefined;
  }
}
