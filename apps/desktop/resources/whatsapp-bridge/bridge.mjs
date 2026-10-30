#!/usr/bin/env node
// Xarı Bülbül WhatsApp bridge (MIT). A separate program the app starts with `node bridge.mjs`;
// it links to WhatsApp as a linked device through Baileys and speaks JSON lines on stdin/stdout.
// See README.md for the protocol. The design follows Hermes Agent's WhatsApp bridge
// (MIT, Copyright (c) 2025 Nous Research); the code here is written for this app.
//
// Usage: node bridge.mjs --auth <dir>

import fs from 'node:fs'
import readline from 'node:readline'
import { Browsers, DisconnectReason, fetchLatestBaileysVersion, generateMessageIDV2, makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys'
import QRCode from 'qrcode'

// Auth files hold the account's keys: owner-only.
process.umask(0o077)

const args = process.argv.slice(2)
const argValue = (name) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 ? args[i + 1] : undefined
}
const AUTH_DIR = argValue('auth')
if (!AUTH_DIR) {
  process.stderr.write('usage: node bridge.mjs --auth <dir>\n')
  process.exit(2)
}
fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })

// stdout carries the protocol only; anything a library prints goes to stderr.
const writeOut = process.stdout.write.bind(process.stdout)
const toErr = (...a) => process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : safeJson(x))).join(' ')}\n`)
console.log = toErr
console.info = toErr
console.debug = toErr
console.warn = toErr
function safeJson(x) {
  try {
    return JSON.stringify(x)
  } catch {
    return String(x)
  }
}
function emit(obj) {
  writeOut(`${JSON.stringify(obj)}\n`)
}

// A quiet logger in the shape Baileys expects (pino-like); warnings and errors go to stderr.
function makeLogger(bindings = {}) {
  const at = (level) => (obj, msg) => {
    if (level !== 'warn' && level !== 'error' && level !== 'fatal') return
    const text = typeof obj === 'string' ? obj : msg || obj?.err?.message || obj?.msg || ''
    if (text) process.stderr.write(`[baileys ${level}] ${text}\n`)
  }
  return {
    level: 'warn',
    bindings: () => bindings,
    child: (b) => makeLogger({ ...bindings, ...b }),
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
  }
}
const logger = makeLogger()

// Ids of messages this bridge sent, so their echoes are never forwarded as prompts.
const SENT_CAP = 512
const sentIds = new Set()
function rememberSent(id) {
  if (!id) return
  sentIds.add(id)
  while (sentIds.size > SENT_CAP) sentIds.delete(sentIds.values().next().value)
}

/** `123:4@s.whatsapp.net` → `123@s.whatsapp.net`. */
const bareJid = (jid) => String(jid || '').replace(/:\d+(?=@)/, '')
const jidUser = (jid) => bareJid(jid).split('@')[0]

/** The text of a message, looking through ephemeral/view-once wrappers. Null for non-text. */
function textOf(message) {
  let m = message
  for (let i = 0; i < 5 && m; i++) {
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message
    if (!inner) break
    m = inner
  }
  if (!m) return null
  return m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.videoMessage?.caption ?? m.documentMessage?.caption ?? null
}

/** Resolves within `ms`, or rejects. */
function withTimeout(p, ms, what) {
  let t
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out`), ms))))]).finally(() => clearTimeout(t))
}

let sock = null
let connected = false
let qrShown = false
let pendingPair = null // { id, phone }
let stopping = false
let attempt = 0
let cachedVersion

// One send at a time on the socket.
let sendChain = Promise.resolve()
const serial = (fn) => {
  const next = sendChain.then(fn, fn)
  sendChain = next.catch(() => {})
  return next
}

async function waVersion() {
  try {
    const { version } = await withTimeout(fetchLatestBaileysVersion(), 10_000, 'version check')
    cachedVersion = version
  } catch {
    /* the library's built-in version */
  }
  return cachedVersion
}

