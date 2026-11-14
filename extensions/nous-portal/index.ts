// The Nous Portal subscription as a Pi provider: /login nous-portal, the
// Portal's chat models in /model, and /nous-usage for the allowance.
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { report } from "../shared/context.ts";
import { formatUsage, INFERENCE, login, PROVIDER, refreshModels, refreshToken, usage } from "./portal.ts";

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER, {
    name: "Nous Portal",
    baseUrl: INFERENCE,
    api: "openai-completions",
    // Returns nothing when the list should stay as it is; Pi checks for that.
    refreshModels: refreshModels as ProviderConfig["refreshModels"],
    oauth: {
      name: "Nous Portal",
      isSubscription: true,
      login,
      refreshToken,
      getApiKey: credentials => credentials.access,
    },
  });

  pi.registerCommand("nous-usage", {
    description: "Show the Nous Portal subscription's allowance and credits",
    handler: async (_args, ctx) => {
      const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
      if (!token) return report(ctx, `Not signed in to Nous Portal. Run /login ${PROVIDER}.`, "warning");
      try {
        report(ctx, formatUsage(await usage(token)));
      } catch (error) {
        report(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
