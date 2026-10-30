import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  APPLE_EPOCH_MS,
  CONTINUED_NOTE,
  ChatDbError,
  IMessageGateway,
  KeyedQueue,
  RecentlySent,
  SEND_SCRIPT,
  TEST_TEXT,
  allowedSender,
  classifyOpenError,
  decodeAttributedBody,
  exportSettings,
  importSettings,
  messageText,
  normalizeHandle,
  normalizeSender,
  openChatDb,
  osascriptArgs,
  parseSettings,
  readGatewayState,
  sendErrorKind,
  splitReply,
  stripMarkdown,
  type ChatDb,
  type ChatDbRow,
  type IMessageConfig,
} from '../src/index.js'

const fixture = (name: string) => Buffer.from(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').replace(/\s+/g, ''), 'hex')

describe('senders', () => {
  it('normalizes phones to E.164 and emails to lowercase', () => {
    expect(normalizeSender('+1 (555) 123-4567')).toBe('+15551234567')
    expect(normalizeSender('0044 20 7946 0958')).toBe('+442079460958')
    expect(normalizeSender('tel:+994.50.123.45.67')).toBe('+994501234567')
    expect(normalizeSender('  Me@iCloud.COM ')).toBe('me@icloud.com')
    expect(normalizeSender('mailto:Me@Example.org')).toBe('me@example.org')
  })

  it('rejects numbers without a country code and other junk', () => {
    expect(normalizeSender('(555) 123-4567')).toBeNull()
    expect(normalizeSender('not an address')).toBeNull()
    expect(normalizeSender('a@b')).toBeNull()
    expect(normalizeSender('+12')).toBeNull()
    expect(normalizeSender('-e do shell script')).toBeNull()
    expect(normalizeSender('')).toBeNull()
  })

  it('normalizes chat.db handles, adding a missing +', () => {
    expect(normalizeHandle('+15551234567')).toBe('+15551234567')
    expect(normalizeHandle('15551234567')).toBe('+15551234567')
    expect(normalizeHandle('Me@iCloud.com')).toBe('me@icloud.com')
  })

  it('lets only allowed senders through, and nobody while the list is empty', () => {
    const allowed = ['+1 555 123 4567', 'me@icloud.com']
    expect(allowedSender('+15551234567', allowed)).toBe('+15551234567')
    expect(allowedSender('ME@icloud.com', allowed)).toBe('me@icloud.com')
    expect(allowedSender('+15559999999', allowed)).toBeNull()
    expect(allowedSender('someone@else.com', allowed)).toBeNull()
    expect(allowedSender('+15551234567', [])).toBeNull()
  })
})

describe('settings files', () => {
  it('leaves gateways (your numbers, a local folder) out of exports and keeps them on import', () => {
    const mine = parseSettings({ gateways: { imessage: { enabled: true, senders: ['+15551234567'], cwd: '/Users/me/p' } } })
    const out = exportSettings(mine)
    expect(out).not.toHaveProperty('gateways')
    const back = importSettings(out, mine)
    expect(back.ok && back.settings.gateways).toEqual(mine.gateways)
  })
})

describe('attributedBody', () => {
  it('decodes a short typedstream blob', () => {
    expect(decodeAttributedBody(fixture('attributed-body-short.hex'))).toBe('Hi! Can you run the tests? 👋')
  })

  it('decodes a blob whose text needs a two-byte length', () => {
    const text = decodeAttributedBody(fixture('attributed-body-long.hex'))
    expect(text).toMatch(/^Please look at the failing build/)
    expect(text).toMatch(/ünïcödé too\.$/)
    expect(Buffer.byteLength(text!)).toBeGreaterThan(127)
  })

  it('returns null for empty or unrelated data', () => {
    expect(decodeAttributedBody(null)).toBeNull()
    expect(decodeAttributedBody(new Uint8Array())).toBeNull()
    expect(decodeAttributedBody(Buffer.from('streamtyped NSObject only'))).toBeNull()
    // A length running past the end is refused, not read out of bounds.
    expect(decodeAttributedBody(Buffer.concat([Buffer.from('NSString'), Buffer.from([0x01, 0x95, 0x84, 0x01, 0x2b, 0x40, 0x41])]))).toBeNull()
  })

  it('prefers text, falls back to the blob, and drops attachment placeholders', () => {
    expect(messageText({ text: ' plain ', body: fixture('attributed-body-short.hex') })).toBe('plain')
    expect(messageText({ text: null, body: fixture('attributed-body-short.hex') })).toBe('Hi! Can you run the tests? 👋')
    expect(messageText({ text: '￼', body: null })).toBe('')
  })
})

describe('replies', () => {
  it('strips markdown lightly', () => {
    const md = '# Done\n\n**Fixed** the `parser`, see [the PR](https://x.test/1).\n\n- one\n- two\n\n```ts\nconst a = 1\n```\n> quoted _here_'
    expect(stripMarkdown(md)).toBe('Done\n\nFixed the parser, see the PR (https://x.test/1).\n\n• one\n• two\n\nconst a = 1\nquoted here')
  })

  it('leaves a short reply whole', () => {
    expect(splitReply('Done.')).toEqual(['Done.'])
    expect(splitReply('  ')).toEqual([])
  })

  it('splits at paragraphs, then sentences, keeping each part within the limit', () => {
    const para = 'A'.repeat(900)
    expect(splitReply(`${para}\n\n${para}`)).toEqual([para, para])
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const parts = splitReply(sentences, { maxChars: 200, maxParts: 50 })
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(200)
      expect(p).toMatch(/\.$/)
    }
    expect(parts.join(' ')).toBe(sentences)
  })

  it('hard-cuts text without any boundary', () => {
    const parts = splitReply('x'.repeat(3100))
    expect(parts.map((p) => p.length)).toEqual([1500, 1500, 100])
  })

  it('stops at five parts and points to the app', () => {
    const long = Array.from({ length: 12 }, (_, i) => `${i} ${'word '.repeat(250)}`).join('\n\n')
    const parts = splitReply(long)
    expect(parts).toHaveLength(5)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1500)
    expect(parts[4].endsWith(CONTINUED_NOTE)).toBe(true)
  })
})

