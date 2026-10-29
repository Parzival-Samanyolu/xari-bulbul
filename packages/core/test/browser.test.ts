import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agent } from '../src/loop/agent.js'
import { Permissions } from '../src/permissions/permissions.js'
import { toAnthropicMessages } from '../src/providers/anthropic.js'
import { wireMessages } from '../src/providers/openai-compat.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { newSession } from '../src/sessions/store.js'
import { defaultSettings } from '../src/settings/schema.js'
import {
  BrowserHost,
  SNAPSHOT_SCRIPT,
  browserCandidates,
  browserReadTool,
  browserTool,
  findBrowser,
  formatSnapshot,
  normalizeUrl,
  parseKey,
  type BrowserAccess,
  type SnapshotData,
} from '../src/tools/browser.js'
import { builtinTools } from '../src/tools/index.js'
import { defineTool } from '../src/tools/types.js'
import type { ChatMessage } from '../src/types.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { MockProvider, ctx, tmpDir } from './helpers.js'
import { z } from 'zod'

type Handler = (params: any, ws: FakeSocket) => unknown

/** A WebSocket that answers CDP calls from `handlers` and records them. */
class FakeSocket extends EventTarget {
  static handlers: Record<string, Handler> = {}
  static sent: { method: string; params: any }[] = []
  static last: FakeSocket | null = null
  constructor(readonly url: string) {
    super()
    FakeSocket.last = this
    setTimeout(() => this.dispatchEvent(new Event('open')))
  }
  send(raw: string) {
    const { id, method, params } = JSON.parse(raw)
    FakeSocket.sent.push({ method, params })
    const h = FakeSocket.handlers[method]
    setTimeout(() => {
      try {
        const result = h ? h(params, this) : {}
        this.reply({ id, result: result ?? {} })
      } catch (e) {
        this.reply({ id, error: { message: (e as Error).message } })
      }
    })
  }
  emit(method: string, params: unknown = {}) {
    setTimeout(() => this.reply({ method, params }))
  }
  private reply(msg: unknown) {
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(msg) }))
  }
  close() {
    this.dispatchEvent(new Event('close'))
  }
}

const SNAP: SnapshotData = {
  url: 'http://localhost:3000/',
  title: 'Todo',
  text: 'Todo\n\n  Add an item   below\n',
  elements: [
    { ref: 1, tag: 'input', type: 'text', name: 'New item', value: 'milk' },
    { ref: 2, tag: 'button', name: 'Add' },
    { ref: 3, tag: 'a', name: 'About', href: '/about' },
    { ref: 4, tag: 'input', type: 'checkbox', name: 'Done', checked: true, disabled: true },
  ],
  more: 0,
}

