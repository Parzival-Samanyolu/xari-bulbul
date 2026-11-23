import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { autoSendBlock, RunStore, runSummary } from '../src/automations/runs.js'
import { htmlToText, imapQuery, messageText } from '../src/mail/client.js'
import { bareAddress, blocked, mailPreset, parseAddressList } from '../src/mail/presets.js'
import { parseMailId, type DraftInput, type MailAccess } from '../src/mail/types.js'
import { AppleNotes, NotesHub, notionBlockText, notionTitle, ObsidianVault } from '../src/notes/sources.js'
import { parseNoteId, queryTerms, scoreNote, snippetFor } from '../src/notes/types.js'
import { Agent } from '../src/loop/agent.js'
import { Permissions } from '../src/permissions/permissions.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { newSession } from '../src/sessions/store.js'
import { defaultSettings, SettingsSchema } from '../src/settings/schema.js'
import { builtinTools } from '../src/tools/index.js'
import { mailDraftTool, mailSearchTool } from '../src/tools/mail.js'
import { notesReadTool, notesSearchTool } from '../src/tools/notes.js'
import { UsageTracker } from '../src/usage/tracker.js'
import { ctx, MockProvider, tmpDir } from './helpers.js'

describe('mail addresses', () => {
  it('parses lists, names and mailto, and rejects junk', () => {
    expect(parseAddressList('Ann <ANN@x.com>, b@y.org; mailto:c@z.io')).toEqual(['ann@x.com', 'b@y.org', 'c@z.io'])
    expect(parseAddressList(['a@b.co', 'a@b.co'])).toEqual(['a@b.co'])
    expect(() => parseAddressList('not an address')).toThrow(/not an email address/)
    expect(bareAddress('x')).toBeNull()
  })

  it('blocks exact addresses and whole domains, subdomains included', () => {
    const list = ['boss@corp.com', '@rival.com', 'spam.net']
    expect(blocked('boss@corp.com', list)).toBe(true)
    expect(blocked('other@corp.com', list)).toBe(false)
    expect(blocked('a@rival.com', list)).toBe(true)
    expect(blocked('a@eu.rival.com', list)).toBe(true)
    expect(blocked('a@spam.net', list)).toBe(true)
    expect(blocked('a@notspam.net', list)).toBe(false)
  })

  it('has server presets for Gmail and Outlook, and falls back to custom', () => {
    expect(mailPreset('gmail').imap.host).toBe('imap.gmail.com')
    expect(mailPreset('outlook').smtp).toEqual({ host: 'smtp.office365.com', port: 587, secure: false })
    expect(mailPreset('nope').id).toBe('custom')
  })

  it('splits mail ids, folders with slashes included', () => {
    expect(parseMailId('work/[Gmail]/All Mail/42')).toEqual({ account: 'work', folder: '[Gmail]/All Mail', uid: 42 })
    expect(() => parseMailId('42')).toThrow()
    expect(() => parseMailId('a/INBOX/x')).toThrow()
  })

  it('builds IMAP searches and plain text', () => {
    expect(imapQuery({})).toEqual({ all: true })
    const q = imapQuery({ query: 'invoice', from: 'ann', unreadOnly: true, since: '2026-01-02' })
    expect(q).toMatchObject({ body: 'invoice', from: 'ann', seen: false })
    expect((q.since as Date).getFullYear()).toBe(2026)
    expect(htmlToText('<p>Hi&nbsp;<b>Ann</b></p><style>x{}</style>Bye')).toBe('Hi Ann\nBye')
    expect(messageText(undefined, '<div>a</div>')).toBe('a')
    expect(messageText('x'.repeat(30_000), false)).toContain('[cut at')
  })
})

describe('settings', () => {
  it('keeps old schedules valid and gives new fields safe defaults', () => {
    const s = SettingsSchema.parse({ schedules: [{ id: 's1', prompt: 'hi', cwd: '/p' }] })
    expect(s.schedules[0]).toMatchObject({ trigger: 'time', send: { mode: 'review', maxPerRun: 10, maxPerDay: 50, discloseAi: false }, after: { notify: 'desktop', runNext: '' }, mailAccounts: [], notes: [] })
    expect(s.mail).toEqual({ accounts: [], blocklist: [], aiDisclosure: 'This email was written with help from AI.' })
    expect(s.notes).toEqual({ sources: [] })
  })
})

