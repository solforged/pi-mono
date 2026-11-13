import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadPage, pageView } from "./fetch.ts";
import { attemptSummary, dropBlankRecency, RECENCIES, searchOrder, sourceLimit } from "./format.ts";
import { availableProviders, executeSearch, orderByHealth, registryAuth, timedOutRecently, type SearchAuth, type SearchQuery } from "./search.ts";
import { fetchCall, fetchView, searchCall, searchView } from "./view.ts";

const Recency = StringEnum(RECENCIES);

function row(previous: unknown, text: string): Text {
  const component = previous instanceof Text ? previous : new Text("", 0, 0);
  component.setText(text);
  return component;
}

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer("web-search-report", (entry) => new Text((entry.data as { text: string }).text, 0, 0));

  function report(ctx: ExtensionContext, text: string) {
    pi.appendEntry("web-search-report", { text });
    if (!ctx.hasUI) console.log(text);
    else if (ctx.mode !== "tui") ctx.ui.notify(text, "info");
  }

  function authFor(ctx: ExtensionContext): SearchAuth {
    return registryAuth(ctx.modelRegistry);
  }

  function sessionQuery(ctx: ExtensionContext, extra: Partial<SearchQuery> = {}): SearchQuery {
    return {
      query: extra.query ?? "",
      recency: extra.recency,
      limit: sourceLimit(extra.limit),
      sessionProvider: ctx.model?.provider,
      sessionModel: ctx.model?.id,
    };
  }

  pi.registerCommand("web-search", {
    description: "Show search backends, or /web-search <query> to run one",
    handler: async (args, ctx) => {
      const query = args.trim();
      const auth = authFor(ctx);
      const order = orderByHealth(searchOrder(ctx.model?.provider));
      if (!query || query === "check") {
        const available = await availableProviders(auth);
        const lines = [
          `Session: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
          `Order: ${order.join(" → ")}`,
          ...order.map((id) => `${id}: ${available[id] ? "available" : "not configured"}${timedOutRecently(id) ? "; timed out recently, so tried last for now" : ""}`),
          "Prefers the live Grok or Codex backend, then falls through. Set EXA_API_KEY for the last backend.",
        ];
        report(ctx, lines.join("\n"));
        return;
      }
      const result = await executeSearch(sessionQuery(ctx, { query }), { auth, signal: ctx.signal });
      const trouble = attemptSummary(result.attempts);
      report(ctx, result.response && trouble ? `${result.text}\n\nAnswered by ${result.response.provider} after ${trouble}.` : result.text);
    },
  });

  pi.registerCommand("web-fetch", {
    description: "/web-fetch <url> [term] reads a page as the web_fetch tool does",
    handler: async (args, ctx) => {
      const [url, ...find] = args.trim().split(/\s+/);
      if (!url) { report(ctx, "Usage: /web-fetch <url> [term]"); return; }
      try { report(ctx, pageView(await loadPage(url, { signal: ctx.signal }), { find: find.join(" ") })); }
      catch (error) { report(ctx, `Error: ${error instanceof Error ? error.message : String(error)}`); }
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    // Sent with every request: keep it short. Backend order is in docs/providers.md.
    description: "Search the web for current events, docs and facts beyond your knowledge. site:, after: and quotes work. Prefer primary sources; cite their URLs.",
    parameters: Type.Object({ query: Type.String(), recency: Type.Optional(Recency), limit: Type.Optional(Type.Number()) }),
    prepareArguments: (args) => dropBlankRecency(args) as any,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Searching..." }] });
      const query = sessionQuery(ctx, {
        query: params.query,
        recency: params.recency as SearchQuery["recency"],
        limit: params.limit,
      });
      const result = await executeSearch(query, { auth: authFor(ctx), signal: signal ?? ctx.signal });
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          provider: result.response?.provider,
          model: result.response?.model,
          sources: result.response?.sources ?? [],
          attempts: result.attempts,
        },
        isError: Boolean(result.error),
      };
    },
    renderCall(args, theme, context) {
      return row(context.lastComponent, searchCall(args, theme));
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      return row(context.lastComponent, searchView(result, theme, { expanded, isPartial, isError: context.isError, hint: context.keyHint("app.tools.expand", "to expand") }));
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    // Sent with every request: keep it short. Limits are in docs/providers.md.
    description: "Read a web page as text. Long pages come in parts: pass the returned offset, or find a literal term to get only matching passages. links: true keeps link URLs.",
    parameters: Type.Object({ url: Type.String(), offset: Type.Optional(Type.Integer()), find: Type.Optional(Type.String()), links: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const page = await loadPage(params.url, { links: params.links, signal: signal ?? ctx.signal });
      return {
        content: [{ type: "text", text: pageView(page, params) }],
        details: { url: page.url, title: page.title, chars: page.text.length },
      };
    },
    renderCall(args, theme, context) {
      return row(context.lastComponent, fetchCall(args, theme));
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      return row(context.lastComponent, fetchView(result, theme, { expanded, isPartial, isError: context.isError, hint: context.keyHint("app.tools.expand", "to expand") }));
    },
  });
}
