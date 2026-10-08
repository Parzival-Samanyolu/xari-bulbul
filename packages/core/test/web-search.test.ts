import { afterEach, describe, expect, it, vi } from 'vitest'
import { Permissions } from '../src/permissions/permissions.js'
import { defaultSettings } from '../src/settings/schema.js'
import { parseDuckDuckGo, search, webSearchTool } from '../src/tools/web-search.js'
import { ctx, tmpDir } from './helpers.js'

const DDG = `
<div class="result results_links results_links_deep web-result result--ad"><a class="result__a" href="https://ads.example">Ad</a></div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fvadimdemedes%2Fink&amp;rut=x">GitHub - <b>Ink</b>: React for CLIs</a></h2>
  <a class="result__snippet" href="x"><b>React</b> for CLIs &amp; more.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/b">Second &#39;one&#39;</a></h2>
</div>`

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('web search', () => {
  it('parses DuckDuckGo results, unwrapping redirects and skipping ads', () => {
    expect(parseDuckDuckGo(DDG)).toEqual([
      { title: 'GitHub - Ink: React for CLIs', url: 'https://github.com/vadimdemedes/ink', snippet: 'React for CLIs & more.' },
      { title: "Second 'one'", url: 'https://example.com/b', snippet: '' },
    ])
  })

  it('needs no key by default and returns numbered results with URLs', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(DDG, { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const r = await webSearchTool.execute({ query: 'ink react' }, ctx(tmpDir()))
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('1. GitHub - Ink: React for CLIs\n   https://github.com/vadimdemedes/ink')
    expect(fetch.mock.calls[0][0]).toBe('https://html.duckduckgo.com/html/')
  })

  it('calls Brave, Tavily and SearXNG with their keys and maps their results', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('brave')) return json({ web: { results: [{ title: 'B', url: 'https://b', description: '<strong>b</strong> text' }] } })
      if (url.includes('tavily')) return json({ results: [{ title: 'T', url: 'https://t', content: 't text' }] })
      return json({ results: [{ title: 'S', url: 'https://s', content: 's text' }] })
    })
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    expect(await search('q', 3, { backend: 'brave', searxngUrl: '', key: 'bk' }, signal)).toEqual([{ title: 'B', url: 'https://b', snippet: 'b text' }])
    expect((fetch.mock.calls[0][1]!.headers as Record<string, string>)['x-subscription-token']).toBe('bk')
    expect(await search('q', 3, { backend: 'tavily', searxngUrl: '', key: 'tk' }, signal)).toEqual([{ title: 'T', url: 'https://t', snippet: 't text' }])
    expect((fetch.mock.calls[1][1]!.headers as Record<string, string>).authorization).toBe('Bearer tk')
    expect(await search('q', 3, { backend: 'searxng', searxngUrl: 'https://sx.example/', key: undefined }, signal)).toEqual([{ title: 'S', url: 'https://s', snippet: 's text' }])
    expect(fetch.mock.calls[2][0]).toBe('https://sx.example/search?q=q&format=json')
  })

  it('explains what is missing instead of failing silently', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>unusual traffic</html>', { status: 200 })))
    const c = ctx(tmpDir())
    expect((await webSearchTool.execute({ query: 'x' }, c)).content).toMatch(/rate-limiting/)
    expect((await webSearchTool.execute({ query: 'x' }, { ...c, webSearch: { backend: 'brave', searxngUrl: '' } })).content).toMatch(/BRAVE_API_KEY/)
  })

  it('is read-only, so it never asks, even in Ask mode', () => {
    const p = new Permissions({ ...defaultSettings().permissions, mode: 'ask' }, '/w')
    expect(p.check(webSearchTool, 'anything').decision).toBe('allow')
    expect(p.check(webSearchTool, 'anything').decision).toBe('allow')
  })
})
