/**
 * dsh-web-search-opencode-style — Opencode-style web search for DeepSeek Harness.
 *
 * Port trực tiếp cách opencode đang làm (`packages/opencode/src/tool/websearch.ts`
 * + `packages/opencode/src/tool/mcp-websearch.ts`):
 *  - Không cần cài MCP server, không cần API key.
 *  - POST JSON-RPC `tools/call` thẳng tới 2 endpoint public:
 *      Exa:      https://mcp.exa.ai/mcp            (tool `web_search_exa`)
 *      Parallel: https://search.parallel.ai/mcp    (tool `web_search`)
 *    rồi parse MCP response (JSON thuần hoặc SSE `data: ...`).
 *  - Chọn provider ổn định 50/50 theo checksum của query (opencode dùng
 *    checksum của sessionID; ở DSH seam `search()` không có session nên dùng
 *    checksum của query — cùng query luôn đi cùng provider).
 *  - Override khi cần: `provider: "exa" | "parallel"` hoặc
 *    env `OPENCODE_WEBSEARCH_PROVIDER=exa|parallel` (giống opencode).
 *
 * Đăng ký đúng 1 provider `opencode-style` vào `ctx.web`, để đi qua
 * `web_search` model-facing có sẵn của `@deepseek-ai/dsh-tool-web` mà không
 * gây `WEB_PROVIDER_AMBIGUOUS`.
 *
 * Zero dependency — chỉ dùng global `fetch` (Node >= 20). `@deepseek-ai/schemastery`
 * là tuỳ chọn: có thì mới mở được mục config trên Settings page (xem `Config`).
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'web-search-opencode-style'

/** Chạy sau khi `ctx.web` (dsh-web) đã mount. */
export const inject = ['web']

export const PROVIDER_ID = 'opencode-style'
export const EXA_URL = 'https://mcp.exa.ai/mcp'
export const PARALLEL_URL = 'https://search.parallel.ai/mcp'
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024 // sanity bound; opencode không có cap nào
/** Nguyên văn opencode trả khi search không ra kết quả (`result ?? …`). */
export const NO_RESULTS_TEXT = 'No search results found. Please try a different query.'
/** Settings namespace cho mục "Plugin configuration" trên Settings page. */
export const SETTINGS_NAMESPACE = 'web-search-opencode-style'
const PLUGIN_VERSION = '0.1.1'

/** Lỗi tương thích với taxonomy của dsh-web (không cần import dsh-web). */
export class WebError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}

/**
 * FNV-1a 32-bit, port từ `packages/core/src/util/encode.ts` của opencode.
 * @param {string} content
 * @returns {string|undefined} base36 hash, undefined khi input rỗng.
 */
export function checksum(content) {
  if (!content) return undefined
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** Giá trị env mà opencode coi là `true` (`Config.boolean` của Effect). */
const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'y', 't'])

/** Env bật/tắt từng backend, đúng tên `RuntimeFlags` của opencode. */
const EXA_FLAG_ENVS = ['OPENCODE_ENABLE_EXA', 'OPENCODE_EXPERIMENTAL_EXA', 'OPENCODE_EXPERIMENTAL']
const PARALLEL_FLAG_ENVS = ['OPENCODE_ENABLE_PARALLEL', 'OPENCODE_EXPERIMENTAL_PARALLEL']

/**
 * Cờ bật backend: config thắng env, đúng thứ tự `selectWebSearchProvider()`
 * duyệt `flags.exa` / `flags.parallel`.
 * @param {object} cfg
 * @param {string} key
 * @param {string[]} envNames
 */
function flagEnabled(cfg, key, envNames) {
  if (typeof cfg[key] === 'boolean') return cfg[key]
  return envNames.some((name) => TRUTHY.has(String(process.env[name] ?? '').trim().toLowerCase()))
}

