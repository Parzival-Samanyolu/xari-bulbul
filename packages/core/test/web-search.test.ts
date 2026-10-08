import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Permissions } from '../src/permissions/permissions.js'
import { defaultSettings } from '../src/settings/schema.js'
import { htmlToText, webFetchTool } from '../src/tools/web-fetch.js'
import { looksUnrelated, parseBraveWeb, parseDuckDuckGo, resetSearchState, search, webSearchTool } from '../src/tools/web-search.js'
import { ctx, tmpDir } from './helpers.js'

const DDG = `
<div class="result results_links results_links_deep web-result result--ad"><a class="result__a" href="https://ads.example">Ad</a></div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fvadimdemedes%2Fink&amp;rut=x">GitHub - <b>Ink</b>: React for CLIs</a></h2>
  <a class="result__snippet" href="x"><b>React</b> for CLIs &amp; more.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/b">Second &#39;one&#39; about ink</a></h2>
</div>`

const BRAVE_PAGE = `<section id="mixed-main">
<div class="snippet svelte-x" data-pos="0" data-type="web"><div class="result-content"><a href="https://nodejs.org/en/about/previous-releases" class="svelte-y l1"><cite>nodejs.org</cite>
<div class="title search-snippet-title line-clamp-1 svelte-z" title="Node.js — Node.js Releases">Node.js — Node.js Releases</div></a>
<div class="generic-snippet"><div class="content desktop-default-regular t-primary svelte-q">Major Node.js versions enter <strong>Current</strong> release status.</div></div></div></div>
<div class="snippet svelte-x" data-pos="1" data-type="web"><div class="result-content"><a href="https://endoflife.date/nodejs" class="l1">
<div class="title search-snippet-title" title="Node.js | endoflife.date">Node.js | endoflife.date</div></a>
<div class="generic-snippet"><div class="content t-primary">Check end-of-life for Node.js release.</div></div></div></div>`

const DDG_BLOCKED = '<html><div class="anomaly-modal__box">Unfortunately, bots use DuckDuckGo too.</div></html>'
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } })
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(() => resetSearchState({ gapMs: 0 }))
afterEach(() => vi.unstubAllGlobals())

describe('search result parsers', () => {
  it('parses DuckDuckGo, unwrapping redirects and skipping ads', () => {
    expect(parseDuckDuckGo(DDG)).toEqual([
      { title: 'GitHub - Ink: React for CLIs', url: 'https://github.com/vadimdemedes/ink', snippet: 'React for CLIs & more.' },
      { title: "Second 'one' about ink", url: 'https://example.com/b', snippet: '' },
    ])
  })

  it("parses Brave's public results page", () => {
    expect(parseBraveWeb(BRAVE_PAGE)).toEqual([
      { title: 'Node.js — Node.js Releases', url: 'https://nodejs.org/en/about/previous-releases', snippet: 'Major Node.js versions enter Current release status.' },
      { title: 'Node.js | endoflife.date', url: 'https://endoflife.date/nodejs', snippet: 'Check end-of-life for Node.js release.' },
    ])
  })

  it('spots results that have nothing to do with the query', () => {
    const junk = [
      { title: 'Best lunch boxes of 2026', url: 'https://food.example/a', snippet: 'Tested and reviewed' },
      { title: 'Watch movies online', url: 'https://movies.example', snippet: 'Free HD streaming' },
      { title: 'Lunch box reviews', url: 'https://x.example', snippet: '' },
    ]
    expect(looksUnrelated('node.js release schedule', junk)).toBe(true)
    expect(looksUnrelated('ink react', parseDuckDuckGo(DDG))).toBe(false)
  })
})