describe('RunStore', () => {
  it('records runs and drafts, survives a restart, and fails runs cut off by a quit', () => {
    const file = path.join(tmpDir(), 'runs.json')
    let t = 1_000_000
    const store = new RunStore(file, () => t)
    const run = store.start({ automationId: 'a', name: 'Follow-ups', sessionId: 's', trigger: 'time' })
    const d = store.addDraft(run.id, { account: 'm', to: ['ann@x.com'], cc: [], subject: 'Hi', body: 'Hello' })
    store.updateDraft(run.id, d.id, { status: 'sending' })
    expect(store.unread()).toBe(1)
    const again = new RunStore(file, () => t)
    expect(again.get(run.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/closed/) })
    expect(again.draft(run.id, d.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/Sent/) })
    t += 5
    again.finish(run.id, { status: 'done', summary: 'ok' })
    again.markRead(run.id)
    expect(again.get(run.id)?.read).toBe(true)
    // A failed draft still wants attention? No: only pending ones do.
    expect(again.unread()).toBe(0)
  })

  it('switches the AI disclosure on a waiting draft', () => {
    const store = new RunStore(path.join(tmpDir(), 'runs.json'))
    const run = store.start({ automationId: 'a', name: 'n', sessionId: 's', trigger: 'manual' })
    const d = store.addDraft(run.id, { account: 'm', to: ['a@b.co'], cc: [], subject: 's', body: 'b', disclose: false })
    // As the app sends it: only `disclose` set, the rest undefined.
    const after = store.updateDraft(run.id, d.id, { to: undefined, cc: undefined, subject: undefined, body: undefined, disclose: true })
    expect(after).toMatchObject({ to: ['a@b.co'], cc: [], subject: 's', body: 'b', disclose: true })
  })

  it('never edits an email that was sent', () => {
    const store = new RunStore(path.join(tmpDir(), 'runs.json'))
    const run = store.start({ automationId: 'a', name: 'n', sessionId: 's', trigger: 'manual' })
    const d = store.addDraft(run.id, { account: 'm', to: ['a@b.co'], cc: [], subject: 's', body: 'b' })
    store.updateDraft(run.id, d.id, { status: 'sent', sentAt: Date.now(), auto: true })
    expect(() => store.updateDraft(run.id, d.id, { body: 'changed' })).toThrow(/already sent/)
    expect(() => store.updateDraft(run.id, d.id, { disclose: true })).toThrow(/already sent/)
    expect(store.sentIn(run.id)).toBe(1)
    expect(store.autoSentToday()).toBe(1)
  })

  it('counts only automatic sends from the last day toward the daily limit', () => {
    let t = 10 * 86_400_000
    const store = new RunStore(path.join(tmpDir(), 'runs.json'), () => t)
    const run = store.start({ automationId: 'a', name: 'n', sessionId: 's', trigger: 'manual' })
    for (const [auto, at] of [
      [true, t - 2 * 86_400_000],
      [true, t - 1000],
      [false, t - 1000],
    ] as const) {
      const d = store.addDraft(run.id, { account: 'm', to: ['a@b.co'], cc: [], subject: 's', body: 'b' })
      store.updateDraft(run.id, d.id, { status: 'sent', sentAt: at, auto })
    }
    expect(store.autoSentToday()).toBe(1)
  })

  it('stops automatic sending at the blocklist and the limits', () => {
    const base = { blocklist: ['@rival.com'], maxPerRun: 2, maxPerDay: 5, sentInRun: 0, sentToday: 0 }
    expect(autoSendBlock({ to: ['a@x.com'], cc: [] }, base)).toBeNull()
    expect(autoSendBlock({ to: ['a@x.com'], cc: ['b@rival.com'] }, base)).toMatch(/blocklist/)
    expect(autoSendBlock({ to: ['a@x.com'], cc: [] }, { ...base, sentInRun: 2 })).toMatch(/this run/)
    expect(autoSendBlock({ to: ['a@x.com'], cc: [] }, { ...base, sentToday: 5 })).toMatch(/today/)
  })

  it('summarises the last reply as plain text', () => {
    expect(runSummary('## Done\n\n**3 drafts** ready\n```\ncode\n```')).toBe('Done\n3 drafts ready')
    expect(runSummary('x'.repeat(1000), 10)).toBe(`…${'x'.repeat(10)}`)
  })
})