/** Evaluates the scripts the tools send with canned answers. */
function evaluate(params: { expression: string }) {
  const e = params.expression
  if (e === SNAPSHOT_SCRIPT) return { result: { value: SNAP } }
  if (e === 'document.readyState') return { result: { value: 'complete' } }
  if (e.includes('location.href') && e.startsWith('({')) return { result: { value: { title: 'Todo', url: 'http://localhost:3000/' } } }
  if (e.includes('[data-xb-ref="9"]')) return { result: { value: e.includes('getBoundingClientRect') ? null : false } }
  if (e.includes('getBoundingClientRect')) return { result: { value: { x: 50, y: 60, w: 20, h: 10 } } }
  if (e.includes('el.focus()')) return { result: { value: true } }
  if (e === 'boom()') return { exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: boom is not defined' } } }
  if (e === '1 + 1') return { result: { value: 2 } }
  return { result: { value: { ok: true } } }
}

function setupBrowser(vision = true) {
  FakeSocket.sent = []
  FakeSocket.handlers = {
    'Runtime.evaluate': evaluate,
    'Page.navigate': (p, ws) => {
      if (p.url.includes('nowhere')) return { errorText: 'net::ERR_NAME_NOT_RESOLVED' }
      ws.emit('Page.loadEventFired')
      return { frameId: 'f' }
    },
    'Page.getNavigationHistory': () => ({ currentIndex: 1, entries: [{ id: 7 }, { id: 8 }] }),
    'Page.navigateToHistoryEntry': (_p, ws) => ws.emit('Page.loadEventFired'),
    'Page.captureScreenshot': () => ({ data: 'SU1H' }),
  }
  vi.stubGlobal('WebSocket', FakeSocket)
  const fetch = vi.fn(async (url: string) => {
    expect(url).toBe('http://127.0.0.1:9333/json/list')
    return Response.json([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/A' }])
  })
  vi.stubGlobal('fetch', fetch)
  const close = vi.fn()
  const launch = vi.fn(async () => ({ port: 9333, close }))
  const host = new BrowserHost({ headless: true }, launch)
  const access: BrowserAccess = {
    page: (signal) => host.getPage(signal),
    get running() {
      return host.running
    },
    vision,
  }
  return { host, launch, close, c: ctx(tmpDir(), { browser: access }) }
}

const methods = () => FakeSocket.sent.map((s) => s.method)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser snapshot formatting', () => {
  it('lists numbered elements, then the visible text', () => {
    expect(formatSnapshot(SNAP, 10_000)).toBe(
      [
        'Page: Todo',
        'URL: http://localhost:3000/',
        '',
        'Interactive elements (pass the number as ref):',
        '[1] input[text] "New item" value="milk"',
        '[2] button "Add"',
        '[3] link "About" → /about',
        '[4] checkbox "Done" (checked) (disabled)',
        '',
        'Text:',
        'Todo',
        'Add an item below',
      ].join('\n'),
    )
  })

  it('notes elements past the limit and truncates long text', () => {
    const out = formatSnapshot({ url: 'u', title: '', text: 'x'.repeat(5000), elements: [], more: 3 }, 1500)
    expect(out).toContain('Page: (untitled)')
    expect(out).toContain('No interactive elements.')
    expect(out).toContain('characters truncated')
    expect(formatSnapshot({ ...SNAP, more: 12 }, 10_000)).toContain('… 12 more not numbered')
  })
})

describe('browser helpers', () => {
  it('parses keys and shortcuts', () => {
    expect(parseKey('Enter')).toMatchObject({ key: 'Enter', keyCode: 13, text: '\r', modifiers: 0 })
    expect(parseKey('a')).toMatchObject({ key: 'a', code: 'KeyA', text: 'a' })
    const sel = parseKey('Control+a')!
    expect(sel).toMatchObject({ key: 'a', modifiers: 2 })
    expect(sel.text).toBeUndefined()
    expect(parseKey('Shift+Tab')).toMatchObject({ key: 'Tab', modifiers: 8 })
    expect(parseKey('+')).toMatchObject({ key: '+', text: '+' })
    expect(parseKey('Shift++')).toMatchObject({ key: '+', modifiers: 8 })
    expect(parseKey('Hyper+x')).toBeNull()
    expect(parseKey('F13x')).toBeNull()
  })

  it('normalizes URLs', () => {
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeUrl('example.com/a')).toBe('http://example.com/a')
    expect(normalizeUrl('file:///tmp/a.html')).toBe('file:///tmp/a.html')
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('chrome://settings')).toBeNull()
  })

  it('finds browsers at their usual paths per OS', () => {
    expect(browserCandidates('darwin', { HOME: '/Users/x' })).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files' })).toContain('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')
    expect(browserCandidates('linux', { PATH: '/opt/bin' })).toContain(path.join('/opt/bin', 'chromium'))
    const exe = path.join(tmpDir(), 'chrome')
    fs.writeFileSync(exe, '')
    expect(findBrowser(exe)).toBe(exe)
    expect(findBrowser(path.join(tmpDir(), 'missing'))).toBeNull()
  })
})

