import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  checksum,
  selectProvider,
  parseMcpResponse,
  extractSources,
  extractAllSources,
  sourcesFromParallelJson,
  sourcesFromExaBlocks,
  textToResult,
  callMcp,
  OpencodeStyleSearchProvider,
  PROVIDER_ID,
  NO_RESULTS_TEXT,
} from '../lib/index.js'

describe('checksum (port opencode FNV-1a)', () => {
  it('stable + base36', () => {
    assert.equal(checksum('hello'), checksum('hello'))
    assert.match(checksum('hello'), /^[0-9a-z]+$/)
    assert.equal(checksum(''), undefined)
  })
})

describe('selectProvider (port opencode 50/50)', () => {
  const envKeys = ['OPENCODE_WEBSEARCH_PROVIDER', 'OPENCODE_ENABLE_EXA', 'OPENCODE_ENABLE_PARALLEL', 'OPENCODE_EXPERIMENTAL', 'OPENCODE_EXPERIMENTAL_EXA', 'OPENCODE_EXPERIMENTAL_PARALLEL']
  const withEnv = (values, run) => {
    const before = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
    for (const key of envKeys) delete process.env[key]
    Object.assign(process.env, values)
    try {
      return run()
    } finally {
      for (const key of envKeys) {
        if (before[key] === undefined) delete process.env[key]
        else process.env[key] = before[key]
      }
    }
  }

  it('cố định theo SESSION: mọi query trong 1 session đi cùng backend', () => {
    const sessionId = 'ses_abc123'
    const expected = selectProvider(sessionId)
    for (const query of ['one', 'two', 'three']) {
      assert.equal(selectProvider(sessionId), expected, `query ${query} không được đổi backend`)
    }
    // Đúng điều opencode làm: backend theo session, không theo query.
    const queries = Array.from({ length: 20 }, (_, i) => `q${i}`)
    assert.ok(new Set(queries.map((q) => selectProvider(q))).size > 1, 'nhiều query khác nhau phải rải ra 2 backend')
  })

  it('không có session -> fallback checksum(query), vẫn ổn định', () => {
    assert.equal(selectProvider('deepseek harness'), selectProvider('deepseek harness'))
    assert.ok(new Set(Array.from({ length: 50 }, (_, i) => selectProvider(`query ${i}`))).size === 2)
  })

  it('env OPENCODE_WEBSEARCH_PROVIDER thắng tất cả', () => {
    withEnv({ OPENCODE_WEBSEARCH_PROVIDER: 'parallel' }, () => {
      assert.equal(selectProvider('x', { provider: 'exa', enableExa: true }), 'parallel')
    })
  })

  it('config provider thắng flags', () => {
    withEnv({}, () => {
      assert.equal(selectProvider('x', { provider: 'exa', enableParallel: true }), 'exa')
      assert.equal(selectProvider('x', { provider: 'parallel', enableExa: true }), 'parallel')
    })
  })

  it('flags enableExa/enableParallel như RuntimeFlags của opencode', () => {
    withEnv({}, () => {
      assert.equal(selectProvider('x', { enableExa: true }), 'exa')
      assert.equal(selectProvider('x', { enableParallel: true }), 'parallel')
    })
    withEnv({ OPENCODE_ENABLE_EXA: 'true' }, () => assert.equal(selectProvider('x'), 'exa'))
    withEnv({ OPENCODE_ENABLE_PARALLEL: '1' }, () => assert.equal(selectProvider('x'), 'parallel'))
    withEnv({ OPENCODE_EXPERIMENTAL: 'yes' }, () => assert.equal(selectProvider('x'), 'exa'), 'OPENCODE_EXPERIMENTAL bật exa')
    withEnv({ OPENCODE_ENABLE_EXA: 'false' }, () => assert.notEqual(selectProvider('x', { enableExa: false }), undefined))
  })
})

