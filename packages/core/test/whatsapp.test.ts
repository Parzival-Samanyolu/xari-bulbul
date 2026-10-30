import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTINUED_NOTE,
  LineSplitter,
  NEEDS_NODE_TEXT,
  NODE_URL,
  OutboundIds,
  WA_APPROVAL_TEXT,
  WhatsAppGateway,
  bareJid,
  bridgeEnv,
  depsHash,
  encodeCommand,
  exportSettings,
  findOnPath,
  gateMessage,
  installPlan,
  isSelfChat,
  nodeMajor,
  parseBridgeLine,
  parseSettings,
  prepareBridge,
  progressText,
  toWhatsApp,
  whatsappParts,
  type BridgeProcess,
  type InboundMessage,
  type WhatsAppConfig,
} from '../src/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const BRIDGE_SRC = path.join(ROOT, 'apps/desktop/resources/whatsapp-bridge')

const ME = { id: '4915112345678@s.whatsapp.net', lid: '67427329167522@lid' }
const NOW = 1_800_000_000_000

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return { id: 'ABC1', chat: '4915112345678@s.whatsapp.net', fromMe: true, text: 'list the files', at: NOW - 1000, ...over }
}
const ctx = (over: Partial<Parameters<typeof gateMessage>[1]> = {}) => ({ me: ME, outbound: new OutboundIds(), seen: new OutboundIds(), prefix: '🌸 ', now: NOW, ...over })

describe('WhatsApp self-chat gate', () => {
  it('takes your own message in your own chat, by phone JID or LID', () => {
    expect(gateMessage(msg(), ctx())).toEqual({ ok: true, text: 'list the files' })
    expect(gateMessage(msg({ chat: '4915112345678:12@s.whatsapp.net' }), ctx())).toEqual({ ok: true, text: 'list the files' })
    expect(gateMessage(msg({ chat: '67427329167522@lid' }), ctx())).toEqual({ ok: true, text: 'list the files' })
    expect(gateMessage(msg({ chat: '67427329167522@lid', chatAlt: '4915112345678@s.whatsapp.net' }), ctx())).toMatchObject({ ok: true })
    // The account's own ids come device-qualified from Baileys.
    expect(gateMessage(msg(), ctx({ me: { id: '4915112345678:7@s.whatsapp.net', lid: '67427329167522:7@lid' } }))).toMatchObject({ ok: true })
  })

  it('rejects other chats, other people, groups and broadcasts', () => {
    expect(gateMessage(msg({ chat: '4915199999999@s.whatsapp.net' }), ctx())).toEqual({ ok: false, reason: 'not-self-chat' })
    expect(gateMessage(msg({ chat: '11111111111@lid' }), ctx())).toEqual({ ok: false, reason: 'not-self-chat' })
    // Someone else writing to you (not fromMe), even if the chat id were yours.
    expect(gateMessage(msg({ fromMe: false }), ctx())).toEqual({ ok: false, reason: 'not-mine' })
    expect(gateMessage(msg({ fromMe: false, chat: '4915199999999@s.whatsapp.net' }), ctx())).toEqual({ ok: false, reason: 'not-mine' })
    expect(gateMessage(msg({ chat: '120363012345678901@g.us' }), ctx())).toEqual({ ok: false, reason: 'group' })
    expect(gateMessage(msg({ chat: '120363012345678901@g.us', fromMe: false }), ctx())).toEqual({ ok: false, reason: 'group' })
    expect(gateMessage(msg({ chat: 'status@broadcast' }), ctx())).toEqual({ ok: false, reason: 'group' })
    expect(gateMessage(msg({ chat: '123@newsletter' }), ctx())).toEqual({ ok: false, reason: 'group' })
    // A user part equal to your number on another server is not your chat.
    expect(gateMessage(msg({ chat: '4915112345678@g.us' }), ctx())).toEqual({ ok: false, reason: 'group' })
    expect(isSelfChat('4915112345678@lid', ME)).toBe(false)
    expect(gateMessage(msg(), ctx({ me: null }))).toEqual({ ok: false, reason: 'not-linked' })
  })

  it('skips replies (prefix), repeats, old and empty messages', () => {
    expect(gateMessage(msg({ text: '🌸 Done, 3 files.' }), ctx())).toEqual({ ok: false, reason: 'prefix' })
    expect(gateMessage(msg({ text: '🌸 Done' }), ctx({ prefix: '' }))).toMatchObject({ ok: true })
    const seen = new OutboundIds()
    seen.remember('ABC1')
    expect(gateMessage(msg(), ctx({ seen }))).toEqual({ ok: false, reason: 'duplicate' })
    expect(gateMessage(msg({ at: NOW - 11 * 60_000 }), ctx())).toEqual({ ok: false, reason: 'old' })
    expect(gateMessage(msg({ text: '   ' }), ctx())).toEqual({ ok: false, reason: 'empty' })
  })

  it('normalizes JIDs', () => {
    expect(bareJid(' 4915112345678:3@S.WhatsApp.net ')).toBe('4915112345678@s.whatsapp.net')
  })
})

