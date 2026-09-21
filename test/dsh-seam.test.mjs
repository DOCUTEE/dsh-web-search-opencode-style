/**
 * Integration test against the REAL DSH packages (cordis + @deepseek-ai/dsh-web),
 * unlike `plugin.test.mjs` which tests the ported opencode logic in isolation.
 *
 * Offline by default: the seam is real, the network is stubbed.
 * Set DSH_INTEGRATION=1 to hit the real Exa / Parallel MCP endpoints.
 *
 * Skips itself when no `dsh` install is discoverable on PATH.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as plugin from '../lib/index.js'

/** Locate the `@deepseek-ai` package directory of the installed harness. */
function dshPackagesDir() {
  let bin
  try {
    bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
  if (!bin) return undefined
  const pkgRoot = dirname(dirname(realpathSync(bin))) // <pkg>/lib/bin.js → <pkg>
  const dir = join(pkgRoot, 'node_modules', '@deepseek-ai')
  return existsSync(join(dir, 'dsh-web')) && existsSync(join(dir, 'cordis')) ? dir : undefined
}

const PACKAGES = dshPackagesDir()
const skip = PACKAGES === undefined ? 'no installed dsh found on PATH' : false

/** Backend selection falls back to config/env; these env vars would pin it. */
const selectionEnvFree = [
  'OPENCODE_WEBSEARCH_PROVIDER',
  'OPENCODE_ENABLE_EXA',
  'OPENCODE_ENABLE_PARALLEL',
  'OPENCODE_EXPERIMENTAL',
  'OPENCODE_EXPERIMENTAL_EXA',
  'OPENCODE_EXPERIMENTAL_PARALLEL',
].every((name) => process.env[name] === undefined)

const SSE_BODY = [
  'event: message',
  `data: ${JSON.stringify({
    result: {
      content: [
        {
          type: 'text',
          text: 'Title: Alpha\nURL: https://example.com/alpha\n\nTitle: Beta\nURL: https://example.com/beta',
        },
      ],
    },
  })}`,
  '',
].join('\n')

/** Mirrors cordis-plugin-loader `unwrapExports`: a default export wins over the namespace. */
function loaderExports(exports) {
  return exports.default ?? exports
}

/** Mount a real cordis context with the real web seam and this plugin. */
async function mount(config) {
  const { Context } = await import(`file://${PACKAGES}/cordis/lib/index.js`)
  const { default: WebRuntime } = await import(`file://${PACKAGES}/dsh-web/lib/index.js`)
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: plugin.PROVIDER_ID })
  // The loader validates a plugin's config against its exported `Config`, so the
  // tests pass the same shape the loader resolves.
  await ctx.plugin(loaderExports(plugin), config)
  return ctx
}

test('module exports survive the loader shape (default must not shadow metadata)', { skip }, () => {
  const exported = loaderExports(plugin)
  assert.equal(exported.name, plugin.name)
  assert.deepEqual(exported.inject, ['web'])
  assert.equal(exported.Config, plugin.Config)
  assert.equal(typeof exported.apply, 'function')
})

/** The exact config shape `cordis.patch.yml` composes, `!!js ... ?? undefined` included. */
const PATCH_ROW_CONFIG = {
  provider: process.env.OPENCODE_WEBSEARCH_PROVIDER ?? undefined,
  exaApiKey: process.env.EXA_API_KEY ?? undefined,
  parallelApiKey: process.env.PARALLEL_API_KEY ?? undefined,
  timeoutMs: 25000,
  numResults: 8,
}