describe('parseMcpResponse (port opencode)', () => {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'search results' }] } })
  it('JSON thuần', () => assert.equal(parseMcpResponse(payload), 'search results'))
  it('SSE + bỏ frame [DONE]', () => {
    assert.equal(parseMcpResponse(`event: message\ndata: ${payload}\n\n`), 'search results')
    assert.equal(parseMcpResponse(`data: [DONE]\ndata: ${payload}\n\n`), 'search results')
  })
  it('rỗng = undefined', () => assert.equal(parseMcpResponse(''), undefined))
  it('kết quả rỗng (isError:true) vẫn là content, như opencode', () => {
    const body = JSON.stringify({ result: { content: [{ type: 'text', text: 'MCP error -32602: Tool not found' }], isError: true } })
    assert.equal(parseMcpResponse(body), 'MCP error -32602: Tool not found')
  })

  // opencode decode payload `{…}` bằng schema nên payload sai là LỖI, không
  // phải "không có kết quả" — plugin ném WebError tương ứng.
  it('JSON-RPC error -> ném lỗi (không im lặng thành no results)', () => {
    const body = '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad args"}}'
    assert.throws(() => parseMcpResponse(body), (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_ERROR')
      assert.match(error.message, /JSON-RPC error -32602: bad args/u)
      return true
    })
  })
  it('JSON hợp lệ nhưng thiếu result.content -> ném lỗi', () => {
    assert.throws(() => parseMcpResponse('{"jsonrpc":"2.0","id":1}'), /without result\.content/u)
  })
})

describe('extractSources (bước chuyển duy nhất cho DSH seam)', () => {
  it('bóc markdown link + bare url, dedupe', () => {
    const text = 'See [Exa](https://exa.ai) and https://example.com/a, again https://example.com/a.'
    const sources = extractSources(text, 8)
    assert.equal(sources.length, 2)
    assert.equal(sources[0].url, 'https://exa.ai')
    assert.equal(sources[0].title, 'Exa')
    assert.equal(sources[1].url, 'https://example.com/a')
  })
  it('text không url -> content giữ, sources rỗng', () => {
    const r = textToResult('just some context without links', 8)
    assert.equal(r.content.includes('just some'), true)
    assert.deepEqual(r.sources, [])
  })
})

describe('parse có cấu trúc (title/ngày thật thay vì hostname)', () => {
  // Nguyên văn `result.content[0].text` của Parallel (rút gọn excerpts).
  const parallelJson = JSON.stringify({
    search_id: 'search_x',
    results: [
      {
        url: 'https://aibusiness.com/companies',
        title: 'Companies recent news | AI Business',
        publish_date: '2026-09-18',
        excerpts: ['Jul 27, 2026\n2 Min Read\nData'],
      },
      { url: 'https://platform.tracxn.com/a/d/company/65a4?utm_source=parallel#a:about', title: 'Ai Latest News', publish_date: null, excerpts: [] },
    ],
  })

  it('Parallel JSON -> title, publish_date, excerpt', () => {
    const sources = sourcesFromParallelJson(parallelJson)
    assert.equal(sources.length, 2)
    assert.deepEqual(sources[0], {
      url: 'https://aibusiness.com/companies',
      title: 'Companies recent news | AI Business',
      snippet: 'Jul 27, 2026 2 Min Read Data',
      publishedAt: '2026-09-18',
    })
    assert.equal(sources[1].publishedAt, undefined, 'publish_date null -> bỏ field')
    assert.equal(sources[1].snippet, undefined, 'excerpts rỗng -> bỏ field')
  })

  it('text không phải JSON results -> undefined (nhường fallback)', () => {
    assert.equal(sourcesFromParallelJson('not json'), undefined)
    assert.equal(sourcesFromParallelJson('{"foo":1}'), undefined)
  })

  // Nguyên văn format block của Exa.
  const exaText = [
    'Title: Ten days that changed the course of AI | Reuters',
    'URL: https://www.reuters.com/business/media-telecom/ten-days-2026-09-19/',
    'Published: 2026-09-19T10:05:43.000Z',
    'Author: Greg Bensinger',
    'Highlights:',
    'Ten days that changed the course of AI | Reuters',
    '...',
    '# Ten days that changed the course of AI',
    '...',
    '- OpenAI and Anthropic staff privately questioned oversight',
    '',
    'Title: Cordis Primer | DeepSeek Harness',
    'URL: https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-primer',
    'Published: N/A',
    'Author: N/A',
    'Highlights:',
    'Cordis is the vendored plugin framework underneath DeepSeek Harness.',
  ].join('\n')

  it('Exa block -> title, publishedAt ISO, highlights làm snippet', () => {
    const sources = sourcesFromExaBlocks(exaText)
    assert.equal(sources.length, 2)
    assert.deepEqual(sources[0], {
      url: 'https://www.reuters.com/business/media-telecom/ten-days-2026-09-19/',
      title: 'Ten days that changed the course of AI | Reuters',
      snippet:
        'Ten days that changed the course of AI | Reuters Ten days that changed the course of AI - OpenAI and Anthropic staff privately questioned oversight',
      publishedAt: '2026-09-19T10:05:43.000Z',
    })
    assert.equal(sources[1].publishedAt, undefined, '"Published: N/A" -> bỏ field')
  })

  it('extractAllSources ưu tiên bản có cấu trúc, không nhân đôi URL', () => {
    const sources = extractAllSources(exaText)
    assert.equal(sources.length, 2)
    assert.equal(sources[0].title, 'Ten days that changed the course of AI | Reuters')
  })

  it('vẫn quét URL thô khi text không có format nào', () => {
    const sources = extractAllSources('See [Exa](https://exa.ai) and https://example.com/a')
    assert.deepEqual(
      sources.map((source) => source.url),
      ['https://exa.ai', 'https://example.com/a'],
    )
  })
})

