// Runtime patch for @earendil-works/pi-tui Markdown so inline and block <br>
// tags render as line breaks instead of literal "<br>" text (notably inside
// Markdown table cells, where marked emits type: "html" for <br>).
// Flagged on 2026-11-10 for 1-month rereview on 2026-12-10.

export const REREVIEW_DATE = "2026-12-10";

const BR_ONLY_RE = /^(?:<br\s*\/?>\s*)+$/i;
const BR_TAG_RE = /<br\s*\/?>/gi;
const ORIG_KEY = Symbol.for("pi-mono.markdown-br.orig");

export interface PatchStatus {
  active: boolean;
  upstreamFixed: boolean;
}

interface OrigMethods {
  renderInlineTokens: (tokens: any[], styleContext?: any) => string;
  renderToken?: (token: any, width: number, nextTokenType?: string, styleContext?: any) => string[];
}

/** Replace inline HTML <br> tokens with Marked "br" tokens; leave other tokens untouched. */
export function normalizeBrTokens(tokens: unknown): unknown {
  if (!Array.isArray(tokens)) return tokens;
  let changed = false;
  const out: any[] = [];
  for (const token of tokens) {
    if (
      token &&
      typeof token === "object" &&
      token.type === "html" &&
      typeof token.raw === "string" &&
      BR_ONLY_RE.test(token.raw.trim())
    ) {
      changed = true;
      const count = token.raw.match(BR_TAG_RE)?.length ?? 1;
      for (let i = 0; i < count; i++) out.push({ type: "br", raw: "<br>" });
    } else {
      out.push(token);
    }
  }
  return changed ? out : tokens;
}

/** Count standalone block-level <br> tags, or return 0 for any other token. */
export function blockBrCount(token: unknown): number {
  if (
    !token ||
    typeof token !== "object" ||
    (token as any).type !== "html" ||
    typeof (token as any).raw !== "string"
  ) {
    return 0;
  }
  const raw = (token as any).raw.trim();
  if (!BR_ONLY_RE.test(raw)) return 0;
  return raw.match(BR_TAG_RE)?.length ?? 1;
}

function rendersBrNatively(renderInlineTokens: OrigMethods["renderInlineTokens"]): boolean {
  try {
    const probe = {
      options: {},
      theme: {},
      getDefaultInlineStyleContext: () => ({ applyText: (text: string) => text, stylePrefix: "" }),
    };
    const out = renderInlineTokens.call(probe, [{ type: "html", raw: "<br>", text: "<br>" }]);
    return out === "\n";
  } catch {
    return false;
  }
}

/** Idempotently patch Markdown.prototype unless upstream pi-tui already renders <br> as a newline. */
export function patchMarkdown(MarkdownClass: { prototype?: any }): PatchStatus {
  const proto = MarkdownClass?.prototype;
  if (!proto || typeof proto.renderInlineTokens !== "function") {
    return { active: false, upstreamFixed: false };
  }
  const orig: OrigMethods = (proto[ORIG_KEY] ??= {
    renderInlineTokens: proto.renderInlineTokens,
    renderToken: typeof proto.renderToken === "function" ? proto.renderToken : undefined,
  });

  if (rendersBrNatively(orig.renderInlineTokens)) {
    proto.renderInlineTokens = orig.renderInlineTokens;
    if (orig.renderToken) proto.renderToken = orig.renderToken;
    return { active: false, upstreamFixed: true };
  }

  proto.renderInlineTokens = function (tokens: any[], styleContext?: any): string {
    return orig.renderInlineTokens.call(this, normalizeBrTokens(tokens) as any[], styleContext);
  };

  if (orig.renderToken) {
    const origRenderToken = orig.renderToken;
    proto.renderToken = function (token: any, width: number, nextTokenType?: string, styleContext?: any): string[] {
      const count = blockBrCount(token);
      if (count > 0) return Array(count).fill("");
      return origRenderToken.call(this, token, width, nextTokenType, styleContext);
    };
  }

  return { active: true, upstreamFixed: false };
}

/** Rereview banner emitted once the 1-month review date arrives. */
export function rereviewNotice(
  status: PatchStatus,
  now = Date.now(),
  rereviewDate = REREVIEW_DATE,
): string | undefined {
  const dueAt = Date.parse(`${rereviewDate}T00:00:00Z`);
  if (!Number.isFinite(dueAt) || now < dueAt) return undefined;
  if (status.upstreamFixed) {
    return `markdown-br rereview (${rereviewDate}): Pi now renders <br> natively; extensions/markdown-br can be removed.`;
  }
  return `markdown-br rereview (${rereviewDate}): Pi still renders <br> literally without the runtime patch; keep or upstream to pi-tui.`;
}