describe('osascript', () => {
  it('passes recipient and text as arguments, never inside the script', () => {
    const evil = 'hi" & (do shell script "rm -rf ~") & "\nend tell'
    const args = osascriptArgs('+1 555 123 4567', evil)
    expect(args.slice(-2)).toEqual(['+15551234567', evil])
    const script = args.slice(0, -2)
    expect(script.filter((_, i) => i % 2 === 0).every((a) => a === '-e')).toBe(true)
    expect(script.filter((_, i) => i % 2 === 1)).toEqual(SEND_SCRIPT)
    expect(SEND_SCRIPT.join('\n')).not.toContain('hi"')
    expect(SEND_SCRIPT.join('\n')).toMatch(/on run argv/)
    expect(SEND_SCRIPT.join('\n')).toMatch(/participant theRecipient/)
  })

  it('refuses a recipient that is not a phone or email (so it can never look like an option)', () => {
    expect(() => osascriptArgs('-e', 'x')).toThrow()
    expect(() => osascriptArgs('someone', 'x')).toThrow()
  })

  it('recognizes the Automation permission error', () => {
    expect(sendErrorKind('execution error: Not authorized to send Apple events to Messages. (-1743)')).toBe('automation')
    expect(sendErrorKind('Messages got an error: Can’t get participant')).toBe('other')
  })
})