test('registers into the real ctx.web seam and serves a search end to end', { skip }, async () => {
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) })
    return new Response(SSE_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const ctx = await mount({ ...PATCH_ROW_CONFIG, provider: 'exa' })
    const result = await ctx.web.search({ query: 'anything', maxResults: 8 })

    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, plugin.EXA_URL)
    assert.equal(seen[0].body.params.name, 'web_search_exa')
    assert.equal(seen[0].body.params.arguments.numResults, 8)

    assert.deepEqual(
      result.sources.map((source) => source.url),
      ['https://example.com/alpha', 'https://example.com/beta'],
    )
    assert.equal(result.truncated, false)
    assert.match(result.content, /Title: Alpha/u)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('flags truncation when sources were dropped to honor maxResults', { skip }, async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(SSE_BODY, { status: 200 })
  try {
    const ctx = await mount({ provider: 'exa' })
    const result = await ctx.web.search({ query: 'anything', maxResults: 1 })
    assert.equal(result.sources.length, 1)
    // Two sources were found, one kept: the tool now renders the "refine the
    // query" hint instead of silently dropping the rest.
    assert.equal(result.truncated, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sends the initiating agent identity to Parallel (session_id + model_name)', { skip }, async () => {
  const originalFetch = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (url, init) => {
    bodies.push({ url: String(url), args: JSON.parse(init.body).params.arguments })
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: 'URL: https://example.com/p' }] } }), {
      status: 200,
    })
  }
  try {
    const ctx = await mount({ provider: 'parallel' })
    const stop = ctx.provide('agents', {
      currentInitiator: () => ({ options: { model: 'deepseek-v4-flash' }, session: { id: 'ses_live_1' } }),
    })
    await ctx.web.search({ query: 'anything', maxResults: 3 })
    assert.equal(bodies[0].args.session_id, 'ses_live_1')
    assert.equal(bodies[0].args.model_name, 'deepseek-v4-flash')

    // No initiator (headless/sdk callers): model_name is omitted, session_id
    // falls back to the stable pseudo-session.
    stop()
    ctx.provide('agents', { currentInitiator: () => undefined })
    await ctx.web.search({ query: 'anything', maxResults: 3 })
    assert.equal('model_name' in bodies[1].args, false)
    assert.match(bodies[1].args.session_id, /^dsh_[0-9a-z]+$/u)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('picks the backend from the agent session, not the query', { skip: selectionEnvFree ? false : 'selection env vars are set' }, async () => {
  const originalFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: 'URL: https://example.com/p' }] } }), {
      status: 200,
    })
  }
  try {
    const sessionId = 'ses_seam_test'
    const bySession = plugin.selectProvider(sessionId)
    const query = Array.from({ length: 200 }, (_, i) => `seam query ${i}`).find((q) => plugin.selectProvider(q) !== bySession)
    assert.ok(query, 'phải tìm được query chọn backend khác session')

    const ctx = await mount({})
    ctx.provide('agents', { currentInitiator: () => ({ session: { id: sessionId } }) })
    await ctx.web.search({ query, maxResults: 1 })
    assert.deepEqual(urls, [bySession === 'exa' ? plugin.EXA_URL : plugin.PARALLEL_URL])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('selects the parallel backend when the query checksum says so', { skip }, async () => {
  const originalFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: 'URL: https://example.com/p' }] } }), {
      status: 200,
    })
  }
  try {
    const ctx = await mount({})
    await ctx.web.search({ query: 'anything', maxResults: 3 })
    const expected = plugin.selectProvider('anything') === 'exa' ? plugin.EXA_URL : plugin.PARALLEL_URL
    assert.deepEqual(urls, [expected])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('exposes its config as a settings namespace and reads writes back', { skip }, async (t) => {
  const { Context } = await import(`file://${PACKAGES}/cordis/lib/index.js`)
  const { default: WebRuntime } = await import(`file://${PACKAGES}/dsh-web/lib/index.js`)
  const { default: SettingsFile } = await import(`file://${PACKAGES}/dsh-settings-file/lib/index.js`)
  const settingsPath = new URL('../.tmp/settings.yaml', import.meta.url).pathname
  t.after(() => rmSync(dirname(settingsPath), { recursive: true, force: true }))

  const originalFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return new Response(SSE_BODY, { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const ctx = new Context()
  await ctx.plugin(SettingsFile, { path: settingsPath, watch: false })
  await ctx.plugin(WebRuntime, { searchProvider: plugin.PROVIDER_ID })
  await ctx.plugin(loaderExports(plugin), { numResults: 5 })

  const settings = ctx.get('settings')
  assert.ok(
    settings.describe().some((entry) => entry.ns === plugin.SETTINGS_NAMESPACE),
    'plugin must register its settings namespace',
  )
  assert.equal(settings.get(plugin.SETTINGS_NAMESPACE).numResults, 5, 'composition config is the base layer')
  assert.equal(settings.get(plugin.SETTINGS_NAMESPACE).enabled, true, 'schema defaults apply')
  // The wire surface (Settings page) describes namespaces with secrets redacted.
  const described = settings
    .describe({ redactSecrets: true })
    .find((entry) => entry.ns === plugin.SETTINGS_NAMESPACE)
  assert.ok(described?.schema, 'the descriptor must carry a JSON schema for the form')

  // The provider reads the live settings source, not a snapshot taken at load:
  // a write to the user layer must reach the next search.
  await settings.update(plugin.SETTINGS_NAMESPACE, { provider: 'parallel' })
  assert.equal(settings.get(plugin.SETTINGS_NAMESPACE).provider, 'parallel')
  await ctx.web.search({ query: 'anything', maxResults: 2 })
  assert.deepEqual(urls, [plugin.PARALLEL_URL], 'the settings write must reach the provider')
})

test('hits the real public MCP endpoints (opt-in)', { skip: process.env.DSH_INTEGRATION === '1' ? false : 'set DSH_INTEGRATION=1' }, async () => {
  for (const provider of ['exa', 'parallel']) {
    const ctx = await mount({ ...PATCH_ROW_CONFIG, provider })
    const result = await ctx.web.search({ query: 'latest AI news', maxResults: 8 })
    assert.ok(result.sources.length > 0, `${provider}: expected real sources`)
    for (const source of result.sources) {
      assert.match(source.url, /^https?:\/\//u)
      if (source.publishedAt !== undefined) assert.match(source.publishedAt, /^\d{4}-\d{2}-\d{2}/u)
    }
    const first = result.sources[0]
    assert.ok(first.title, `${provider}: title must come from the provider, not be dropped`)
    assert.notEqual(first.title, new URL(first.url).hostname, `${provider}: title must not be the hostname`)
    assert.ok(first.snippet, `${provider}: snippet must come from the provider excerpt`)
  }
})

test('still loads and registers with no schemastery and no settings service', { skip }, () => {
  const scratchHome = new URL('../.tmp/empty-home/', import.meta.url).pathname
  // A fresh process, because schemastery is resolved once at module load: an
  // empty $DSH_HOME makes both the bare specifier and the DSH fallback miss.
  const script = `
    const plugin = await import(${JSON.stringify(new URL('../lib/index.js', import.meta.url).href)})
    const registered = []
    plugin.apply({ web: { registerSearchProvider: (provider) => registered.push(provider) } }, { provider: 'exa' })
    if (plugin.Config !== undefined) throw new Error('Config should be undefined without schemastery')
    if (registered.length !== 1) throw new Error('provider must still register')
    if (registered[0].id !== 'opencode-style' || !registered[0].available()) throw new Error('provider must be usable')
    console.log('degraded-mode-ok')
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: scratchHome },
  })
  assert.match(output, /degraded-mode-ok/u)
})