async function requestPair() {
  if (!pendingPair || !sock) return
  const { id, phone } = pendingPair
  pendingPair = null
  try {
    const code = await sock.requestPairingCode(phone)
    const pretty = code?.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
    emit({ type: 'pairing_code', code: pretty })
    emit({ type: 'result', id, ok: true, code: pretty })
  } catch (e) {
    emit({ type: 'result', id, ok: false, error: `Couldn't get a pairing code: ${e?.message || e}` })
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const version = await waVersion()
  qrShown = false
  connected = false
  const s = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // Needed for message retries; this bridge keeps no message store.
    getMessage: async () => ({ conversation: '' }),
  })
  sock = s

  s.ev.on('creds.update', saveCreds)

  s.ev.on('connection.update', async (u) => {
    if (s !== sock) return
    if (u.qr) {
      qrShown = true
      if (pendingPair) await requestPair()
      else {
        let svg = ''
        try {
          svg = await QRCode.toString(u.qr, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
        } catch {
          /* the app can still show the raw string */
        }
        emit({ type: 'qr', qr: u.qr, svg })
      }
    }
    if (u.connection === 'open') {
      connected = true
      attempt = 0
      emit({ type: 'connected', me: { id: bareJid(s.user?.id), lid: s.user?.lid ? bareJid(s.user.lid) : null, name: s.user?.name || s.user?.verifiedName || null } })
    }
    if (u.connection === 'close') {
      connected = false
      if (stopping) return
      const code = u.lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        emit({ type: 'logged_out' })
        process.exit(0)
      }
      if (code === DisconnectReason.connectionReplaced) {
        emit({ type: 'replaced' })
        process.exit(0)
      }
      if (code === DisconnectReason.timedOut && !state.creds.registered && qrShown) {
        // Nobody scanned: stop asking WhatsApp for codes until the user wants a new one.
        emit({ type: 'qr_timeout' })
        process.exit(0)
      }
      // 515 (restart required) follows a fresh link; reconnect right away. Otherwise back off.
      const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(60_000, 2000 * 2 ** attempt++)
      emit({ type: 'disconnected', reason: code ?? null, retryInMs: delay })
      setTimeout(() => start().catch(fail), delay)
    }
  })

  s.ev.on('messages.upsert', ({ messages, type }) => {
    if (s !== sock || (type !== 'notify' && type !== 'append')) return
    for (const msg of messages || []) {
      const key = msg.key || {}
      const chat = String(key.remoteJid || '')
      // Only your own messages outside groups, broadcasts and channels ever leave this process.
      if (!key.fromMe || !msg.message) continue
      if (/@(g\.us|broadcast|newsletter)$/.test(chat)) continue
      if (sentIds.has(key.id)) continue
      const me = [jidUser(s.user?.id), s.user?.lid ? jidUser(s.user.lid) : ''].filter(Boolean)
      const alt = String(key.remoteJidAlt || '')
      if (!me.includes(jidUser(chat)) && !(alt && me.includes(jidUser(alt)))) continue
      const text = textOf(msg.message)
      if (!text) continue
      const ts = Number(msg.messageTimestamp?.toNumber?.() ?? msg.messageTimestamp ?? 0)
      emit({ type: 'message', id: key.id, chat: bareJid(chat), chatAlt: alt ? bareJid(alt) : null, fromMe: true, text, at: ts ? ts * 1000 : Date.now() })
    }
  })
}

function fail(e) {
  emit({ type: 'log', level: 'error', msg: String(e?.stack || e) })
  if (stopping) return
  const delay = Math.min(60_000, 2000 * 2 ** attempt++)
  emit({ type: 'disconnected', reason: null, retryInMs: delay })
  setTimeout(() => start().catch(fail), delay)
}

async function handle(cmd) {
  const reply = (extra) => cmd.id != null && emit({ type: 'result', id: cmd.id, ...extra })
  switch (cmd.cmd) {
    case 'send': {
      if (!sock || !connected) return reply({ ok: false, error: 'WhatsApp is not connected.' })
      const to = bareJid(cmd.to)
      try {
        const messageId = generateMessageIDV2(sock.user?.id)
        rememberSent(messageId)
        const sent = await serial(() => withTimeout(sock.sendMessage(to, { text: String(cmd.text ?? '') }, { messageId }), 60_000, 'Sending'))
        rememberSent(sent?.key?.id)
        return reply({ ok: true, messageIds: [...new Set([messageId, sent?.key?.id].filter(Boolean))] })
      } catch (e) {
        return reply({ ok: false, error: String(e?.message || e) })
      }
    }
    case 'typing': {
      if (!sock || !connected) return
      await sock.sendPresenceUpdate(cmd.on ? 'composing' : 'paused', bareJid(cmd.to)).catch(() => {})
      return
    }
    case 'pair': {
      const phone = String(cmd.phone || '').replace(/\D/g, '')
      if (!/^\d{7,15}$/.test(phone)) return reply({ ok: false, error: 'Use the full number with the country code.' })
      if (sock?.authState?.creds?.registered) return reply({ ok: false, error: 'Already linked.' })
      pendingPair = { id: cmd.id, phone }
      if (sock && qrShown) await requestPair()
      return
    }
    case 'logout': {
      stopping = true
      try {
        if (sock) await withTimeout(sock.logout(), 10_000, 'Unlinking')
      } catch {
        /* the app deletes the auth files either way */
      }
      reply({ ok: true })
      emit({ type: 'logged_out' })
      process.exit(0)
    }
    case 'stop': {
      stopping = true
      try {
        sock?.end(undefined)
      } catch {
        /* exiting anyway */
      }
      process.exit(0)
    }
    default:
      return reply({ ok: false, error: `Unknown command: ${cmd.cmd}` })
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let cmd
  try {
    cmd = JSON.parse(line)
  } catch {
    return emit({ type: 'log', level: 'warn', msg: 'Ignored a line that is not JSON.' })
  }
  handle(cmd).catch((e) => emit({ type: 'log', level: 'error', msg: String(e?.message || e) }))
})
// The app went away: don't linger.
rl.on('close', () => process.exit(0))

process.on('uncaughtException', (e) => emit({ type: 'log', level: 'error', msg: String(e?.stack || e) }))
process.on('unhandledRejection', (e) => emit({ type: 'log', level: 'error', msg: String(e?.stack || e) }))

emit({ type: 'ready' })
start().catch(fail)