describe('KeyedQueue', () => {
  it('runs one job at a time per sender and different senders side by side', async () => {
    const q = new KeyedQueue()
    const log: string[] = []
    const gate = <T>() => {
      let open!: (v: T) => void
      const p = new Promise<T>((r) => (open = r))
      return { p, open }
    }
    const a1 = gate<void>()
    const first = q.run('a', async () => {
      log.push('a1 start')
      await a1.p
      log.push('a1 end')
    })
    const second = q.run('a', async () => {
      log.push('a2 start')
    })
    const other = q.run('b', async () => {
      log.push('b start')
    })
    await other
    await new Promise((r) => setTimeout(r, 5))
    expect(log).toEqual(['a1 start', 'b start'])
    expect(q.busy()).toEqual(['a'])
    a1.open()
    await Promise.all([first, second])
    expect(log).toEqual(['a1 start', 'b start', 'a1 end', 'a2 start'])
  })

  it('keeps going after a job fails', async () => {
    const q = new KeyedQueue()
    await expect(q.run('a', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(q.run('a', async () => 2)).resolves.toBe(2)
  })
})

describe('RecentlySent', () => {
  it('treats a sent text coming back once as an echo', () => {
    const r = new RecentlySent(1000)
    r.add('Hello  there', 0)
    expect(r.isEcho('Hello there', 10)).toBe(true)
    expect(r.isEcho('Hello there', 20)).toBe(false)
    r.add('late', 0)
    expect(r.isEcho('late', 2000)).toBe(false)
  })
})

describe('chat.db', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('reads incoming one-to-one messages read-only, with dates in ms', async () => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
    const file = path.join(dir, 'chat.db')
    const db = new DatabaseSync(file)
    db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, handle_id INTEGER, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, cache_roomnames TEXT, item_type INTEGER);
      INSERT INTO handle VALUES (1, '+15551234567');`)
    const ins = db.prepare('INSERT INTO message VALUES (?, 1, ?, ?, ?, ?, ?, 0)')
    const ns = 760000000n * 1000000000n // Big enough to need the division in SQL.
    ins.run(1, 'old', null, ns, 0, null)
    ins.run(2, null, fixture('attributed-body-short.hex'), ns, 0, null)
    ins.run(3, 'mine', null, ns, 1, null)
    ins.run(4, 'group', null, ns, 0, 'chat123')
    db.close()
    const chat = openChatDb(file)
    try {
      expect(chat.maxRowid()).toBe(4)
      const rows = chat.since(1, 10)
      expect(rows.map((r) => r.rowid)).toEqual([2])
      expect(messageText(rows[0])).toBe('Hi! Can you run the tests? 👋')
      expect(rows[0].handle).toBe('+15551234567')
      expect(rows[0].at).toBe(760000000 * 1000 + APPLE_EPOCH_MS)
    } finally {
      chat.close()
    }
  })

  it('reports a missing database and classifies permission errors', () => {
    expect(() => openChatDb(path.join(dir, 'nope.db'))).toThrow(ChatDbError)
    try {
      openChatDb(path.join(dir, 'nope.db'))
    } catch (e) {
      expect((e as ChatDbError).problem).toBe('missing')
    }
    expect(classifyOpenError(Object.assign(new Error('unable to open database file'), { errcode: 14 })).problem).toBe('no-access')
    expect(classifyOpenError(Object.assign(new Error('nope'), { code: 'EPERM' })).problem).toBe('no-access')
    expect(classifyOpenError(Object.assign(new Error('authorization denied'), { errcode: 23 })).problem).toBe('no-access')
    expect(classifyOpenError(new Error('database disk image is malformed')).problem).toBe('other')
  })
})

describe('IMessageGateway', () => {
  let dir: string
  let rows: ChatDbRow[]
  let config: IMessageConfig
  let sent: string[][]
  const NOW = 2_000_000_000_000
  const fakeDb = (): ChatDb => ({
    maxRowid: () => rows.reduce((m, r) => Math.max(m, r.rowid), 0),
    since: (id, limit) => rows.filter((r) => r.rowid > id).slice(0, limit),
    close: () => {},
  })
  const row = (rowid: number, handle: string, text: string, at = NOW): ChatDbRow => ({ rowid, handle, text, body: null, at })
  const make = (run: (sender: string, text: string) => Promise<string | null>, extra: Partial<ConstructorParameters<typeof IMessageGateway>[0]> = {}) =>
    new IMessageGateway({
      stateFile: path.join(dir, 'gateways.json'),
      config: () => config,
      run,
      openDb: fakeDb,
      osascript: async (args) => void sent.push(args.slice(-2)),
      now: () => NOW,
      platform: 'darwin',
      timer: false,
      ...extra,
    })
  const settle = () => new Promise((r) => setTimeout(r, 10))

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-gw-'))
    rows = [row(1, '+15551234567', 'before enabling')]
    config = { ...parseSettings({}).gateways.imessage, enabled: true, senders: ['+1 555 123 4567'], cwd: dir }
    sent = []
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('defaults to off, Ask mode, nobody allowed', () => {
    const d = parseSettings({}).gateways.imessage
    expect(d).toEqual({ enabled: false, senders: [], cwd: '', botId: null, mode: 'ask', pollSeconds: 5 })
  })

  it('starts at the newest message, then only takes new ones from allowed senders', async () => {
    const got: string[] = []
    const gw = make(async (s, t) => (got.push(`${s}: ${t}`), `Reply to ${t}`))
    gw.sync()
    await settle()
    expect(got).toEqual([])
    expect(readGatewayState(path.join(dir, 'gateways.json')).imessage?.cursor).toBe(1)
    rows.push(row(2, '+15551234567', 'run the tests'), row(3, 'stranger@example.com', 'hello'), row(4, '15551234567', 'old one', NOW - 60 * 60_000))
    await gw.poll()
    await settle()
    expect(got).toEqual(['+15551234567: run the tests'])
    expect(sent).toEqual([['+15551234567', 'Reply to run the tests']])
    expect(readGatewayState(path.join(dir, 'gateways.json')).imessage?.cursor).toBe(4)
    expect(gw.status().state).toBe('listening')
    // Nothing is read twice.
    await gw.poll()
    await settle()
    expect(got).toHaveLength(1)
  })

  it('continues from the saved cursor after a restart, and forgets it when turned off', async () => {
    fs.writeFileSync(path.join(dir, 'gateways.json'), JSON.stringify({ imessage: { cursor: 1 } }))
    rows.push(row(2, '+15551234567', 'while restarting'))
    const got: string[] = []
    const gw = make(async (_, t) => (got.push(t), null))
    gw.sync()
    await settle()
    expect(got).toEqual(['while restarting'])
    expect(sent).toEqual([])
    config = { ...config, enabled: false }
    gw.sync()
    expect(readGatewayState(path.join(dir, 'gateways.json')).imessage).toBeUndefined()
    expect(gw.status().state).toBe('off')
  })

  it('ignores its own replies coming back (texting yourself)', async () => {
    const got: string[] = []
    const gw = make(async (_, t) => (got.push(t), 'Done.'))
    gw.sync()
    await settle()
    rows.push(row(2, '+15551234567', 'hi'))
    await gw.poll()
    await settle()
    rows.push(row(3, '+15551234567', 'Done.'))
    await gw.poll()
    await settle()
    expect(got).toEqual(['hi'])
  })

  it('queues a second message from the same sender behind the running turn', async () => {
    let release!: () => void
    const order: string[] = []
    const gw = make(async (_, t) => {
      order.push(`start ${t}`)
      if (t === 'one') await new Promise<void>((r) => (release = r))
      order.push(`end ${t}`)
      return null
    })
    gw.sync()
    await settle()
    rows.push(row(2, '+15551234567', 'one'))
    await gw.poll()
    await settle()
    rows.push(row(3, '+15551234567', 'two'))
    await gw.poll()
    await settle()
    expect(order).toEqual(['start one'])
    expect(gw.status().busy).toEqual(['+15551234567'])
    release()
    await settle()
    expect(order).toEqual(['start one', 'end one', 'start two', 'end two'])
  })

  it('texts once per turn when an approval waits in the app', async () => {
    const gw = make(async () => {
      await gw.needsAttention('+15551234567', 'bash npm test')
      await gw.needsAttention('+15551234567', 'edit_file src/a.ts')
      return 'All green.'
    })
    gw.sync()
    await settle()
    rows.push(row(2, '+15551234567', 'test it'))
    await gw.poll()
    await settle()
    expect(sent).toEqual([
      ['+15551234567', 'Needs your approval in Xarı Bülbül: bash npm test'],
      ['+15551234567', 'All green.'],
    ])
  })

  it('needs a sender and a folder before it listens', () => {
    config = { ...config, senders: [] }
    const gw = make(async () => null)
    gw.sync()
    expect(gw.status().state).toBe('needs-setup')
    config = { ...config, senders: ['me@icloud.com'], cwd: '' }
    gw.sync()
    expect(gw.status().state).toBe('needs-setup')
  })

  it('stays off on other platforms', () => {
    const gw = make(async () => null, { platform: 'linux' })
    gw.sync()
    expect(gw.status().state).toBe('off')
  })

  it('shows missing Full Disk Access', async () => {
    const gw = make(async () => null, {
      openDb: () => {
        throw Object.assign(new Error('unable to open database file'), { errcode: 14 })
      },
    })
    gw.sync()
    await settle()
    expect(gw.status().state).toBe('no-access')
  })

  it('sends the test message to the first sender and reports a blocked Automation permission', async () => {
    config = { ...config, senders: ['Me@iCloud.com', '+15551234567'] }
    const gw = make(async () => null)
    await gw.sendTest()
    expect(sent).toEqual([['me@icloud.com', TEST_TEXT]])
    expect(gw.status().automation).toBe('ok')
    const blocked = make(async () => null, {
      osascript: async () => {
        throw new Error('execution error: Not authorized to send Apple events to Messages. (-1743)')
      },
    })
    await expect(blocked.sendTest()).rejects.toThrow(/Automation/)
    expect(blocked.status().automation).toBe('denied')
  })
})
