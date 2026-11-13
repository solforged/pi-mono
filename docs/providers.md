# Providers and search

## Web search

Pi has no built-in web search or page reader. This extension registers a
`web_search` tool and a [`web_fetch`](#web-fetch) tool. Search copies OMP's nested-backend approach rather than injecting hosted search
into the live turn. The current model calls the tool; the extension prefers
the live Grok or Codex backend, then walks the rest of the chain.

| Backend | Auth | Nested call |
| --- | --- | --- |
| Codex | `openai` OAuth or API key | OpenAI `/v1/responses` with hosted `web_search`. |
| xAI | `xai` OAuth or API key | `https://api.x.ai/v1/responses`. |
| Exa | `EXA_API_KEY` | `https://api.exa.ai/search`. |

A Grok session tries xAI first; an OpenAI session tries Codex first. Each starts
with the current model, then its configured candidate list. Other parents keep
Codex then xAI then Exa. Unavailable backends are skipped, and one that fails
or takes over 60 seconds falls through to the next. A backend that timed out is
tried last for the next five minutes. Candidate model IDs
live in [codex.ts](../extensions/web-search/codex.ts) and
[xai.ts](../extensions/web-search/xai.ts), not a second documentation snapshot.
`/web-search` prints the session-aware order; `/web-search <query>` runs it.
`PI_CODEX_WEB_SEARCH_MODEL` and `PI_XAI_WEB_SEARCH_MODEL` pin a nested model.

The model receives the answer and one numbered source list, with nothing said
twice: a citation of a listed page adds only its quote, and a snippet that the
answer already contains is dropped. The list holds 10 sources unless the model
asks for another number, up to 20, with the pages the answer cites first and a
count of the rest; an answer over 12,000 characters is cut. Backends that failed first are not part of
that text. They are recorded in the result's `details`, and the TUI row shows
them beside the backend that answered, for example `exa · 8 sources · after
codex timed out after 60 s`; expanding the row also lists unconfigured ones.

This is not in-session search. Pi's Responses parser ignores `web_search_call`
items, so injecting hosted search into the live payload would drop citations
and replay. Nested calls reuse the existing logins and work for any parent
model, including Nous Portal sessions. The Codex backend label is kept for
session routing; requests use Pi's current OpenAI endpoint and do not require an
account-id claim in the ChatGPT access token.

## Web fetch

`web_fetch` reads one page as text, without a model call or a third-party
reader service. `/web-fetch <url> [term]` runs the same code for a manual check.

```json
{ "url": "https://nodejs.org/api/net.html", "find": "BlockList" }
```

- It asks for Markdown first, which many documentation sites now serve, and
  otherwise converts HTML itself: the page's `<main>`, `role="main"` or
  `<article>` content as headings, lists, code blocks and table rows, without
  scripts, styles, navigation or footers. GitHub file pages are read from the
  raw host. Other text types are returned as they are; PDFs, images and other
  binary content are refused.
- A call returns at most 12,000 characters. The closing line gives the
  `offset` that continues. `find` returns only the passages around a literal,
  case-insensitive term, each marked with the offset to read on from, so one
  section of a long reference costs one small call.
- Link targets are left out unless `links` is true.
- Pages are kept in memory for five minutes, so paging does not fetch again.
  Limits are 5 MiB per page, 30 seconds and five redirects.
- Pages that are drawn entirely by scripts have no text to return, and say so.

The tool runs on the host, also when the [sandbox](sandbox.md) is on. It
therefore refuses loopback, private and link-local addresses, by name and after
each redirect, so that a page cannot direct it at services only this machine
can reach. `PI_WEB_FETCH_PRIVATE=1` lifts that, for example to read a local
development server. The check resolves a name before the request is made; it
does not pin the connection to that address.

## Anthropic integration

The `anthropic` extension integrates automatically with Pi's existing Anthropic
provider. Use the normal `/login anthropic` and `/model`; there are no extra
commands, status messages, or provider entries. It adds OMP's Claude Code
request fingerprint and minimum-version retry, applying only to `sk-ant-oat`
subscription tokens sent to `https://api.anthropic.com/v1/messages`. API keys,
other providers, proxies, and token exchange requests are unchanged. Existing
`/login anthropic` credentials and refresh behavior stay owned by Pi; no
credentials are copied from OMP or Claude Code.

The wrapper adds Claude Code headers, a SHA-256 billing marker, XXHash64 body
attestation, and session metadata. It preserves Pi's feature-specific betas,
removes the subscription-incompatible `context-1m` beta, and retains tool names,
images, thinking, stream parsing, usage accounting, and request hooks. The
uncached billing block precedes Pi's existing system blocks and cache controls.
Device identity is random and stable for this extension runtime, not persisted.
An explicit compatible `metadata.user_id` is preserved.

An explicit `claude_code_version_too_old` HTTP rejection can adopt the required
version and retry once before streaming begins. The adopted version lasts until
reload or process exit. There are no background version checks or runtime
upstream downloads. `PI_AI_CLAUDE_CODE_VERSION` pins the claimed version and
disables automatic adoption; provider-scoped environment overrides win. The
fallback version lives in [compat.ts](../extensions/anthropic/compat.ts).

The tested Pi 1.4.0 provider already uses the full model output ceiling, so no
additional OAuth-specific output-cap patch is needed. Caller-owned SDK clients
supplied to the low-level stream API bypass this fetch wrapper; ordinary Pi and
workflow requests use the built-in client.

This is a local compatibility port, not official Anthropic support or a
`claude -p` wrapper. Subscription access may break or conflict with Anthropic's
[credential-use policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).
API-key usage does not need this shim. Upstream commits and the MIT license are
retained in [NOTICE](../extensions/anthropic/NOTICE).

## Anthropic subprocesses

Subprocesses disable extension discovery. If you choose the Anthropic profile
for subscription-backed advisor or worker calls, explicitly load this wrapper
there too. For this checkout location, merge this into `roles.local.json`:

```json
{
  "profiles": {
    "anthropic": {
      "subagents": {
        "childExtensions": ["~/src/pi-mono/extensions/anthropic/index.ts"]
      }
    }
  }
}
```

Adjust that path if the checkout is elsewhere. This does not copy credentials;
children use Pi's existing auth storage. In-process titles, commits, and learning
already use the parent provider wrapper. See [model roles](roles.md) for profile
selection and local overrides.