describe('browser tools', () => {
  it('launches on first use, opens a page and returns its snapshot', async () => {
    const { c, launch, host, close } = setupBrowser()
    const res = await browserTool.execute(browserTool.parse({ action: 'open', url: 'localhost:3000' }), c)
    expect(res.isError).toBeFalsy()
    expect(res.content).toContain('[2] button "Add"')
    expect(FakeSocket.sent.find((s) => s.method === 'Page.navigate')?.params).toEqual({ url: 'http://localhost:3000' })
    expect(methods().slice(0, 2)).toEqual(['Page.enable', 'Runtime.enable'])
    await browserReadTool.execute(browserReadTool.parse({ action: 'snapshot' }), c)
    expect(launch).toHaveBeenCalledTimes(1)
    host.close()
    expect(close).toHaveBeenCalled()
    expect(host.running).toBe(false)
  })

  it('reports pages that fail to load', async () => {
    const { c } = setupBrowser()
    const res = await browserTool.execute(browserTool.parse({ action: 'open', url: 'http://nowhere.invalid' }), c)
    expect(res).toMatchObject({ isError: true, content: expect.stringContaining('ERR_NAME_NOT_RESOLVED') })
  })

  it('clicks an element by ref with real mouse events', async () => {
    const { c } = setupBrowser()
    const res = await browserTool.execute(browserTool.parse({ action: 'click', ref: 2 }), c)
    expect(res.content).toContain('Clicked [2]. Now on: Todo (http://localhost:3000/)')
    const mouse = FakeSocket.sent.filter((s) => s.method === 'Input.dispatchMouseEvent').map((s) => s.params.type)
    expect(mouse).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(FakeSocket.sent.find((s) => s.params.type === 'mousePressed')?.params).toMatchObject({ x: 50, y: 60, button: 'left' })
  })

  it('tells the model to take a new snapshot when a ref is gone', async () => {
    const { c } = setupBrowser()
    const click = await browserTool.execute(browserTool.parse({ action: 'click', ref: 9 }), c)
    expect(click).toMatchObject({ isError: true, content: expect.stringContaining('No element [9]') })
    const type = await browserTool.execute(browserTool.parse({ action: 'type', ref: 9, text: 'x' }), c)
    expect(type.isError).toBe(true)
  })

  it('types over a field and submits with Enter', async () => {
    const { c } = setupBrowser()
    const res = await browserTool.execute(browserTool.parse({ action: 'type', ref: 1, text: 'eggs', submit: true }), c)
    expect(res.content).toContain('Typed into [1] and pressed Enter')
    expect(FakeSocket.sent.find((s) => s.method === 'Input.insertText')?.params).toEqual({ text: 'eggs' })
    const keys = FakeSocket.sent.filter((s) => s.method === 'Input.dispatchKeyEvent').map((s) => [s.params.type, s.params.key])
    expect(keys).toEqual([
      ['keyDown', 'Enter'],
      ['keyUp', 'Enter'],
    ])
  })

  it('presses shortcuts without typing text', async () => {
    const { c } = setupBrowser()
    await browserTool.execute(browserTool.parse({ action: 'press', key: 'Control+a' }), c)
    const down = FakeSocket.sent.find((s) => s.method === 'Input.dispatchKeyEvent')!.params
    expect(down).toMatchObject({ type: 'rawKeyDown', key: 'a', modifiers: 2 })
    expect(down.text).toBeUndefined()
    const bad = await browserTool.execute(browserTool.parse({ action: 'press', key: 'Hyper+q' }), c)
    expect(bad.isError).toBe(true)
  })

  it('goes back through history', async () => {
    const { c } = setupBrowser()
    const res = await browserTool.execute(browserTool.parse({ action: 'back' }), c)
    expect(FakeSocket.sent.find((s) => s.method === 'Page.navigateToHistoryEntry')?.params).toEqual({ entryId: 7 })
    expect(res.content).toContain('Page: Todo')
  })

  it('evaluates JavaScript and reports page errors', async () => {
    const { c } = setupBrowser()
    expect((await browserTool.execute(browserTool.parse({ action: 'eval', js: '1 + 1' }), c)).content).toBe('2')
    const err = await browserTool.execute(browserTool.parse({ action: 'eval', js: 'boom()' }), c)
    expect(err).toMatchObject({ isError: true, content: 'The script failed: ReferenceError: boom is not defined' })
  })

  it('checks required fields per action', async () => {
    const { c, launch } = setupBrowser()
    expect(await browserTool.execute(browserTool.parse({ action: 'click' }), c)).toMatchObject({ isError: true, content: 'click needs ref.' })
    expect(await browserTool.execute(browserTool.parse({ action: 'open', url: 'javascript:alert(1)' }), c)).toMatchObject({ isError: true })
    expect(launch).not.toHaveBeenCalled()
  })

  it('accepts dialogs so they do not block the page, and says so', async () => {
    const { c } = setupBrowser()
    FakeSocket.handlers['Runtime.evaluate'] = (p, ws) => {
      if (p.expression === '1 + 1') ws.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Saved!' })
      return evaluate(p)
    }
    const res = await browserTool.execute(browserTool.parse({ action: 'eval', js: '1 + 1' }), c)
    await new Promise((r) => setTimeout(r, 5))
    expect(methods()).toContain('Page.handleJavaScriptDialog')
    // The dialog may land just after the result; it shows on this call or the next.
    const next = await browserTool.execute(browserTool.parse({ action: 'eval', js: '"x"' }), c)
    expect(res.content + next.content).toContain('Dialogs accepted: alert: Saved!')
  })

  it('returns a screenshot as an image, or a note for models without vision', async () => {
    const { c } = setupBrowser()
    expect((await browserReadTool.execute(browserReadTool.parse({ action: 'snapshot' }), c)).content).toContain('No page is open yet')
    await browserTool.execute(browserTool.parse({ action: 'open', url: 'http://localhost:3000' }), c)
    const shot = await browserReadTool.execute(browserReadTool.parse({ action: 'screenshot' }), c)
    expect(shot.images).toEqual([{ name: 'screenshot.jpg', mediaType: 'image/jpeg', data: 'SU1H' }])
    expect(FakeSocket.sent.find((s) => s.method === 'Page.captureScreenshot')?.params).toMatchObject({ format: 'jpeg' })

    const blind = setupBrowser(false)
    await browserTool.execute(browserTool.parse({ action: 'open', url: 'http://localhost:3000' }), blind.c)
    const note = await browserReadTool.execute(browserReadTool.parse({ action: 'screenshot' }), blind.c)
    expect(note.images).toBeUndefined()
    expect(note.content).toContain("can't see images")
  })

  it('splits actions from read-only looks, with useful permission subjects', () => {
    expect(browserTool.readOnly).toBe(false)
    expect(browserReadTool.readOnly).toBe(true)
    expect(browserTool.subject(browserTool.parse({ action: 'open', url: 'https://example.com' }))).toBe('https://example.com')
    expect(browserTool.subject(browserTool.parse({ action: 'eval', js: 'document\n.title' }))).toBe('eval document .title')
  })
})