describe('notes', () => {
  it('scores, snippets and splits ids', () => {
    expect(queryTerms('Ann "big order" Smith')).toEqual(['ann', 'big order', 'smith'])
    expect(scoreNote(['ann'], 'Ann Smith', 'nothing')).toBeGreaterThan(scoreNote(['ann'], 'Other', 'ann once'))
    expect(scoreNote(['ann', 'bob'], 'Ann', 'no b-o-b')).toBe(0)
    expect(snippetFor(['order'], `${'a '.repeat(100)}the order came`)).toContain('the order came')
    expect(parseNoteId('vault/Customers/Ann.md')).toEqual({ source: 'vault', ref: 'Customers/Ann.md' })
  })

  it('searches and reads an Obsidian vault, skipping .obsidian and staying inside it', async () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'Customers'))
    fs.mkdirSync(path.join(dir, '.obsidian'))
    fs.writeFileSync(path.join(dir, 'Customers', 'Ann Smith.md'), '# Ann\nLoves the blue model. Birthday in May.')
    fs.writeFileSync(path.join(dir, 'Random.md'), 'Nothing about her.')
    fs.writeFileSync(path.join(dir, '.obsidian', 'ann.md'), 'Ann config')
    const v = new ObsidianVault('v', dir)
    const hits = await v.search(['ann'], 10)
    expect(hits.map((h) => h.id)).toEqual(['v/Customers/Ann Smith.md'])
    expect((await v.read('Customers/Ann Smith.md')).text).toContain('Birthday in May')
    await expect(v.read('../outside.md')).rejects.toThrow(/outside the vault/)
    await expect(new ObsidianVault('x', path.join(dir, 'missing')).search([], 5)).rejects.toThrow(/not found/)
  })

  it('reads Apple Notes through osascript, only on a Mac', async () => {
    const calls: string[][] = []
    const run = async (_script: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'x-coredata://1') return JSON.stringify({ id: 'x-coredata://1', title: 'Ann', text: 'Ann likes tea', modified: '2026-01-01T00:00:00.000Z' })
      return JSON.stringify([
        { id: 'x-coredata://1', title: 'Ann', text: 'Ann likes tea', modified: '2026-01-01T00:00:00.000Z' },
        { id: 'x-coredata://2', title: 'Groceries', text: 'milk', modified: '' },
      ])
    }
    const notes = new AppleNotes('apple', 'Customers', run, 'darwin')
    expect((await notes.search(['tea'], 5)).map((h) => h.id)).toEqual(['apple/x-coredata://1'])
    await notes.search(['milk'], 5)
    expect(calls).toEqual([['Customers']]) // the list is cached for a minute
    expect((await notes.read('x-coredata://1')).text).toBe('Ann likes tea')
    await expect(new AppleNotes('a', '', run, 'linux').search([], 5)).rejects.toThrow(/Mac/)
  })

  it('turns Notion pages and blocks into text', async () => {
    expect(notionTitle({ properties: { Name: { type: 'title', title: [{ plain_text: 'Ann ' }, { plain_text: 'Smith' }] } } })).toBe('Ann Smith')
    expect(notionBlockText({ type: 'to_do', to_do: { checked: true, rich_text: [{ plain_text: 'Call' }] } })).toBe('- [x] Call')
    expect(notionBlockText({ type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Orders' }] } })).toBe('## Orders')
    const seen: { url: string; auth: string | null }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization') })
      const body = url.endsWith('/search')
        ? { results: [{ id: 'p1', url: 'https://notion.so/p1', last_edited_time: '2026-02-02', properties: { t: { type: 'title', title: [{ plain_text: 'Ann' }] } } }] }
        : url.includes('/pages/')
          ? { id: 'p1', properties: { t: { type: 'title', title: [{ plain_text: 'Ann' }] } } }
          : { results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'VIP since 2024' }] } }], has_more: false }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    const hub = new NotesHub([{ id: 'n', name: 'Notion', enabled: true, kind: 'notion', path: '', folder: '' }], { secret: () => 'secret_x', fetch: fetchImpl })
    expect((await hub.search('Ann')).map((h) => h.id)).toEqual(['n/p1'])
    expect((await hub.read('n/p1')).text).toBe('VIP since 2024')
    expect(seen.every((s) => s.auth === 'Bearer secret_x')).toBe(true)
    const noToken = new NotesHub([{ id: 'n', name: 'Notion', enabled: true, kind: 'notion', path: '', folder: '' }], { secret: () => undefined, fetch: fetchImpl })
    await expect(noToken.search('Ann')).rejects.toThrow(/No Notion token/)
  })

  it('leaves disabled sources out and names unknown ones', async () => {
    const hub = new NotesHub([{ id: 'off', name: 'Off', enabled: false, kind: 'obsidian', path: '/x', folder: '' }], { secret: () => undefined })
    expect(hub.sources()).toEqual([])
    await expect(hub.search('a', { source: 'off' })).rejects.toThrow(/No notes source/)
  })
})

