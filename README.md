# dsh-web-search-opencode-style

[![npm version](https://img.shields.io/npm/v/dsh-web-search-opencode-style)](https://www.npmjs.com/package/dsh-web-search-opencode-style)
[![license](https://img.shields.io/npm/l/dsh-web-search-opencode-style)](./LICENSE)

An opencode-style web search provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH). It registers a single `opencode-style` provider into `ctx.web`, so the
model-facing `web_search` tool from `@deepseek-ai/dsh-tool-web` keeps working
(cards, citations, timeout, `searchMaxResults`) without tripping
`WEB_PROVIDER_AMBIGUOUS`.

No MCP server to install. No API key. No LLM credits burned.

## How it works

This is a direct port of how opencode performs web search
(`packages/opencode/src/tool/websearch.ts` +
`packages/opencode/src/tool/mcp-websearch.ts`): the CLI `POST`s a JSON-RPC
`tools/call` straight to two public MCP endpoints, then parses the MCP response
(plain JSON or SSE `data: ...` lines):

- Exa: `https://mcp.exa.ai/mcp` → `web_search_exa`
- Parallel: `https://search.parallel.ai/mcp` → `web_search`

The plugin is zero-dependency: it only uses the global `fetch` (Node >= 20).

## Fidelity to opencode

Ported 1:1 and cross-checked against `websearch.ts` + `mcp-websearch.ts`:

- Same endpoints, tool names, JSON-RPC body (`id: 1`, `tools/call`), `accept`
  header, 25s timeout, default `redirect` (follow).
- Same default args: `type: auto`, `numResults: 8`, `livecrawl: fallback`,
  `contextMaxCharacters` only sent when set; `numResults = request || config || 8`
  (no clamping, exactly `params.numResults || 8`).
- Same backend selection order as `selectWebSearchProvider()`:
  env `OPENCODE_WEBSEARCH_PROVIDER` → config `provider` → flags
  `enableExa`/`enableParallel` (env `OPENCODE_ENABLE_EXA`,
  `OPENCODE_ENABLE_PARALLEL`, `OPENCODE_EXPERIMENTAL*` as `RuntimeFlags`) →
  `checksum(sessionID) % 2`. The session comes from
  `ctx.agents.currentInitiator()`, so **every search inside one session hits the
  same backend**, exactly like opencode.
- Same fields sent to Parallel: `objective`, `search_queries`, `session_id`
  (real session; without one, `dsh_<checksum(query)>`), `model_name`
  (`agent.options.model`, truncated to 100 chars — mirrors `webSearchModelName`).
- Same parsing: raw JSON first, then scan `data: ` lines; a `{...}` payload that
  is not an `McpResult` (JSON-RPC `error`, malformed JSON) is an **error**, not a
  silent "no results".
- Same empty-result sentence:
  `No search results found. Please try a different query.`
- Same FNV-1a base36 `checksum` (ported from `packages/core/src/util/encode.ts`).

What cannot be reproduced from the provider layer (DSH architectural limits):

| Point | opencode | DSH |
|---|---|---|
| `numResults`/`livecrawl`/`type`/`contextMaxCharacters` chosen by the model | tool parameters | DSH's `web_search` only takes `queries[]`; `maxResults` is fixed by the `tool-web` row (`searchMaxResults`), the rest is config |
| Asking permission before searching | `ctx.ask({permission:'websearch'})` | `dsh-tool-web` has no approval layer; permission belongs to the host, the provider has no channel |
| Card title + `metadata.provider` | `"Exa Web Search: <query>"` | the seam's `WebSearchResult` has no metadata channel |
| User-Agent (Parallel) | `opencode/<version>` | `dsh-web-search-opencode-style/<version>` — deliberately not impersonating another product |

`sources[]` is the only translation step opencode does not have: the seam needs
structure to render cards and citations. The plugin parses structured formats
first — Parallel's JSON `results[]` (`title`, `publish_date` → `publishedAt`,
`excerpts` → `snippet`), then Exa's
`Title:/URL:/Published:/Highlights:` blocks — and only falls back to scanning raw
URLs when the text matches no known format. `truncated` is set when more sources
were extracted than `maxResults`, so `web_search` can nudge the model to refine
the query.

Error codes: `WEB_PROVIDER_ERROR` (HTTP failure / network failure / unparseable
body / response larger than 4 MiB), `WEB_SEARCH_TIMEOUT` (past `timeoutMs`, same
message as opencode: `<tool> request timed out`, same name family as
`dsh-web-fetch-http`'s `WEB_FETCH_TIMEOUT`), `WEB_ABORTED` (caller aborted).

## Install (one command)

```sh
dsh plugin --profile web add dsh-web-search-opencode-style
```

This runs `pnpm add` inside the profile and wires the bundle into
`dsh.profile.bundles` (via `reconcilePlugins`: any package declaring `dsh.bundle`
joins the stack automatically). The bundle patch both mounts the provider and
overrides the `web` row to `searchProvider: opencode-style` (env
`DSH_WEB_SEARCH_PROVIDER` still wins), so there is no
`WEB_PROVIDER_AMBIGUOUS` clash with the built-in `deepseek-official`. Restart
`dsh --profile web` and the model sees `web_search` as before — no key, no extra
file edits.

Go back to the old DeepSeek search:
`DSH_WEB_SEARCH_PROVIDER=deepseek-official dsh --profile web`.
Pin one opencode backend: `OPENCODE_WEBSEARCH_PROVIDER=exa|parallel`.

Install from a local checkout instead:

```sh
dsh plugin --profile web add /path/to/dsh-web-search-opencode-style
```

Uninstall:

```sh
dsh plugin --profile web remove dsh-web-search-opencode-style
```

## Configuration

Everything below is editable from **Settings → Plugins → Plugin configuration**
(namespace `web-search-opencode-style`): the plugin registers a real settings
section, so the form lists every key and changes apply from the next search
onward. That section needs `@deepseek-ai/schemastery` from the running DSH
install; the plugin loads it from `$DSH_HOME/profiles/node_modules` (DSH's shared
fallback), so a symlinked `dsh plugin add <path>` install works without anything
extra. Without schemastery the plugin still works — only the form is missing.

You can also use the row's `cordis.patch.yml` (see the template file), or the
`config` object passed to `apply()` directly:

| key | default | meaning |
|---|---|---|
| `provider` | `undefined` (auto) | `"exa"` / `"parallel"` to pin; **lower priority** than env `OPENCODE_WEBSEARCH_PROVIDER` (same order as opencode) |
| `enableExa` | env `OPENCODE_ENABLE_EXA` / `OPENCODE_EXPERIMENTAL_EXA` / `OPENCODE_EXPERIMENTAL` | force Exa, like `RuntimeFlags.enableExa` |
| `enableParallel` | env `OPENCODE_ENABLE_PARALLEL` / `OPENCODE_EXPERIMENTAL_PARALLEL` | force Parallel; checked before `enableExa`, like opencode |
| `exaApiKey` | env `EXA_API_KEY` | optional — the public endpoint works without a key |
| `parallelApiKey` | env `PARALLEL_API_KEY` | optional |
| `numResults` | `8` | used when the caller sends no `maxResults`; in practice `tool-web.searchMaxResults` decides |
| `type` | `"auto"` | `auto` / `fast` / `deep` (Exa) |
| `livecrawl` | `"fallback"` | `fallback` / `preferred` (Exa) |
| `contextMaxCharacters` | _(not sent)_ | Exa context cap |
| `timeoutMs` | `25000` | matches opencode's `"25 seconds"` |
| `enabled` | `true` | `false` → `available()` returns false |

## Development

The module exports `name`, `inject`, `apply` and `Config` — and **no default
export**. cordis' loader normalizes module exports with `default ?? exports`
(`cordis-plugin-loader`), so a default export shadows the named metadata and the
plugin loses its `inject`/`Config` (this caused
`cannot get property "web" without inject`). Add a default export only if it
carries that metadata itself.

```sh
node --test test/*.test.mjs        # plugin.test.mjs (ported logic) + dsh-seam.test.mjs (real cordis + dsh-web)
DSH_INTEGRATION=1 node --test test/dsh-seam.test.mjs   # plus one real search against Exa/Parallel
```

`test/dsh-seam.test.mjs` mounts the plugin on a real cordis context with the real
`ctx.web` seam and stubs only the network, so the export shape and the settings
wiring are covered too; it skips itself when no `dsh` install is on `PATH`.

## License

MIT
