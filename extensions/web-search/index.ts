import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { searchOrder } from "./format.ts";
import { availableProviders, executeSearch, registryAuth, type SearchAuth, type SearchQuery } from "./search.ts";

const Recency = StringEnum(["day", "week", "month", "year"] as const);

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
      limit: extra.limit,
      provider: extra.provider,
      sessionProvider: ctx.model?.provider,
      sessionModel: ctx.model?.id,
    };
  }

  pi.registerCommand("web-search", {
    description: "Show search backends, or /web-search <query> to run one",
    handler: async (args, ctx) => {
      const query = args.trim();
      const auth = authFor(ctx);
      const order = searchOrder(ctx.model?.provider);
      if (!query || query === "check") {
        const available = await availableProviders(auth);
        const lines = [
          `Session: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
          `Order: ${order.join(" → ")}`,
          ...order.map((id) => `${id}: ${available[id] ? "available" : "not configured"}`),
          "Prefers the live Grok or Codex backend, then falls through. Set EXA_API_KEY for the last backend.",
        ];
        report(ctx, lines.join("\n"));
        return;
      }
      const result = await executeSearch(sessionQuery(ctx, { query }), { auth, signal: ctx.signal });
      report(ctx, result.text);
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    // Sent with every request: keep it short. Backend order is in docs/providers.md.
    description: "Search the web for current events, docs and facts beyond your knowledge. site:, after: and quotes work. Prefer primary sources; cite their URLs.",
    parameters: Type.Object({ query: Type.String(), recency: Type.Optional(Recency), limit: Type.Optional(Type.Number()) }),
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
        },
        isError: Boolean(result.error),
      };
    },
  });
}