describe('textToResult (giữ nguyên text cho model như opencode)', () => {
  it('KHÔNG cắt content ở 20k nữa', () => {
    const text = `${'x'.repeat(30000)}\nURL: https://example.com/big`
    const r = textToResult(text, 8)
    assert.equal(r.content.length, text.length)
  })

  it('truncated bật khi phải bỏ bớt source vì maxResults', () => {
    const text = Array.from({ length: 5 }, (_, i) => `URL: https://example.com/${i}`).join('\n')
    assert.equal(textToResult(text, 5).truncated, false)
    const capped = textToResult(text, 2)
    assert.equal(capped.sources.length, 2)
    assert.equal(capped.truncated, true)
  })

  it('không có kết quả -> đúng câu opencode trả', () => {
    assert.deepEqual(textToResult('', 8), { content: NO_RESULTS_TEXT, sources: [], truncated: false })
    assert.deepEqual(textToResult(undefined, 8), { content: NO_RESULTS_TEXT, sources: [], truncated: false })
  })
})

describe('phân loại lỗi (timeout khác abort)', () => {
  /** fetch giả treo tới khi bị abort, giữ event loop sống như socket thật. */
  const hangingFetch = () => (url, init) =>
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('never settles')), 5000)
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('aborted', 'AbortError'))
      })
    })

  it('provider timeout -> WEB_SEARCH_TIMEOUT, message y opencode', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = hangingFetch()
    try {
      await assert.rejects(callMcp('https://mcp.exa.ai/mcp', 'web_search_exa', {}, { timeoutMs: 20 }), (error) => {
        assert.equal(error.code, 'WEB_SEARCH_TIMEOUT')
        assert.equal(error.message, 'web_search_exa request timed out')
        return true
      })
    } finally {
      globalThis.fetch = orig
    }
  })

  it('caller huỷ -> WEB_ABORTED', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = hangingFetch()
    const controller = new AbortController()
    const pending = callMcp('https://mcp.exa.ai/mcp', 'web_search_exa', {}, { timeoutMs: 25000, signal: controller.signal })
    controller.abort()
    try {
      await assert.rejects(pending, (error) => {
        assert.equal(error.code, 'WEB_ABORTED')
        return true
      })
    } finally {
      globalThis.fetch = orig
    }
  })

  it('HTTP 500 -> WEB_PROVIDER_ERROR (kèm endpoint)', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = async () => new Response('nope', { status: 500 })
    try {
      await assert.rejects(callMcp('https://mcp.exa.ai/mcp', 'web_search_exa', {}), (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_ERROR')
        assert.match(error.message, /HTTP 500 from https:\/\/mcp\.exa\.ai\/mcp/u)
        return true
      })
    } finally {
      globalThis.fetch = orig
    }
  })
})

