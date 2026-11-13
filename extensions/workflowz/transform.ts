// Turns one kernel cell into an async function body whose top-level
// declarations outlive the cell and whose last expression is its value.
// A small tokenizer is enough: only depth-0 statements are rewritten, and the
// caller falls back to the untransformed body if the result does not compile.

export interface Token { type: "name" | "punct" | "string" | "template" | "regex" | "number"; value: string; start: number; end: number; nl: boolean }

const PUNCT = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const ID_START = /[\p{ID_Start}$_\\#]/u, ID_PART = /[\p{ID_Continue}$\u200c\u200d\\]/u;

function regexAllowed(prev: Token | undefined) {
  if (!prev) return true;
  if (prev.type === "name") return REGEX_AFTER.has(prev.value);
  if (prev.type === "punct") return ![")", "]", "}", "++", "--"].includes(prev.value);
  return false;
}

/** Tokens of `code` from `from`, stopping after an unmatched `}` when `untilBrace` is set. */
export function tokenize(code: string, from = 0, untilBrace = false): { tokens: Token[]; end: number } {
  const tokens: Token[] = [];
  let i = from, nl = false, depth = 0;
  const push = (type: Token["type"], start: number, end: number) => { tokens.push({ type, value: code.slice(start, end), start, end, nl }); nl = false; i = end; };
  while (i < code.length) {
    const c = code[i]!, next = code[i + 1];
    if (c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029") { nl = true; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && next === "/") { while (i < code.length && code[i] !== "\n") i++; continue; }
    if (c === "/" && next === "*") {
      const close = code.indexOf("*/", i + 2), stop = close < 0 ? code.length : close + 2;
      if (code.slice(i, stop).includes("\n")) nl = true;
      i = stop; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      push("string", i, Math.min(j + 1, code.length)); continue;
    }
    if (c === "`") { push("template", i, skipTemplate(code, i + 1)); continue; }
    if (c === "/" && regexAllowed(tokens.at(-1))) {
      let j = i + 1, inClass = false;
      while (j < code.length && code[j] !== "\n") {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === "[") inClass = true;
        else if (code[j] === "]") inClass = false;
        else if (code[j] === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < code.length && /[a-z]/i.test(code[j]!)) j++;
      push("regex", i, Math.min(j, code.length)); continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(next ?? ""))) {
      let j = i + 1;
      while (j < code.length && (/[0-9a-zA-Z_.]/.test(code[j]!) || (/[eE]/.test(code[j - 1]!) && /[+-]/.test(code[j]!) && !/^0[xX]/.test(code.slice(i, j))))) j++;
      push("number", i, j); continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < code.length && ID_PART.test(code[j]!)) j++;
      push("name", i, j); continue;
    }
    const op = PUNCT.find((p) => code.startsWith(p, i) && !(p === "?." && /[0-9]/.test(code[i + 2] ?? ""))) ?? c;
    if (op === "{") depth++;
    if (op === "}") {
      if (untilBrace && depth === 0) return { tokens, end: i + 1 };
      depth--;
    }
    push("punct", i, i + op.length);
  }
  return { tokens, end: code.length };
}

function skipTemplate(code: string, i: number): number {
  while (i < code.length) {
    if (code[i] === "\\") { i += 2; continue; }
    if (code[i] === "`") return i + 1;
    if (code[i] === "$" && code[i + 1] === "{") { i = tokenize(code, i + 2, true).end; continue; }
    i++;
  }
  return code.length;
}

// After these, a line break never ends the statement.
const OPEN_ENDED = new Set(["=", ",", "(", "[", "{", ".", "?.", "=>", ":", "?", "!", "~", "...", "+", "-", "*", "/", "%", "**",
  "<", ">", "<=", ">=", "==", "!=", "===", "!==", "&&", "||", "??", "&", "|", "^", "<<", ">>", ">>>",
  "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="]);
const OPEN_ENDED_WORDS = new Set(["new", "typeof", "void", "delete", "await", "in", "instanceof", "of", "extends", "else", "do", "case", "yield"]);
// A line starting with these continues the previous one, as in JavaScript itself.
const CONTINUES = new Set([".", "?.", "(", "[", ",", "=", "=>", ":", "?", "+", "-", "*", "/", "%", "**",
  "<", ">", "<=", ">=", "==", "!=", "===", "!==", "&&", "||", "??", "&", "|", "^", "<<", ">>", ">>>",
  "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="]);

function continues(prev: Token, next: Token) {
  if (prev.type === "punct" && OPEN_ENDED.has(prev.value)) return true;
  if (prev.type === "name" && OPEN_ENDED_WORDS.has(prev.value)) return true;
  if (next.type === "template") return true;
  if (next.type === "punct" && CONTINUES.has(next.value)) return true;
  if (next.type === "name" && ["in", "instanceof", "of"].includes(next.value)) return true;
  return false;
}

const BLOCK_STARTERS = new Set(["if", "for", "while", "switch", "try", "function", "async", "class", "with"]);
const BLOCK_AFTER = new Set(["else", "try", "finally"]);