/**
 * Chọn backend — port nguyên thứ tự ưu tiên của opencode
 * `selectWebSearchProvider(sessionID, flags)`:
 *   1. env `OPENCODE_WEBSEARCH_PROVIDER=exa|parallel`
 *   2. config `provider` (tương đương pin ở tầng deployment)
 *   3. flags `enableParallel` / `enableExa` (env như opencode, hoặc config)
 *   4. checksum 50/50 của SESSION ID
 *
 * opencode luôn có session nên bước 4 luôn dùng sessionID; seam DSH không đưa
 * session vào `search()`, nên khi không có session thì rơi về checksum(query)
 * (vẫn ổn định: cùng query → cùng backend).
 * @param {string} subject - session id, hoặc query khi không có session.
 * @param {{ provider?: string, enableExa?: boolean, enableParallel?: boolean }} [cfg]
 * @returns {'exa'|'parallel'}
 */
export function selectProvider(subject, cfg = {}) {
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (override === 'exa' || override === 'parallel') return override
  if (cfg.provider === 'exa' || cfg.provider === 'parallel') return cfg.provider
  if (flagEnabled(cfg, 'enableParallel', PARALLEL_FLAG_ENVS)) return 'parallel'
  if (flagEnabled(cfg, 'enableExa', EXA_FLAG_ENVS)) return 'exa'
  return parseInt(checksum(subject) ?? '0', 36) % 2 === 0 ? 'exa' : 'parallel'
}

function exaUrl(apiKey) {
  if (!apiKey) return EXA_URL
  return `${EXA_URL}?exaApiKey=${encodeURIComponent(apiKey)}`
}

/**
 * Thử parse 1 payload JSON-RPC thành text.
 *
 * Giống opencode (`Schema.decodeUnknownEffect`): payload bắt đầu bằng `{` mà
 * không phải một `McpResult` hợp lệ là LỖI, không phải "không có kết quả" —
 * nên JSON-RPC `error` được ném ra thay vì lặng lẽ thành `No results found.`
 * @returns {string|undefined} text của content item đầu tiên có `text`.
 */