describe('WhatsApp outbound ids', () => {
  it('drops echoes of sent messages, even with an empty prefix', () => {
    const outbound = new OutboundIds()
    outbound.remember('3EB0SENT')
    expect(gateMessage(msg({ id: '3EB0SENT', text: 'reply without prefix' }), ctx({ outbound, prefix: '' }))).toEqual({ ok: false, reason: 'echo' })
    expect(gateMessage(msg({ id: '3EB0OTHER' }), ctx({ outbound }))).toMatchObject({ ok: true })
  })

  it('keeps the newest ids up to the cap', () => {
    const ids = new OutboundIds(3)
    for (const id of ['a', 'b', 'c', 'd']) ids.remember(id)
    expect(ids.has('a')).toBe(false)
    expect(['b', 'c', 'd'].every((id) => ids.has(id))).toBe(true)
    expect(ids.size).toBe(3)
    ids.remember('')
    expect(ids.has('')).toBe(false)
  })
})

describe('WhatsApp replies', () => {
  it('turns markdown into WhatsApp formatting', () => {
    expect(toWhatsApp('**bold** and *italic* and __also bold__ and ~~gone~~')).toBe('*bold* and _italic_ and *also bold* and ~gone~')
    expect(toWhatsApp('## Results\n\n- one\n- two')).toBe('*Results*\n\n• one\n• two')
    expect(toWhatsApp('See [the docs](https://x.dev) or https://y.dev')).toBe('See the docs (https://x.dev) or https://y.dev')
    expect(toWhatsApp('Run `npm test` now')).toBe('Run `npm test` now')
  })

  it('leaves code blocks alone', () => {
    const out = toWhatsApp('Here:\n\n```ts\nconst a = 2 ** 3 // **not bold**\n```\n\nDone **now**.')
    expect(out).toBe('Here:\n\n```const a = 2 ** 3 // **not bold**```\n\nDone *now*.')
  })

  it('splits at about 3500 chars, at most 5 parts, each with the prefix', () => {
    const para = `${'word '.repeat(150).trim()}.`
    const long = Array.from({ length: 40 }, () => para).join('\n\n')
    const parts = whatsappParts(long, '🌸 ')
    expect(parts).toHaveLength(5)
    for (const p of parts) {
      expect(p.startsWith('🌸 ')).toBe(true)
      expect(p.length).toBeLessThanOrEqual(3500)
    }
    expect(parts[4].endsWith(CONTINUED_NOTE)).toBe(true)
    expect(whatsappParts('Short answer.', '🌸 ')).toEqual(['🌸 Short answer.'])
  })

  it('closes a code block cut between parts and reopens it in the next', () => {
    const code = Array.from({ length: 200 }, (_, i) => `line ${i} of the program`).join('\n')
    const parts = whatsappParts(`Code:\n\n\`\`\`\n${code}\n\`\`\``, '', { maxChars: 1500 })
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts.slice(0, -1)) expect((p.match(/```/g)?.length ?? 0) % 2).toBe(0)
    expect(parts[1].startsWith('```')).toBe(true)
  })
})

describe('WhatsApp bridge protocol', () => {
  it('parses known events', () => {
    expect(parseBridgeLine('{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(parseBridgeLine('{"type":"qr","qr":"2@abc","svg":"<svg/>"}')).toEqual({ type: 'qr', qr: '2@abc', svg: '<svg/>' })
    expect(parseBridgeLine('{"type":"connected","me":{"id":"1@s.whatsapp.net","lid":null}}')).toMatchObject({ type: 'connected', me: { id: '1@s.whatsapp.net' } })
    expect(parseBridgeLine('{"type":"message","id":"X","chat":"1@s.whatsapp.net","chatAlt":null,"fromMe":true,"text":"hi","at":5}')).toMatchObject({ type: 'message', text: 'hi' })
    expect(parseBridgeLine('{"type":"result","id":3,"ok":true,"messageIds":["A","B"]}')).toEqual({ type: 'result', id: 3, ok: true, messageIds: ['A', 'B'] })
    expect(parseBridgeLine('{"type":"disconnected","reason":428,"retryInMs":2000}')).toMatchObject({ type: 'disconnected', reason: 428 })
  })

  it('ignores anything else', () => {
    expect(parseBridgeLine('')).toBeNull()
    expect(parseBridgeLine('Baileys says hello')).toBeNull()
    expect(parseBridgeLine('{"type":"message","id":"X"')).toBeNull()
    expect(parseBridgeLine('{"type":"surprise"}')).toBeNull()
    expect(parseBridgeLine('{"type":"message","id":"X","chat":"c","fromMe":"yes","text":"hi","at":5}')).toBeNull()
    expect(parseBridgeLine('[1,2]')).toBeNull()
  })

  it('splits lines across chunks and encodes commands as one line', () => {
    const got: string[] = []
    const s = new LineSplitter((l) => got.push(l))
    s.push('{"type":"re')
    s.push('ady"}\n\n{"type":"qr_timeout"}\r\n{"type"')
    expect(got).toEqual(['{"type":"ready"}', '{"type":"qr_timeout"}'])
    const line = encodeCommand({ cmd: 'send', id: 1, to: 'me@s.whatsapp.net', text: 'a\nb' })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1).includes('\n')).toBe(false)
    expect(JSON.parse(line)).toEqual({ cmd: 'send', id: 1, to: 'me@s.whatsapp.net', text: 'a\nb' })
  })
})

describe('WhatsApp bridge install', () => {
  it('builds the npm command', () => {
    const plan = installPlan({ node: '/usr/local/bin/node', npm: '/usr/local/bin/npm', nodeVersion: 'v22.17.1' }, '/data/whatsapp-bridge', 'darwin')
    expect(plan).toMatchObject({ ok: true, node: '/usr/local/bin/node', command: '/usr/local/bin/npm', cwd: '/data/whatsapp-bridge', shell: false })
    if (!plan.ok) throw new Error('unreachable')
    expect(plan.args.slice(0, 4)).toEqual(['install', '--omit=dev', '--no-audit', '--no-fund'])
    expect(installPlan({ node: 'C:\\node\\node.exe', npm: 'C:\\node\\npm.cmd', nodeVersion: 'v20.11.0' }, 'C:\\d', 'win32')).toMatchObject({ ok: true, shell: true })
  })

  it('asks for Node.js 20+ when node or npm is missing or old', () => {
    expect(installPlan({ node: null, npm: null, nodeVersion: null }, '/d')).toEqual({ ok: false, message: NEEDS_NODE_TEXT, url: NODE_URL })
    expect(installPlan({ node: '/n', npm: null, nodeVersion: 'v22.1.0' }, '/d')).toEqual({ ok: false, message: NEEDS_NODE_TEXT, url: NODE_URL })
    const old = installPlan({ node: '/n', npm: '/m', nodeVersion: 'v18.19.0' }, '/d')
    expect(old.ok).toBe(false)
    if (!old.ok) expect(old.message).toBe('Install Node.js 20+ to use WhatsApp. This computer has Node.js v18.19.0.')
    expect(NEEDS_NODE_TEXT).toBe('Install Node.js 20+ to use WhatsApp.')
    expect(nodeMajor('v20.0.0')).toBe(20)
    expect(nodeMajor('nope')).toBeNull()
  })

  it('finds tools on PATH', () => {
    const have = new Set(['/opt/homebrew/bin/npm', 'C:\\nodejs\\npm.cmd'])
    expect(findOnPath('npm', '/usr/bin:/opt/homebrew/bin', 'darwin', (p) => have.has(p))).toBe('/opt/homebrew/bin/npm')
    expect(findOnPath('node', '/usr/bin:/opt/homebrew/bin', 'darwin', (p) => have.has(p))).toBeNull()
    expect(findOnPath('npm', 'C:\\Windows;C:\\nodejs', 'win32', (p) => have.has(p.replaceAll('/', '\\')))).toBeTruthy()
  })

  it('shows npm downloads as progress', () => {
    expect(progressText('npm http fetch GET 200 https://registry.npmjs.org/ws 40ms', 7)).toBe('Downloading packages… (7)')
    expect(progressText('added 101 packages in 24s', 0)).toBe('added 101 packages in 24s')
    expect(progressText('npm warn deprecated x', 0)).toBe('')
  })

  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-wa-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('copies the bridge and installs again only when its dependencies change', () => {
    const dest = path.join(dir, 'whatsapp-bridge')
    expect(prepareBridge(BRIDGE_SRC, dest)).toEqual({ needsInstall: true })
    expect(fs.existsSync(path.join(dest, 'bridge.mjs'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'package.json'))).toBe(true)
    fs.mkdirSync(path.join(dest, 'node_modules/@whiskeysockets/baileys'), { recursive: true })
    fs.writeFileSync(path.join(dest, 'node_modules/@whiskeysockets/baileys/package.json'), '{}')
    fs.writeFileSync(path.join(dest, '.installed'), depsHash(dest))
    expect(prepareBridge(BRIDGE_SRC, dest)).toEqual({ needsInstall: false })
    fs.writeFileSync(path.join(dest, '.installed'), 'old')
    expect(prepareBridge(BRIDGE_SRC, dest)).toEqual({ needsInstall: true })
    expect(() => prepareBridge(path.join(dir, 'nope'), dest)).toThrow(/missing from the app/)
  })

  it('gives the bridge no API keys', () => {
    const env = bridgeEnv({ PATH: '/bin', HOME: '/h', OPENROUTER_API_KEY: 'sk-or', ANTHROPIC_API_KEY: 'x', HTTPS_PROXY: 'http://p' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', HTTPS_PROXY: 'http://p' })
  })
})

describe('WhatsApp licensing', () => {
  it('no workspace package.json or the lockfile mentions Baileys or libsignal', () => {
    const files = ['package.json', 'pnpm-lock.yaml']
    for (const group of ['packages', 'apps']) {
      for (const d of fs.readdirSync(path.join(ROOT, group))) {
        if (fs.existsSync(path.join(ROOT, group, d, 'package.json'))) files.push(path.join(group, d, 'package.json'))
      }
    }
    files.push('bench/package.json')
    expect(files).toContain('apps/desktop/package.json')
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      expect(text, f).not.toMatch(/baileys|libsignal/i)
    }
    // pnpm must not treat the bridge as a workspace package.
    expect(fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8')).not.toMatch(/resources|whatsapp/)
  })

  it('ships the bridge as an extra resource, outside app.asar, with Baileys pinned', () => {
    const yml = fs.readFileSync(path.join(ROOT, 'apps/desktop/electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/^extraResources:\n\s+- from: resources\/whatsapp-bridge\n\s+to: whatsapp-bridge/m)
    const files = yml.match(/^files:\n((?:\s+- .*\n)+)/m)?.[1] ?? ''
    expect(files).not.toMatch(/resources/)
    expect(files).not.toMatch(/node_modules\/\*\*/)
    const pkg = JSON.parse(fs.readFileSync(path.join(BRIDGE_SRC, 'package.json'), 'utf8'))
    expect(pkg.license).toBe('MIT')
    expect(pkg.dependencies['@whiskeysockets/baileys']).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
    expect(fs.existsSync(path.join(BRIDGE_SRC, 'node_modules'))).toBe(false)
    expect(fs.readFileSync(path.join(BRIDGE_SRC, 'README.md'), 'utf8')).toContain('WhatsApp support downloads the open-source Baileys library (MIT) and its libsignal dependency (GPL-3.0) to your computer when you turn it on.')
  })
})

// ---------------------------------------------------------------- the gateway with a fake bridge

class FakeBridge extends EventEmitter implements BridgeProcess {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  commands: any[] = []
  killed = false
  constructor() {
    super()
    new LineSplitterFor(this.stdin, (l) => this.commands.push(JSON.parse(l)))
  }
  emitEvent(e: object) {
    this.stdout.write(`${JSON.stringify(e)}\n`)
  }
  kill() {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }
}

class LineSplitterFor {
  constructor(stream: PassThrough, onLine: (l: string) => void) {
    const s = new LineSplitter(onLine)
    stream.on('data', (c: Buffer) => s.push(c))
  }
}

describe('WhatsAppGateway', () => {
  let dir: string
  let config: WhatsAppConfig
  let bridges: FakeBridge[]
  let runs: string[]
  let reply: string | null
  let gw: WhatsAppGateway
  let installs: number

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-wagw-'))
    config = { ...parseSettings({}).gateways.whatsapp, enabled: true, cwd: dir }
    bridges = []
    runs = []
    reply = 'Done **now**.'
    installs = 0
    gw = new WhatsAppGateway({
      dataDir: dir,
      bridgeSource: BRIDGE_SRC,
      config: () => config,
      run: async (text) => {
        runs.push(text)
        return reply
      },
      tooling: async () => ({ node: '/usr/bin/node', npm: '/usr/bin/npm', nodeVersion: 'v22.0.0' }),
      install: async () => {
        installs++
      },
      spawnBridge: () => {
        const b = new FakeBridge()
        bridges.push(b)
        return b
      },
      now: () => NOW,
      restartDelay: () => 10,
    })
  })
  afterEach(() => {
    gw.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function connect() {
    gw.sync()
    await vi.waitFor(() => expect(bridges).toHaveLength(1))
    bridges[0].emitEvent({ type: 'connected', me: ME })
    await vi.waitFor(() => expect(gw.status().state).toBe('connected'))
    return bridges[0]
  }

  /** Answers every send with message ids so sends complete. */
  function autoAnswer(b: FakeBridge) {
    let n = 0
    b.stdin.on('data', () =>
      setImmediate(() => {
        for (const c of b.commands.splice(0)) {
          sent.push(c)
          if (c.cmd === 'send') b.emitEvent({ type: 'result', id: c.id, ok: true, messageIds: [`OUT${++n}`] })
        }
      }),
    )
  }
  let sent: any[] = []
  beforeEach(() => {
    sent = []
  })

  it('installs, starts the bridge with the auth folder, and shows the QR code', async () => {
    gw.sync()
    await vi.waitFor(() => expect(bridges).toHaveLength(1))
    expect(installs).toBe(1)
    expect(fs.existsSync(path.join(dir, 'whatsapp-bridge', 'bridge.mjs'))).toBe(true)
    const auth = path.join(dir, 'whatsapp', 'auth')
    expect(fs.existsSync(auth)).toBe(true)
    if (process.platform !== 'win32') expect(fs.statSync(auth).mode & 0o777).toBe(0o700)
    bridges[0].emitEvent({ type: 'qr', qr: '2@abc', svg: '<svg/>' })
    await vi.waitFor(() => expect(gw.status()).toMatchObject({ state: 'linking', qr: '2@abc', qrSvg: '<svg/>' }))
  })

  it('needs Node.js when it is missing', async () => {
    gw.dispose()
    gw = new WhatsAppGateway({ dataDir: dir, bridgeSource: BRIDGE_SRC, config: () => config, run: async () => null, tooling: async () => ({ node: null, npm: null, nodeVersion: null }) })
    gw.sync()
    await vi.waitFor(() => expect(gw.status()).toMatchObject({ state: 'needs-node', message: NEEDS_NODE_TEXT, url: NODE_URL }))
  })

  it('runs your self-chat message and replies there, with the prefix, ignoring its echo', async () => {
    const b = await connect()
    autoAnswer(b)
    b.emitEvent({ type: 'message', id: 'IN1', chat: '67427329167522@lid', chatAlt: null, fromMe: true, text: 'what changed?', at: NOW })
    await vi.waitFor(() => expect(sent.filter((c) => c.cmd === 'send')).toHaveLength(1))
    expect(runs).toEqual(['what changed?'])
    const send = sent.find((c) => c.cmd === 'send')
    expect(send).toMatchObject({ to: '67427329167522@lid', text: '🌸 Done *now*.' })
    expect(sent.filter((c) => c.cmd === 'typing').map((c) => c.on)).toEqual([true, false])
    // The bridge reports our own reply back (its id), and the same message twice: neither runs.
    b.emitEvent({ type: 'message', id: 'OUT1', chat: '4915112345678@s.whatsapp.net', fromMe: true, text: 'Done now.', at: NOW })
    b.emitEvent({ type: 'message', id: 'IN1', chat: '67427329167522@lid', fromMe: true, text: 'what changed?', at: NOW })
    // Others never run.
    b.emitEvent({ type: 'message', id: 'IN2', chat: '4915199999999@s.whatsapp.net', fromMe: false, text: 'run rm -rf', at: NOW })
    b.emitEvent({ type: 'message', id: 'IN3', chat: '120363012345678901@g.us', fromMe: true, text: 'hey', at: NOW })
    await new Promise((r) => setTimeout(r, 30))
    expect(runs).toEqual(['what changed?'])
    expect(gw.status().lastSentAt).toBe(NOW)
  })

  it('tells you once per turn that an approval waits', async () => {
    let release!: () => void
    gw.dispose()
    bridges = []
    gw = new WhatsAppGateway({
      dataDir: dir,
      bridgeSource: BRIDGE_SRC,
      config: () => config,
      run: () => new Promise<string | null>((r) => (release = () => r(null))),
      tooling: async () => ({ node: '/n', npm: '/m', nodeVersion: 'v22.0.0' }),
      install: async () => {},
      spawnBridge: () => {
        const nb = new FakeBridge()
        bridges.push(nb)
        return nb
      },
      now: () => NOW,
    })
    const b2 = await connect()
    autoAnswer(b2)
    b2.emitEvent({ type: 'message', id: 'IN9', chat: ME.id, fromMe: true, text: 'delete the build folder', at: NOW })
    await vi.waitFor(() => expect(gw.status().busy).toBe(true))
    await gw.needsAttention('bash rm -rf build')
    await gw.needsAttention('bash rm -rf dist')
    release()
    await vi.waitFor(() => expect(gw.status().busy).toBe(false))
    const texts = sent.filter((c) => c.cmd === 'send').map((c) => c.text)
    expect(texts).toEqual([`🌸 ${WA_APPROVAL_TEXT('bash rm -rf build')}`])
    expect(texts[0]).toBe('🌸 Needs your approval in Xarı Bülbül: bash rm -rf build')
  })

  it('handles logged out: deletes the link and waits for Link again', async () => {
    const b = await connect()
    fs.writeFileSync(path.join(dir, 'whatsapp', 'auth', 'creds.json'), '{}')
    b.emitEvent({ type: 'logged_out' })
    await new Promise((r) => setTimeout(r, 10))
    b.emit('exit', 0, null)
    await vi.waitFor(() => expect(gw.status().state).toBe('logged-out'))
    expect(fs.existsSync(path.join(dir, 'whatsapp', 'auth'))).toBe(false)
    gw.sync()
    await new Promise((r) => setTimeout(r, 20))
    expect(bridges).toHaveLength(1)
    gw.retry()
    await vi.waitFor(() => expect(bridges).toHaveLength(2))
  })

  it('restarts a bridge that crashed', async () => {
    const b = await connect()
    b.stderr.write('Error: boom\n')
    await new Promise((r) => setTimeout(r, 5))
    b.emit('exit', 1, null)
    expect(gw.status()).toMatchObject({ state: 'reconnecting' })
    expect(gw.status().message).toContain('boom')
    await vi.waitFor(() => expect(bridges).toHaveLength(2))
  })

  it('stops the bridge when turned off and on dispose', async () => {
    const b = await connect()
    config = { ...config, enabled: false }
    gw.sync()
    expect(gw.status().state).toBe('off')
    expect(b.commands.some((c) => c.cmd === 'stop')).toBe(true)
    expect(b.stdin.writableEnded).toBe(true)
  })

  it('unlink logs out and deletes the auth folder', async () => {
    const b = await connect()
    b.stdin.on('data', () =>
      setImmediate(() => {
        for (const c of b.commands.splice(0)) if (c.cmd === 'logout') b.emitEvent({ type: 'result', id: c.id, ok: true })
      }),
    )
    await gw.unlink()
    expect(gw.status()).toMatchObject({ state: 'logged-out', account: null })
    expect(fs.existsSync(path.join(dir, 'whatsapp', 'auth'))).toBe(false)
  })

  it('is left out of exported settings', () => {
    const s = parseSettings({ gateways: { whatsapp: { enabled: true, cwd: '/p' } } })
    expect(s.gateways.whatsapp).toMatchObject({ enabled: true, cwd: '/p', mode: 'ask', prefix: '🌸 ', botId: null })
    expect((exportSettings(s) as any).gateways).toBeUndefined()
  })
})
