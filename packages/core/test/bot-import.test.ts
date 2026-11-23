import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { importBots, parseSettings, planBotImport, saveSettingsFile, loadSettingsFile, MemoryStore, wantedSession } from '../src/index.js'
import { tmpDir } from './helpers.js'

function seed() {
  const source = tmpDir()
  const target = tmpDir()
  fs.mkdirSync(path.join(source, 'bots'), { recursive: true })
  const pic = path.join(source, 'bots', 'avatar-a.png')
  fs.writeFileSync(pic, 'PNG-A')
  const outside = path.join(tmpDir(), 'me.png')
  fs.writeFileSync(outside, 'PNG-OUT')
  saveSettingsFile(
    source,
    parseSettings({
      bots: [
        { id: 'b1', name: 'Ada', avatar: { kind: 'image', image: pic } },
        { id: 'b2', name: 'Bo', avatar: { kind: 'image', image: outside } },
        { id: 'b3', name: 'Cy' },
      ],
      lobbies: [{ id: 'l1', name: 'Club', botIds: ['b1', 'b2'] }],
      botOptions: { enabled: false },
    }),
  )
  new MemoryStore(path.join(source, 'memory')).add('bot', 'b1', 'likes tea')
  const sessions = path.join(source, 'sessions')
  fs.mkdirSync(sessions)
  const write = (id: string, meta: object) => fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify({ meta: { id, ...meta }, messages: [], todos: [] }))
  write('s-b1', { botId: 'b1' })
  write('s-lobby', { lobbyId: 'l1' })
  write('s-plain', {})
  write('s-other', { botId: 'zzz' })
  fs.writeFileSync(path.join(sessions, 'broken.json'), '{nope')
  return { source, target, pic, outside }
}

describe('bot import', () => {
  it('picks sessions of imported bots and lobbies only', () => {
    expect(wantedSession({ botId: 'a' }, new Set(['a']), new Set())).toBe(true)
    expect(wantedSession({ lobbyId: 'l' }, new Set(), new Set(['l']))).toBe(true)
    expect(wantedSession({}, new Set(['a']), new Set(['l']))).toBe(false)
  })

  it('copies bots, lobbies, options, avatars, memory and chats', () => {
    const { source, target, pic, outside } = seed()
    const r = importBots(source, target, loadSettingsFile(target))
    expect([r.bots, r.lobbies, r.chats]).toEqual([3, 1, 2])
    expect(r.settings.botOptions.enabled).toBe(false)
    const b1 = r.settings.bots.find((b) => b.id === 'b1')!
    expect(b1.avatar.image).toBe(path.join(target, 'bots', 'avatar-a.png'))
    expect(fs.readFileSync(b1.avatar.image!, 'utf8')).toBe('PNG-A')
    expect(r.settings.bots.find((b) => b.id === 'b2')!.avatar.image).toBe(outside)
    expect(new MemoryStore(path.join(target, 'memory')).list('bot', 'b1')).toEqual(['likes tea'])
    expect(fs.readdirSync(path.join(target, 'sessions')).sort()).toEqual(['s-b1.json', 's-lobby.json'])
    expect(fs.existsSync(pic)).toBe(true)
  })

  it('skips ids the target has, keeps the target settings, and is idempotent', () => {
    const { source, target } = seed()
    const own = parseSettings({ bots: [{ id: 'b3', name: 'Mine' }] })
    const first = importBots(source, target, own)
    expect(first.bots).toBe(2)
    expect(first.settings.bots.find((b) => b.id === 'b3')!.name).toBe('Mine')
    saveSettingsFile(target, first.settings)
    const again = importBots(source, target, loadSettingsFile(target))
    expect([again.bots, again.lobbies, again.chats]).toEqual([0, 0, 0])
    expect(loadSettingsFile(target).bots).toHaveLength(3)
    expect(planBotImport(source, target, loadSettingsFile(target))).toEqual({ bots: [], lobbies: [] })
  })

  it('does nothing without a source or when source is the target', () => {
    const target = tmpDir()
    const s = loadSettingsFile(target)
    expect(importBots(path.join(target, 'nope'), target, s).bots).toBe(0)
    expect(importBots(target, target, s).bots).toBe(0)
  })

  it('never writes into the source', () => {
    const { source, target } = seed()
    const snap = () => fs.readdirSync(source, { recursive: true }).sort().join('|')
    const before = snap()
    importBots(source, target, loadSettingsFile(target))
    expect(snap()).toBe(before)
  })
})