function parsePayload(payload) {
  const trimmed = payload.trim()
  if (!trimmed.startsWith('{')) return undefined
  let data
  try {
    data = JSON.parse(trimmed)
  } catch (error) {
    throw new WebError(`Search provider returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', {
      cause: error,
    })
  }
  if (data?.error !== undefined && data?.error !== null) {
    const detail = typeof data.error === 'object' ? (data.error.message ?? JSON.stringify(data.error)) : String(data.error)
    const code = typeof data.error === 'object' && data.error.code !== undefined ? ` ${data.error.code}` : ''
    throw new WebError(`Search provider returned a JSON-RPC error${code}: ${detail}`, 'WEB_PROVIDER_ERROR')
  }
  const content = data?.result?.content
  if (!Array.isArray(content)) {
    throw new WebError('Search provider returned a JSON payload without result.content', 'WEB_PROVIDER_ERROR')
  }
  return content.find((item) => typeof item?.text === 'string')?.text
}

/**
 * Parse MCP response — port `parseResponse` của opencode: JSON thuần trước,
 * rồi quét từng dòng `data: ...` (SSE), bỏ qua frame non-JSON như `[DONE]`.
 */
export function parseMcpResponse(body) {
  const trimmed = body.trim()
  if (trimmed) {
    const direct = parsePayload(trimmed)
    if (direct) return direct
  }
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const text = parsePayload(line.substring(6))
    if (text) return text
  }
  return undefined
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function cleanUrl(raw) {
  return raw.replace(/[)\].,;'"!]+$/u, '')
}

const TITLE_MAX = 200
const SNIPPET_MAX = 300

/** Excerpt nhiều dòng của Exa/Parallel -> 1 dòng gọn cho `snippet`. */
function tidyExcerpt(text) {
  return String(text ?? '')
    .replace(/\r/gu, '')
    .replace(/^[ \t]*\.\.\.[ \t]*$/gmu, '') // dòng đánh dấu chỗ lược bớt của Exa
    .replace(/\s+/gu, ' ')
    .replace(/(?:^|\s)#{1,6}\s+/gu, ' ') // bỏ dấu markdown heading trong excerpt
    .trim()
    .slice(0, SNIPPET_MAX)
}

/** Giá trị placeholder Exa trả khi không có dữ liệu. */
function realValue(value) {
  const trimmed = String(value ?? '').trim()
  return trimmed.length > 0 && trimmed !== 'N/A' ? trimmed : undefined
}

/**
 * Gom 1 nguồn vào danh sách: bỏ host của chính 2 MCP endpoint, dedupe theo URL.
 * @param {{sources: object[], seen: Set<string>}} acc
 * @param {{url?: unknown, title?: unknown, snippet?: unknown, publishedAt?: unknown}} candidate
 */
function pushSource(acc, candidate) {
  if (typeof candidate.url !== 'string') return
  const url = cleanUrl(candidate.url.trim())
  if (!/^https?:\/\//iu.test(url) || acc.seen.has(url)) return
  const host = hostnameOf(url)
  if (host === 'mcp.exa.ai' || host === 'search.parallel.ai') return
  acc.seen.add(url)
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
  const snippet = tidyExcerpt(candidate.snippet)
  const publishedAt = realValue(candidate.publishedAt)
  acc.sources.push({
    url,
    ...(title && title !== url ? { title: title.slice(0, TITLE_MAX) } : {}),
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  })
}

/**
 * Parallel trả `result.content[0].text` là JSON `{results:[{url,title,publish_date,excerpts}]}`.
 * Parse thẳng để có title/ngày/excerpt thật thay vì đoán từ text.
 * @returns {object[]|undefined} undefined khi text không phải dạng đó.
 */
export function sourcesFromParallelJson(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('{')) return undefined
  let data
  try {
    data = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!Array.isArray(data?.results)) return undefined
  const acc = { sources: [], seen: new Set() }
  for (const item of data.results) {
    if (typeof item?.url !== 'string') continue
    pushSource(acc, {
      url: item.url,
      title: item.title,
      snippet: Array.isArray(item.excerpts) ? item.excerpts.join(' ') : item.excerpts,
      publishedAt: item.publish_date,
    })
  }
  return acc.sources.length > 0 ? acc.sources : undefined
}

/**
 * Exa trả text dạng block cố định:
 * `Title: … / URL: … / Published: … / Author: … / Highlights: …`.
 * @returns {object[]|undefined} undefined khi text không có block nào.
 */
export function sourcesFromExaBlocks(text) {
  const blocks = String(text ?? '')
    .split(/(?=^Title:[ \t])/mu)
    .filter((block) => /^Title:[ \t]/mu.test(block))
  if (blocks.length === 0) return undefined
  const acc = { sources: [], seen: new Set() }
  for (const block of blocks) {
    const highlights = /^Highlights:[ \t]*$/mu.exec(block)
    pushSource(acc, {
      url: /^URL:[ \t]*(\S+)[ \t]*$/mu.exec(block)?.[1],
      title: /^Title:[ \t]*(.*)$/mu.exec(block)?.[1],
      snippet: highlights ? block.slice(highlights.index + highlights[0].length) : '',
      publishedAt: /^Published:[ \t]*(.*)$/mu.exec(block)?.[1],
    })
  }
  return acc.sources.length > 0 ? acc.sources : undefined
}

/**
 * Fallback cuối: quét URL thô (markdown link + bare URL) khi text không khớp
 * format có cấu trúc nào ở trên. Port từ bản trước.
 */
function scrapeSources(text) {
  const acc = { sources: [], seen: new Set() }
  for (const m of text.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^)\s]+)\)/g)) {
    pushSource(acc, { url: m[2], title: m[1] })
  }
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/https?:\/\/[^\s)>\]"']+/gi)) {
      const snippet = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()
      pushSource(acc, { url: m[0], title: hostnameOf(cleanUrl(m[0])), snippet: snippet === m[0] ? '' : snippet })
    }
  }
  return acc.sources
}

/**
 * Bóc sources từ text tự do của Exa/Parallel thành sources chuẩn của `ctx.web`.
 * Exa/Parallel trả về text (không phải JSON sources), nên đây là bước chuyển
 * duy nhất không có trong opencode gốc — opencode ném cả cục text cho LLM,
 * còn DSH cần `sources[]` để render card + cite.
 *
 * Ưu tiên format có cấu trúc (Parallel JSON, Exa block) để có title + ngày,
 * rồi quét URL thô để phủ nốt phần thiếu.
 * @param {string} text
 * @returns {object[]} mọi source bóc được, chưa cắt theo maxResults.
 */
export function extractAllSources(text) {
  const content = String(text ?? '')
  const acc = { sources: [], seen: new Set() }
  for (const source of sourcesFromParallelJson(content) ?? []) pushSource(acc, source)
  for (const source of sourcesFromExaBlocks(content) ?? []) pushSource(acc, source)
  for (const source of scrapeSources(content)) pushSource(acc, source)
  return acc.sources
}

/**
 * @param {string} text
 * @param {number} [maxResults]
 * @returns {object[]} tối đa `maxResults` source đầu tiên.
 */
export function extractSources(text, maxResults = 8) {
  return extractAllSources(text).slice(0, maxResults)
}

/**
 * Map text MCP thành WebSearchResult của seam.
 *
 * `content` giữ NGUYÊN text provider trả về (như opencode đưa nguyên cục text
 * cho LLM) — không cắt ở 20k nữa. `truncated` bật khi phải bỏ bớt source vì
 * `maxResults`, để `web_search` nhắc model refine query.
 *
 * Không có kết quả thì `content` là đúng câu opencode trả
 * (`result ?? NO_RESULTS_TEXT`), thay vì để tool tự render "No results found.".
 * @param {string} text
 * @param {number} [maxResults]
 */
export function textToResult(text, maxResults = 8) {
  const content = (text ?? '').trim()
  if (!content) return { content: NO_RESULTS_TEXT, sources: [], truncated: false }
  const all = extractAllSources(content)
  const sources = all.slice(0, maxResults)
  return {
    content,
    sources,
    truncated: all.length > sources.length,
  }
}

/**
 * Dịch lỗi fetch thành `WebError` theo ĐÚNG nguồn gốc, giống cách
 * `dsh-web-fetch-http` phân biệt deadline của nó với abort của caller: timeout
 * của provider là `WEB_SEARCH_TIMEOUT` (cùng họ tên với `WEB_FETCH_TIMEOUT`),
 * caller huỷ là `WEB_ABORTED`, còn lại là `WEB_PROVIDER_ERROR`.
 * @param {unknown} error
 * @param {AbortSignal|undefined} callerSignal
 * @param {AbortSignal} timeoutSignal
 * @param {string} tool
 */
function translateFetchError(error, callerSignal, timeoutSignal, tool) {
  if (callerSignal?.aborted) {
    throw new WebError(`Opencode-style search aborted: ${String(error)}`, 'WEB_ABORTED', { cause: error })
  }
  if (timeoutSignal.aborted) {
    // Nguyên văn thông báo của opencode: `${tool} request timed out`.
    throw new WebError(`${tool} request timed out`, 'WEB_SEARCH_TIMEOUT', { cause: error })
  }
  throw new WebError(`Search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

/**
 * 1 cú POST JSON-RPC `tools/call`, port `McpWebSearch.call` của opencode.
 * @returns {Promise<string|undefined>} text MCP (undefined = no results).
 */
export async function callMcp(url, tool, args, { headers = {}, timeoutMs = 25000, signal } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  let response
  try {
    // opencode để HttpClient mặc định follow redirect — không tự chặn ở đây.
    response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: combined,
    })
    if (!response.ok) throw new WebError(`Search provider HTTP ${response.status} from ${url}`, 'WEB_PROVIDER_ERROR')
    const body = await response.text()
    if (body.length > MAX_RESPONSE_BYTES) {
      throw new WebError(`Search response exceeded ${MAX_RESPONSE_BYTES} bytes`, 'WEB_PROVIDER_ERROR')
    }
    return parseMcpResponse(body)
  } catch (error) {
    if (error instanceof WebError) throw error
    translateFetchError(error, signal, timeoutSignal, tool)
  }
}

/** Provider `opencode-style`: route nội bộ exa/parallel, ngoài chỉ thấy 1 id. */
export class OpencodeStyleSearchProvider {
  /**
   * @param {() => object} resolveConfig
   * @param {() => { modelName?: string, sessionId?: string }} [resolveAgent] -
   *   danh tính agent đang chạy search: model id để gửi `model_name`, session id
   *   để chọn backend và gửi `session_id` — đúng những gì opencode lấy từ
   *   `ctx.extra.model` và `ctx.sessionID`.
   */
  constructor(resolveConfig, resolveAgent = () => ({})) {
    this.resolveConfig = resolveConfig
    this.resolveAgent = resolveAgent
    this.id = PROVIDER_ID
  }

  available() {
    const cfg = this.resolveConfig()
    if (cfg.enabled === false) return false
    return URL.canParse(cfg.exaUrl ?? EXA_URL) && URL.canParse(cfg.parallelUrl ?? PARALLEL_URL)
  }

  async search(request, signal) {
    const cfg = this.resolveConfig()
    const query = request?.query?.trim?.() ?? ''
    if (!query) throw new WebError('query must be a non-empty string', 'WEB_PROVIDER_ERROR')
    // opencode: `params.numResults || 8` — falsy thì lấy default, không clamp.
    const maxResults = request.maxResults || cfg.numResults || 8
    const agent = this.resolveAgent() ?? {}
    const provider = selectProvider(agent.sessionId ?? query, cfg)
    if (signal?.aborted) throw new WebError('Opencode-style search aborted', 'WEB_ABORTED', { cause: signal.reason })

    try {
      if (provider === 'exa') {
        const args = {
          query,
          type: cfg.type ?? 'auto',
          numResults: maxResults,
          livecrawl: cfg.livecrawl ?? 'fallback',
          ...(cfg.contextMaxCharacters ? { contextMaxCharacters: cfg.contextMaxCharacters } : {}),
        }
        const text = await callMcp(exaUrl(cfg.exaApiKey), 'web_search_exa', args, { timeoutMs: cfg.timeoutMs ?? 25000, signal })
        return textToResult(text ?? '', maxResults)
      }
      const args = {
        objective: query,
        search_queries: [query],
        session_id: agent.sessionId ?? `dsh_${checksum(query) ?? '0'}`,
        ...(agent.modelName ? { model_name: agent.modelName } : {}),
      }
      const headers = { 'User-Agent': `dsh-web-search-opencode-style/${PLUGIN_VERSION}` }
      if (cfg.parallelApiKey) headers.Authorization = `Bearer ${cfg.parallelApiKey}`
      const text = await callMcp(cfg.parallelUrl ?? PARALLEL_URL, 'web_search', args, {
        headers,
        timeoutMs: cfg.timeoutMs ?? 25000,
        signal,
      })
      return textToResult(text ?? '', maxResults)
    } catch (error) {
      if (error instanceof WebError) throw error
      throw new WebError(`Opencode-style search failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/**
 * Danh tính agent đang chạy tool call này, đúng những gì opencode đọc từ
 * `Tool.Context`:
 *  - `sessionID` của opencode ↔ `agent.session.id` (DSH expose qua
 *    AsyncLocalStorage của `ctx.agents`, cùng cách provider DeepSeek dùng).
 *  - `ctx.extra.model` của opencode ↔ `agent.options.model`, cắt 100 ký tự như
 *    `webSearchModelName`.
 * Không có agent (headless/sdk) thì trả object rỗng — mọi field đều optional.
 * @param {any} ctx
 * @returns {{ modelName?: string, sessionId?: string }}
 */
function currentAgent(ctx) {
  try {
    const agent = ctx?.get?.('agents')?.currentInitiator?.()
    if (agent === undefined || agent === null) return {}
    const model = agent.options?.model
    const sessionId = agent.session?.id
    return {
      ...(typeof model === 'string' && model.length > 0 ? { modelName: model.slice(0, 100) } : {}),
      ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Thư mục module-fallback dùng chung của DSH: bản cài đặt link toàn bộ
 * dependency closure vào `$DSH_HOME/profiles/node_modules`. Cần đường dẫn
 * tuyệt đối này vì `dsh plugin add <path>` cài plugin bằng symlink, nên Node
 * resolve theo realpath của checkout — `import '@deepseek-ai/schemastery'`
 * trần từ đó sẽ không thấy gì.
 * @returns {string[]} các thư mục node_modules để thử resolve.
 */
function moduleFallbackDirs() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return [join(home, 'profiles', 'node_modules'), join(home, 'node_modules')]
}

/**
 * Nạp schemastery của chính bản DSH đang chạy (không bundle bản riêng).
 * Thử bare specifier trước (đúng khi plugin được cài kiểu copy/registry, hoặc
 * checkout tự có dependency), rồi tới module-fallback ở trên.
 * @returns {Promise<any|undefined>} `z` hoặc undefined khi không tìm thấy.
 */
async function loadSchemastery() {
  const specifiers = ['@deepseek-ai/schemastery']
  const require = createRequire(import.meta.url)
  for (const dir of moduleFallbackDirs()) {
    try {
      specifiers.push(pathToFileURL(require.resolve('@deepseek-ai/schemastery', { paths: [dir] })).href)
    } catch {
      // Thư mục fallback chưa tồn tại ở lần chạy đầu — bỏ qua.
    }
  }
  for (const specifier of specifiers) {
    try {
      const module = await import(specifier)
      const z = module.default ?? module
      if (typeof z?.object === 'function') return z
    } catch {
      // Thử specifier kế tiếp.
    }
  }
  return undefined
}

const z = await loadSchemastery()

/**
 * Schema cho row config (loader validate qua `Config['~standard']`) và cho
 * settings section. `undefined` khi thiếu schemastery: loader bỏ qua validate
 * và plugin chạy bằng config composition như trước.
 */
export const Config = z?.object?.({
  provider: z.string(),
  enableExa: z.boolean(),
  enableParallel: z.boolean(),
  exaApiKey: z.string().role('secret'),
  parallelApiKey: z.string().role('secret'),
  exaUrl: z.string(),
  parallelUrl: z.string(),
  type: z.string(),
  livecrawl: z.string(),
  contextMaxCharacters: z.number(),
  numResults: z.number().default(8),
  timeoutMs: z.number().default(25000),
  enabled: z.boolean().default(true),
})

/** Gom config tĩnh + env về 1 options snapshot cho mỗi search (giống deepseek provider). */
function resolveOptions(config) {
  return {
    provider: config?.provider ?? process.env.OPENCODE_WEBSEARCH_PROVIDER,
    enableExa: config?.enableExa,
    enableParallel: config?.enableParallel,
    exaApiKey: config?.exaApiKey ?? process.env.EXA_API_KEY,
    parallelApiKey: config?.parallelApiKey ?? process.env.PARALLEL_API_KEY,
    exaUrl: config?.exaUrl,
    parallelUrl: config?.parallelUrl,
    type: config?.type,
    livecrawl: config?.livecrawl,
    contextMaxCharacters: config?.contextMaxCharacters,
    numResults: config?.numResults ?? 8,
    timeoutMs: config?.timeoutMs ?? 25000,
    enabled: config?.enabled,
  }
}

/**
 * Mount plugin.
 * @param {any} ctx - Cordis context (có `ctx.web.registerSearchProvider`).
 * @param {object} [config] - xem README + cordis.patch.yml.
 */
export function apply(ctx, config) {
  const entry = config ?? {}
  // Thunk, không phải value: `setSource` của settings đưa `() => T` (resolved
  // section lúc đang attach, composition entry lúc detach).
  let current = () => entry
  if (Config !== undefined) {
    ctx.inject?.(['settings'], (settingsCtx) => {
      try {
        settingsCtx.settings?.installSection?.(ctx, SETTINGS_NAMESPACE, Config, entry, {
          setSource: (source) => {
            current = source
          },
          onChange: () => {},
        })
      } catch {
        // Settings service lệch shape (hoặc thiếu) không được phép làm mất
        // provider registration bên dưới.
      }
    })
  }
  ctx.web.registerSearchProvider(
    new OpencodeStyleSearchProvider(
      () => resolveOptions(current()),
      () => currentAgent(ctx),
    ),
  )
}