describe('web_search', () => {
  it('works with no key: DuckDuckGo first', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => html(DDG))
    vi.stubGlobal('fetch', fetch)
    const r = await webSearchTool.execute({ query: 'ink react' }, ctx(tmpDir()))
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('1. GitHub - Ink: React for CLIs\n   https://github.com/vadimdemedes/ink')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("falls back to Brave's public page when DuckDuckGo blocks, then skips DuckDuckGo for a while", async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => (url.includes('duckduckgo') ? html(DDG_BLOCKED, 202) : html(BRAVE_PAGE)))
    vi.stubGlobal('fetch', fetch)
    const r = await webSearchTool.execute({ query: 'node.js release' }, ctx(tmpDir()))
    expect(r.content).toContain('https://nodejs.org/en/about/previous-releases')
    await webSearchTool.execute({ query: 'node.js release schedule' }, ctx(tmpDir()))
    expect(fetch.mock.calls.filter(([u]) => String(u).includes('duckduckgo'))).toHaveLength(1)
  })

  it('treats unrelated results as a block instead of passing them on', async () => {
    const junk = BRAVE_PAGE.replace(/Node\.js|nodejs|release|endoflife/gi, 'Lunchbox')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('duckduckgo') ? html(DDG_BLOCKED, 202) : html(junk))))
    const r = await webSearchTool.execute({ query: 'node.js release' }, ctx(tmpDir()))
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/free search engines .* blocking/)
    expect(r.content).toMatch(/Brave Search or Tavily key/)
  })

  it('uses free-tier API keys first in automatic mode', async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => (url.includes('tavily') ? json({ results: [{ title: 'T', url: 'https://t.example', content: 'about ink' }] }) : html(DDG)))
    vi.stubGlobal('fetch', fetch)
    const c = { ...ctx(tmpDir()), webSearch: { backend: 'auto' as const, searxngUrl: '', keys: { tavily: 'tk' } } }
    const r = await webSearchTool.execute({ query: 'ink' }, c)
    expect(r.content).toContain('https://t.example')
    expect(fetch.mock.calls.map(([u]) => String(u))).toEqual(['https://api.tavily.com/search'])
  })

  it('calls Brave, Tavily and SearXNG with their keys and options', async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('brave')) return json({ web: { results: [{ title: 'B', url: 'https://b', description: '<strong>b</strong> text' }] } })
      if (url.includes('tavily')) return json({ results: [{ title: 'T', url: 'https://t', content: 't text' }] })
      return json({ results: [{ title: 'S', url: 'https://s', content: 's text' }] })
    })
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    expect(await search('q', { max: 3, recency: 'week' }, { backend: 'brave', searxngUrl: '', key: 'bk' }, signal)).toEqual([{ title: 'B', url: 'https://b', snippet: 'b text' }])
    expect(String(fetch.mock.calls[0][0])).toContain('freshness=pw')
    expect((fetch.mock.calls[0][1]!.headers as Record<string, string>)['x-subscription-token']).toBe('bk')
    await search('q', { max: 3, allowedDomains: ['t'] }, { backend: 'tavily', searxngUrl: '', key: 'tk' }, signal)
    expect(JSON.parse(String(fetch.mock.calls[1][1]!.body))).toMatchObject({ query: 'q', include_domains: ['t'] })
    await search('q', 3, { backend: 'searxng', searxngUrl: 'https://sx.example/' }, signal)
    expect(fetch.mock.calls[2][0]).toBe('https://sx.example/search?q=q&format=json')
  })

  it('applies domain filters to the query and to the results', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => html(DDG))
    vi.stubGlobal('fetch', fetch)
    const r = await webSearchTool.execute({ query: 'ink', allowed_domains: ['https://www.github.com/'], recency: 'month' }, ctx(tmpDir()))
    const body = String(fetch.mock.calls[0][1]!.body)
    expect(decodeURIComponent(body.replace(/\+/g, ' '))).toContain('q=ink site:github.com')
    expect(body).toContain('df=m')
    expect(r.content).toContain('github.com/vadimdemedes/ink')
    expect(r.content).not.toContain('example.com')
  })

  it('serves a repeated search from memory', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => html(DDG))
    vi.stubGlobal('fetch', fetch)
    await webSearchTool.execute({ query: 'ink react' }, ctx(tmpDir()))
    await webSearchTool.execute({ query: 'ink react' }, ctx(tmpDir()))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('says what is missing for keyed backends', async () => {
    const c = { ...ctx(tmpDir()), webSearch: { backend: 'brave' as const, searxngUrl: '' } }
    expect((await webSearchTool.execute({ query: 'x' }, c)).content).toMatch(/BRAVE_API_KEY/)
  })

  it('is read-only, so it never asks, even in Ask mode', () => {
    const p = new Permissions({ ...defaultSettings().permissions, mode: 'ask' }, '/w')
    expect(p.check(webSearchTool, 'anything').decision).toBe('allow')
  })
})

describe('web_fetch', () => {
  const PAGE = `<html><head><title>Guide &amp; docs</title><script>var x = "<b>"</script></head><body>
    <header><a href="/">Home</a></header>
    <nav><ul><li><a href="/a">A</a></li></ul></nav>
    <main data-x='a > b'>
      <h1>Install</h1>
      <p>Run the <code>setup</code> command. See <a href="/docs/more">more docs</a>.</p>
      <pre><code class="language-bash">npm i ink
npm test</code></pre>
      <ul>${Array.from({ length: 15 }, (_, i) => `<li><a href="/p${i}">Page ${i}</a></li>`).join('')}</ul>
      <ul><li>Fast</li><li>Small</li></ul>
    </main>
    <footer>© 2026</footer></body></html>`

  it('keeps the main content as Markdown and drops page chrome', () => {
    const md = htmlToText(PAGE, 'https://site.example/guide')
    expect(md).toContain('# Install')
    expect(md).toContain('Run the `setup` command. See [more docs](https://site.example/docs/more).')
    expect(md).toContain('```bash\nnpm i ink\nnpm test\n```')
    expect(md).toContain('- Fast\n- Small')
    for (const chrome of ['Home', '© 2026', 'Page 3', 'var x', 'a > b']) expect(md).not.toContain(chrome)
  })

  it('reads long pages in parts and reports redirects', async () => {
    const long = `<main>${Array.from({ length: 400 }, (_, i) => `<p>Paragraph number ${i} with some words in it.</p>`).join('')}</main>`
    const res = Object.assign(html(long), {})
    Object.defineProperty(res, 'url', { value: 'https://site.example/final' })
    vi.stubGlobal('fetch', vi.fn(async () => res))
    const c = ctx(tmpDir(), { toolOutputMaxChars: 5000 })
    const first = await webFetchTool.execute({ url: 'https://site.example/start' }, c)
    expect(first.content).toContain('(redirected to https://site.example/final)')
    const next = /start=(\d+)/.exec(first.content)![1]
    const second = await webFetchTool.execute({ url: 'https://site.example/start', start: Number(next) }, c)
    expect(second.content).toContain(`Showing characters ${next}–`)
    expect(second.content).not.toContain('Paragraph number 0 ')
  })

  it('refuses binary content with a clear message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'content-type': 'application/pdf' } })))
    const r = await webFetchTool.execute({ url: 'https://site.example/file.pdf' }, ctx(tmpDir()))
    expect(r.isError).toBe(true)
    expect(r.content).toContain('application/pdf')
  })
})