describe('OpencodeStyleSearchProvider', () => {
  it('id ổn định + available mặc định true', () => {
    const p = new OpencodeStyleSearchProvider(() => ({}))
    assert.equal(p.id, PROVIDER_ID)
    assert.equal(p.available(), true)
  })
  it('enabled:false -> unavailable', () => {
    assert.equal(new OpencodeStyleSearchProvider(() => ({ enabled: false })).available(), false)
  })
  it('query rỗng -> lỗi rõ ràng', async () => {
    await assert.rejects(new OpencodeStyleSearchProvider(() => ({})).search({ query: '  ' }), /non-empty/)
  })
  it('đi đúng backend exa/parallel theo override (mock fetch)', async () => {
    const calls = []
    const orig = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      const text = `Result from ${url} — see https://example.com/${calls.length}`
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }) }
    }
    try {
      const exa = new OpencodeStyleSearchProvider(() => ({ provider: 'exa' }))
      const r1 = await exa.search({ query: 'q', maxResults: 5 })
      assert.equal(calls[0].body.params.name, 'web_search_exa')
      assert.equal(calls[0].body.params.arguments.query, 'q')
      assert.equal(r1.sources[0].url, 'https://example.com/1')

      const par = new OpencodeStyleSearchProvider(() => ({ provider: 'parallel', parallelApiKey: 'secret' }))
      const r2 = await par.search({ query: 'q2', maxResults: 5 })
      assert.equal(calls[1].body.params.name, 'web_search')
      assert.deepEqual(calls[1].body.params.arguments.search_queries, ['q2'])
      assert.equal(r2.sources[0].url, 'https://example.com/2')
    } finally {
      globalThis.fetch = orig
    }
  })

  it('gửi session_id/model_name của agent, đúng field opencode gửi Parallel', async () => {
    const calls = []
    const orig = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body).params.arguments)
      return { ok: true, text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: 'URL: https://example.com/x' }] } }) }
    }
    try {
      const withAgent = new OpencodeStyleSearchProvider(() => ({ provider: 'parallel' }), () => ({
        sessionId: 'ses_123',
        modelName: 'deepseek-v4-flash',
      }))
      await withAgent.search({ query: 'q', maxResults: 3 })
      assert.equal(calls[0].session_id, 'ses_123')
      assert.equal(calls[0].model_name, 'deepseek-v4-flash')

      const noAgent = new OpencodeStyleSearchProvider(() => ({ provider: 'parallel' }))
      await noAgent.search({ query: 'q', maxResults: 3 })
      assert.equal(calls[1].session_id, `dsh_${checksum('q')}`, 'không có session -> pseudo-session ổn định')
      assert.equal('model_name' in calls[1], false)
    } finally {
      globalThis.fetch = orig
    }
  })

  it('numResults: request || config || 8, không clamp (như opencode)', async () => {
    const calls = []
    const orig = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body).params.arguments.numResults)
      return { ok: true, text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: 'URL: https://example.com/x' }] } }) }
    }
    try {
      const search = (request, cfg) => new OpencodeStyleSearchProvider(() => ({ provider: 'exa', ...cfg })).search(request)
      await search({ query: 'q', maxResults: 5 })
      await search({ query: 'q', maxResults: 0 }, { numResults: 3 })
      await search({ query: 'q' }, { numResults: 3 })
      await search({ query: 'q' })
      await search({ query: 'q', maxResults: 40 })
      assert.deepEqual(calls, [5, 3, 3, 8, 40])
    } finally {
      globalThis.fetch = orig
    }
  })

  it('session quyết định backend, không phải query (như opencode)', async () => {
    const calls = []
    const orig = globalThis.fetch
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return { ok: true, text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: 'URL: https://example.com/x' }] } }) }
    }
    try {
      const sessionId = 'ses_pick_me'
      const sessionBackend = selectProvider(sessionId)
      const otherQuery = Array.from({ length: 50 }, (_, i) => `query-${i}`).find((q) => selectProvider(q) !== sessionBackend)
      assert.ok(otherQuery, 'phải tìm được query chọn backend khác')
      const provider = new OpencodeStyleSearchProvider(() => ({}), () => ({ sessionId }))
      await provider.search({ query: otherQuery, maxResults: 1 })
      assert.equal(calls[0], sessionBackend === 'exa' ? 'https://mcp.exa.ai/mcp' : 'https://search.parallel.ai/mcp')
    } finally {
      globalThis.fetch = orig
    }
  })
})