/** Depth-0 statements as token index ranges [start, end). */
export function statements(tokens: Token[]): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  let depth = 0, start = 0, block = false;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (depth === 0 && k > start && t.nl && !continues(tokens[k - 1]!, t)) { result.push([start, k]); start = k; }
    if (t.type === "punct") {
      if (["(", "[", "{"].includes(t.value)) {
        if (depth === 0 && t.value === "{") {
          // A statement block, not an object literal or arrow body.
          const first = tokens[start]!, prev = tokens[k - 1];
          block = k === start || (BLOCK_STARTERS.has(first.value) && (prev?.value === ")" || BLOCK_AFTER.has(prev?.value ?? "") || first.value === "class"));
        }
        depth++;
      } else if ([")", "]", "}"].includes(t.value)) {
        depth = Math.max(0, depth - 1);
        // `try {} catch {} [a]`: a closed block ends the statement unless it continues.
        const next = tokens[k + 1];
        if (depth === 0 && t.value === "}" && block && next && !(next.type === "name" && ["else", "catch", "finally"].includes(next.value))
          && !(next.type === "punct" && next.value === ";")) { result.push([start, k + 1]); start = k + 1; }
        if (depth === 0 && t.value === "}") block = false;
      } else if (t.value === ";" && depth === 0) { result.push([start, k + 1]); start = k + 1; }
    }
  }
  if (start < tokens.length) result.push([start, tokens.length]);
  return result;
}

const STATEMENT_WORDS = new Set(["var", "let", "const", "function", "class", "if", "for", "while", "do", "switch", "try",
  "return", "throw", "break", "continue", "import", "export", "with", "debugger"]);

export interface Transformed { body: string; prelude: string; returnsValue: boolean }

/** Rewrites depth-0 declarations into global assignments and returns the last expression. */
export function transformCell(code: string, returnLast = true): Transformed {
  const { tokens } = tokenize(code);
  const edits: Array<{ at: number; end: number; text: string }> = [];
  const functions: string[] = [];
  const ranges = statements(tokens);
  let returnsValue = false;
  ranges.forEach(([s, e], index) => {
    const first = tokens[s]!, second = tokens[s + 1];
    const semi = tokens[e - 1]?.type === "punct" && tokens[e - 1]!.value === ";";
    const last = tokens[semi ? e - 2 : e - 1];
    if (!last || (semi && e - 1 === s)) return;
    const isLet = first.value === "let" && second && (second.type === "name" || second.value === "{" || second.value === "[");
    if (first.type === "name" && (first.value === "var" || first.value === "const" || isLet)) {
      // `const a = 1, {b} = o;` becomes `void (a = 1, {b} = o);`. Sloppy-mode
      // assignment creates the globals; a bare `let a` gets `= undefined`, while
      // a bare `var a` keeps an existing value, as redeclaring a var does.
      edits.push({ at: first.start, end: first.end, text: "void (" });
      let depth = 0, declStart = s + 1;
      const finish = (from: number, to: number) => {
        const only = tokens[from];
        if (to - from !== 1 || only?.type !== "name") return;
        edits.push({ at: only.end, end: only.end, text: first.value === "var" ? ` = typeof ${only.value} === "undefined" ? undefined : ${only.value}` : " = undefined" });
      };
      for (let k = s + 1; k < (semi ? e - 1 : e); k++) {
        const t = tokens[k]!;
        if (t.type !== "punct") continue;
        if (["(", "[", "{"].includes(t.value)) depth++;
        else if ([")", "]", "}"].includes(t.value)) depth--;
        else if (t.value === "," && depth === 0) { finish(declStart, k); declStart = k + 1; }
      }
      finish(declStart, semi ? e - 1 : e);
      edits.push({ at: last.end, end: last.end, text: ")" });
      return;
    }
    const isAsyncFn = first.value === "async" && second?.value === "function" && !second.nl;
    if (first.type === "name" && (first.value === "function" || isAsyncFn)) {
      let k = s + (isAsyncFn ? 2 : 1);
      if (tokens[k]?.value === "*") k++;
      if (tokens[k]?.type === "name") functions.push(tokens[k]!.value);
      return;
    }
    if (first.type === "name" && first.value === "class" && second?.type === "name" && second.value !== "extends") {
      edits.push({ at: first.start, end: first.start, text: `${second.value} = ` });
      if (!semi) edits.push({ at: last.end, end: last.end, text: ";" });
      return;
    }
    if (returnLast && index === ranges.length - 1 && !(first.type === "name" && STATEMENT_WORDS.has(first.value))
      && !(first.type === "punct" && ["{", ";"].includes(first.value))
      && !(first.type === "name" && second?.type === "punct" && second.value === ":")) {
      edits.push({ at: first.start, end: first.start, text: "return (" });
      edits.push({ at: last.end, end: last.end, text: ")" });
      returnsValue = true;
    }
  });
  let body = code;
  // Apply from the end; at one position, later insertions go first so they end up after earlier ones.
  const ordered = edits.map((edit, index) => ({ ...edit, index })).sort((a, b) => b.at - a.at || b.index - a.index);
  for (const edit of ordered) body = body.slice(0, edit.at) + edit.text + body.slice(edit.end);
  const prelude = functions.map((name) => `globalThis[${JSON.stringify(name)}] = ${name};`).join(" ");
  return { body, prelude, returnsValue };
}

/** The async wrapper; the header shares the body's first line so line numbers match. */
export function wrapCell(body: string, prelude = "") {
  return `(async () => { ${prelude} ${body}\n})()`;
}