describe('tool images', () => {
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'look' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'browser_read', arguments: '{}' }, { id: 'b', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'a', name: 'browser_read', content: 'Screenshot', images: [{ name: 's.jpg', mediaType: 'image/jpeg', data: 'AAA' }] },
    { role: 'tool', toolCallId: 'b', name: 'read_file', content: 'text' },
  ]

  it('OpenAI-compatible: follows the round of tool results with a user message holding the image', () => {
    const wire = wireMessages(msgs, false)
    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
    expect(wire[2]).toEqual({ role: 'tool', tool_call_id: 'a', content: 'Screenshot' })
    expect(wire[4].content).toEqual([
      { type: 'text', text: 'Image returned by the tool call above.' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
    ])
  })

  it('Anthropic: puts the image inside the tool result', () => {
    const { messages } = toAnthropicMessages(msgs)
    expect(messages[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'a',
      content: [
        { type: 'text', text: 'Screenshot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } },
      ],
    })
  })

  it('the agent keeps tool images on the tool message, and offers browser tools only when a browser is found', async () => {
    const dir = tmpDir()
    const shot = defineTool({
      name: 'shot',
      description: 'd',
      input: z.object({}),
      kind: 'other',
      readOnly: true,
      subject: () => '',
      execute: async () => ({ content: 'ok', images: [{ name: 'i.png', mediaType: 'image/png', data: 'B' }] }),
    })
    const provider = new MockProvider([[{ type: 'tool_call', call: { id: '1', name: 'shot', arguments: '{}' } }], [{ type: 'text', delta: 'seen' }], [{ type: 'text', delta: 'again' }]])
    const registry = new ProviderRegistry([], () => undefined)
    registry.register(provider)
    registry.seedCache('mock', await provider.listModels())
    const settings = defaultSettings()
    settings.permissions.mode = 'auto'
    settings.tools.browser.path = path.join(dir, 'no-browser')
    const agent = new Agent({
      session: newSession(dir, { providerId: 'mock', modelId: 'm' }),
      registry,
      tools: [...builtinTools(), shot],
      settings,
      usage: new UsageTracker(null),
      permissions: new Permissions(settings.permissions, dir),
      askPermission: async () => ({ type: 'allow' }),
      onEvent: () => {},
    })
    await agent.send('look')
    expect(provider.requests[1].messages.find((m) => m.role === 'tool')).toMatchObject({ images: [{ data: 'B' }] })
    expect(provider.requests[0].tools?.map((t) => t.name)).not.toContain('browser')

    const exe = path.join(dir, 'chrome')
    fs.writeFileSync(exe, '')
    agent.updateSettings({ ...settings, tools: { ...settings.tools, browser: { ...settings.tools.browser, path: exe } } })
    await agent.send('again')
    expect(provider.requests[2].tools?.map((t) => t.name)).toEqual(expect.arrayContaining(['browser', 'browser_read']))
    agent.dispose()
  })
})