describe('mail and notes tools', () => {
  const mail = (drafts: DraftInput[]): MailAccess => ({
    accounts: () => [{ id: 'm', name: 'Work', address: 'me@x.com' }],
    search: async () => [{ id: 'm/INBOX/7', account: 'm', from: 'Ann <ann@x.com>', to: 'me@x.com', subject: 'Order', date: '2026-01-01T10:00:00.000Z', unread: true, snippet: 'Where is it?' }],
    read: async () => {
      throw new Error('unused')
    },
    draft: async (d) => {
      drafts.push(d)
      return { status: 'pending', message: 'Queued for review.' }
    },
  })

  it('lists search hits with ids and queues drafts with parsed addresses', async () => {
    const drafts: DraftInput[] = []
    const c = ctx('/p', { mail: mail(drafts) })
    expect((await mailSearchTool.execute(mailSearchTool.parse({ query: 'order' }), c)).content).toContain('m/INBOX/7  ● 2026-01-01 10:00')
    const r = await mailDraftTool.execute(mailDraftTool.parse({ to: 'Ann <ann@x.com>', subject: 'Hi', body: 'Your order ships today.' }), c)
    expect(r).toEqual({ content: 'Queued for review.', isError: false })
    expect(drafts[0]).toMatchObject({ to: ['ann@x.com'], cc: [], subject: 'Hi' })
    expect((await mailDraftTool.execute(mailDraftTool.parse({ body: 'x' }), c)).isError).toBe(true)
    expect((await mailSearchTool.execute(mailSearchTool.parse({}), ctx('/p'))).content).toMatch(/No email account/)
  })

  it('searches and reads notes', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'Ann.md'), 'Ann ordered 3 chairs.')
    const notes = new NotesHub([{ id: 'v', name: 'Vault', enabled: true, kind: 'obsidian', path: dir, folder: '' }], { secret: () => undefined })
    const c = ctx('/p', { notes })
    expect((await notesSearchTool.execute(notesSearchTool.parse({ query: 'chairs' }), c)).content).toContain('v/Ann.md')
    expect((await notesReadTool.execute(notesReadTool.parse({ id: 'v/Ann.md' }), c)).content).toContain('<note>\nAnn ordered 3 chairs.')
  })

  it('shows the tools to the model only when the host connects mail and notes', async () => {
    const names = async (extra: { mail?: MailAccess; notes?: NotesHub }) => {
      const dir = tmpDir()
      const provider = new MockProvider([[{ type: 'text', delta: 'hi' }]])
      const registry = new ProviderRegistry([], () => undefined)
      registry.register(provider)
      const settings = defaultSettings()
      const agent = new Agent({
        session: newSession(dir, { providerId: 'mock', modelId: 'm' }),
        registry,
        tools: builtinTools(),
        settings,
        usage: new UsageTracker(null),
        permissions: new Permissions(settings.permissions, dir),
        askPermission: async () => ({ type: 'allow' }),
        onEvent: () => {},
        ...extra,
      })
      await agent.send('hi')
      return provider.requests[0].tools?.map((t) => t.name) ?? []
    }
    const none = await names({})
    expect(none).not.toContain('mail_search')
    expect(none).not.toContain('notes_search')
    const both = await names({ mail: mail([]), notes: new NotesHub([], { secret: () => undefined }) })
    expect(both).toEqual(expect.arrayContaining(['mail_search', 'mail_read', 'mail_draft', 'notes_search', 'notes_read']))
  })
})
