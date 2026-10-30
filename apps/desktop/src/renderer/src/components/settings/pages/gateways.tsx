import { useState } from 'react'
import { normalizeSender } from '@harness/core/gateway-senders'
import type { PermissionMode } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { MODES } from '../../Composer'
import { NumberField, Row, Section, Select, TextField, Toggle } from '../../fields'
import type { PageProps } from '../common'

// ---------------------------------------------------------------- iMessage

export function IMessagePage({ app, save, onState, onError }: PageProps) {
  const g = app.settings.gateways.imessage
  const st = app.imessage
  const [busy, setBusy] = useState<'' | 'test' | 'check'>('')
  const [sent, setSent] = useState(false)
  const bots = app.settings.botOptions.enabled ? app.settings.bots.filter((b) => b.enabled) : []
  const run = (what: 'test' | 'check', p: () => Promise<typeof app>) => {
    setBusy(what)
    setSent(false)
    p()
      .then((s) => {
        onState(s)
        if (what === 'test') setSent(true)
      }, onError)
      .finally(() => setBusy(''))
  }
  const pickFolder = () => api.imessage.pickFolder().then((dir) => dir && save((s) => ((s.gateways.imessage.cwd = dir), s)), onError)
  return (
    <>
      <Section description="Text the agent from your phone. Messages from the senders below run in a chat on this Mac, and the reply comes back as a text.">
        <ul className="gw-notes small">
          <li>It only runs while Xarı Bülbül is open. Texts sent while it's closed are skipped.</li>
          <li>Anyone who can text from an allowed number or Apple ID can drive the agent. Add only your own.</li>
          <li>Keep the permission mode on Ask: approvals wait in the app, and you get a text when one does.</li>
        </ul>
        <Row label="Receive texts from iMessage" hint="Reads new messages from Messages on this Mac every few seconds.">
          <Toggle label="Receive texts from iMessage" value={g.enabled} onChange={(v) => save((s) => ((s.gateways.imessage.enabled = v), s))} />
        </Row>
      </Section>

      <Status app={app} busy={busy} onCheck={() => run('check', () => api.imessage.check())} />

      <Section title="Who and where">
        <Row label="Allowed senders" hint="Your own phone numbers (with the country code) and Apple ID emails. Nobody else is answered." wide>
          <SenderList value={g.senders} onChange={(senders) => save((s) => ((s.gateways.imessage.senders = senders), s))} />
        </Row>
        <Row label="Folder" hint="Each sender gets one chat, in this folder. It shows in the sidebar.">
          <div className="inline">
            <span className="mono small schedule-path" title={g.cwd}>
              {g.cwd || 'None'}
            </span>
            <button className="btn" onClick={pickFolder}>
              Choose…
            </button>
          </div>
        </Row>
        {bots.length > 0 && (
          <Row label="Bot" hint="New iMessage chats use this bot's persona and model.">
            <Select
              label="Bot"
              value={g.botId && bots.some((b) => b.id === g.botId) ? g.botId : ''}
              options={[{ value: '', label: 'None' }, ...bots.map((b) => ({ value: b.id, label: b.name }))]}
              onChange={(v) => save((s) => ((s.gateways.imessage.botId = v || null), s))}
            />
          </Row>
        )}
        <Row label="Permission mode" hint={`${MODES.find((m) => m.id === g.mode)?.hint ?? ''}. Applies to iMessage chats only.`}>
          <Select<PermissionMode> label="Permission mode" value={g.mode} options={MODES.map((m) => ({ value: m.id, label: m.label }))} onChange={(v) => save((s) => ((s.gateways.imessage.mode = v), s))} />
        </Row>
        {g.mode !== 'ask' && <div className="notice notice-warn small">With {MODES.find((m) => m.id === g.mode)?.label}, a text can make the agent {g.mode === 'plan' ? 'read your files' : 'change files or run commands'} without you seeing it first.</div>}
        <Row label="Check for new texts every" hint="Seconds between reads of the Messages database.">
          <NumberField label="Seconds" value={g.pollSeconds} min={2} max={300} onChange={(v) => v && save((s) => ((s.gateways.imessage.pollSeconds = Math.round(v)), s))} />
        </Row>
      </Section>

      <Section title="Replies">
        <Row label="Send test message" hint={`Texts “Xarı Bülbül is connected.” to ${g.senders[0] ?? 'the first allowed sender'}. The first send asks for permission to control Messages.`}>
          <div className="inline">
            <button className="btn" disabled={!g.senders.length || busy === 'test'} onClick={() => run('test', () => api.imessage.test())}>
              {busy === 'test' ? 'Sending…' : 'Send test message'}
            </button>
            {sent && (
              <span className="small okc" role="status">
                Sent.
              </span>
            )}
          </div>
        </Row>
        {st.automation === 'denied' ? (
          <div className="notice notice-error small gw-steps" role="alert">
            <div>
              <b>macOS blocked the app from sending through Messages.</b>
              <ol>
                <li>Open System Settings › Privacy &amp; Security › Automation.</li>
                <li>Under Xarı Bülbül, turn on Messages.</li>
                <li>Send the test message again.</li>
              </ol>
            </div>
            <button className="btn" onClick={() => api.imessage.openPrivacy('automation').catch(onError)}>
              Open Automation settings
            </button>
          </div>
        ) : (
          st.sendError && (
            <div className="notice notice-error small" role="alert">
              {st.sendError}
            </div>
          )
        )}
      </Section>
    </>
  )
}

function Status({ app, busy, onCheck }: { app: PageProps['app']; busy: string; onCheck: () => void }) {
  const st = app.imessage
  if (st.state === 'off') return null
  if (st.state === 'no-access') {
    return (
      <Section title="Full Disk Access">
        <div className="notice notice-warn small gw-steps" role="alert">
          <div>
            <b>macOS blocked reading your messages.</b> Messages keeps them in a protected folder, so the app needs Full Disk Access.
            <ol>
              <li>Open System Settings › Privacy &amp; Security › Full Disk Access.</li>
              <li>Turn on Xarı Bülbül. If it isn't listed, add it with the + button from Applications.</li>
              <li>Come back and press Check again. If it still can't read, quit and reopen the app.</li>
            </ol>
          </div>
        </div>
        <div className="inline">
          <button className="btn primary" onClick={() => api.imessage.openPrivacy('disk')}>
            Open Full Disk Access settings
          </button>
          <button className="btn" disabled={busy === 'check'} onClick={onCheck}>
            {busy === 'check' ? 'Checking…' : 'Check again'}
          </button>
        </div>
      </Section>
    )
  }
  const n = app.settings.gateways.imessage.senders.length
  const line =
    st.state === 'listening'
      ? `Listening for texts from ${n} ${n === 1 ? 'sender' : 'senders'}.${st.lastReceivedAt ? ` Last text ${new Date(st.lastReceivedAt).toLocaleTimeString()}.` : ''}`
      : (st.message ?? '')
  return (
    <div className={`notice small ${st.state === 'listening' ? '' : st.state === 'needs-setup' ? 'notice-warn' : 'notice-error'}`} role="status">
      <span>
        {line}
        {st.state === 'listening' && st.runError ? ` ${st.runError}` : ''}
      </span>
      {(st.state === 'error' || st.state === 'missing') && (
        <button className="btn" disabled={busy === 'check'} onClick={onCheck}>
          Check again
        </button>
      )}
    </div>
  )
}

/** Allowed senders: one per line in a list, each normalized when added. */
function SenderList({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const add = () => {
    const raw = text.trim()
    if (!raw) return
    const s = normalizeSender(raw)
    if (!s) {
      setError(raw.includes('@') ? 'That email doesn’t look right.' : 'Use the full number with the country code, like +15551234567.')
      return
    }
    setError('')
    setText('')
    if (!value.includes(s)) onChange([...value, s])
  }
  return (
    <div className="gw-senders">
      {value.length === 0 ? (
        <p className="muted small">Nobody yet, so no texts are answered.</p>
      ) : (
        <div className="list-field">
          {value.map((s) => (
            <div key={s} className="list-item">
              <code>{s}</code>
              <button className="link danger small" aria-label={`Remove ${s}`} onClick={() => onChange(value.filter((x) => x !== s))}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="inline">
        <input
          className="grow"
          aria-label="Phone number or email"
          aria-invalid={!!error}
          placeholder="+15551234567 or you@icloud.com"
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => (setText(e.target.value), setError(''))}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
        />
        <button className="btn" disabled={!text.trim()} onClick={add}>
          Add
        </button>
      </div>
      {error && (
        <div className="small warn" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- WhatsApp

export function WhatsAppPage({ app, save, onState, onError }: PageProps) {
  const g = app.settings.gateways.whatsapp
  const bots = app.settings.botOptions.enabled ? app.settings.bots.filter((b) => b.enabled) : []
  const pickFolder = () => api.whatsapp.pickFolder().then((dir) => dir && save((s) => ((s.gateways.whatsapp.cwd = dir), s)), onError)
  return (
    <>
      <Section description="Message the agent from WhatsApp on your phone. Link your account, then write in your own “Message yourself” chat. The reply comes back there.">
        <ul className="gw-notes small">
          <li>It only runs while Xarı Bülbül is open. Messages sent while it's closed are skipped.</li>
          <li>Only your “Message yourself” chat is read. Messages from other people and groups never reach the agent.</li>
          <li>Unofficial and at your own risk: this links like WhatsApp Web, and WhatsApp may restrict accounts that automate messages.</li>
          <li>WhatsApp support downloads the open-source Baileys library (MIT) and its libsignal dependency (GPL-3.0) to your computer when you turn it on. It needs Node.js 20 or newer.</li>
        </ul>
        <Row label="Use WhatsApp" hint="Starts a small helper program that stays connected to WhatsApp while the app is open.">
          <Toggle label="Use WhatsApp" value={g.enabled} onChange={(v) => save((s) => ((s.gateways.whatsapp.enabled = v), s))} />
        </Row>
      </Section>

      {g.enabled && <WhatsAppLink app={app} onState={onState} onError={onError} />}

      <Section title="Where it runs">
        <Row label="Folder" hint="The WhatsApp chat runs in this folder and shows in the sidebar as “💬 WhatsApp”.">
          <div className="inline">
            <span className="mono small schedule-path" title={g.cwd}>
              {g.cwd || 'None'}
            </span>
            <button className="btn" onClick={pickFolder}>
              Choose…
            </button>
          </div>
        </Row>
        {g.enabled && !g.cwd && <div className="notice notice-warn small">Choose a folder. Until then, messages get a reply asking for one.</div>}
        {bots.length > 0 && (
          <Row label="Bot" hint="The WhatsApp chat uses this bot's persona and model.">
            <Select
              label="Bot"
              value={g.botId && bots.some((b) => b.id === g.botId) ? g.botId : ''}
              options={[{ value: '', label: 'None' }, ...bots.map((b) => ({ value: b.id, label: b.name }))]}
              onChange={(v) => save((s) => ((s.gateways.whatsapp.botId = v || null), s))}
            />
          </Row>
        )}
        <Row label="Permission mode" hint={`${MODES.find((m) => m.id === g.mode)?.hint ?? ''}. Applies to the WhatsApp chat only.`}>
          <Select<PermissionMode> label="Permission mode" value={g.mode} options={MODES.map((m) => ({ value: m.id, label: m.label }))} onChange={(v) => save((s) => ((s.gateways.whatsapp.mode = v), s))} />
        </Row>
        {g.mode !== 'ask' && <div className="notice notice-warn small">With {MODES.find((m) => m.id === g.mode)?.label}, a message can make the agent {g.mode === 'plan' ? 'read your files' : 'change files or run commands'} without you seeing it first.</div>}
        <Row label="Reply prefix" hint="Starts every reply, so you can tell the agent's messages from yours. Your messages that start with it are ignored.">
          <TextField label="Reply prefix" value={g.prefix} onChange={(v) => save((s) => ((s.gateways.whatsapp.prefix = v.slice(0, 40)), s))} />
        </Row>
      </Section>
    </>
  )
}

/** Install progress, the QR code or pairing code, and the linked account. */
function WhatsAppLink({ app, onState, onError }: Pick<PageProps, 'app' | 'onState' | 'onError'>) {
  const st = app.whatsapp
  const [busy, setBusy] = useState<'' | 'retry' | 'pair' | 'unlink' | 'test'>('')
  const [phone, setPhone] = useState('')
  const [byPhone, setByPhone] = useState(false)
  const [sent, setSent] = useState(false)
  const run = (what: typeof busy, p: () => Promise<typeof app>) => {
    setBusy(what)
    setSent(false)
    p()
      .then((s) => {
        onState(s)
        if (what === 'test') setSent(true)
      }, onError)
      .finally(() => setBusy(''))
  }
  const retry = (label: string) => (
    <button className="btn primary" disabled={busy === 'retry'} onClick={() => run('retry', () => api.whatsapp.retry())}>
      {label}
    </button>
  )

  if (st.state === 'off') return null
  if (st.state === 'needs-node') {
    return (
      <Section title="Link your account">
        <div className="notice notice-warn small" role="alert">
          <span>{st.message ?? 'Install Node.js 20+ to use WhatsApp.'}</span>
        </div>
        <div className="inline">
          <button className="btn primary" onClick={() => api.app.openExternal(st.url ?? 'https://nodejs.org/en/download').catch(onError)}>
            Download Node.js
          </button>
          <button className="btn" disabled={busy === 'retry'} onClick={() => run('retry', () => api.whatsapp.retry())}>
            I installed it, try again
          </button>
        </div>
      </Section>
    )
  }
  if (st.state === 'installing') {
    return (
      <Section title="Link your account">
        <div className="notice small" role="status">
          <span>
            {st.message}
            {st.progress ? ` ${st.progress}` : ''}
          </span>
        </div>
      </Section>
    )
  }
  if (st.state === 'linking') {
    return (
      <Section title="Link your account">
        <div className="wa-link">
          {st.pairingCode ? (
            <div className="wa-code" aria-live="polite">
              <span className="small muted">Your code</span>
              <b className="mono">{st.pairingCode}</b>
            </div>
          ) : st.qrSvg ? (
            <img className="wa-qr" alt="QR code to link WhatsApp" src={`data:image/svg+xml;utf8,${encodeURIComponent(st.qrSvg)}`} />
          ) : (
            <code className="small">{st.qr}</code>
          )}
          <ol className="small">
            <li>On your phone, open WhatsApp › Settings › Linked devices.</li>
            <li>Tap Link a device.</li>
            <li>{st.pairingCode ? 'Tap “Link with phone number instead” and type the code above.' : 'Scan this code. It changes every few seconds.'}</li>
          </ol>
        </div>
        {!st.pairingCode && (
          <div className="inline">
            {byPhone ? (
              <>
                <input
                  className="grow"
                  aria-label="Your WhatsApp number"
                  placeholder="+4915112345678"
                  value={phone}
                  spellCheck={false}
                  autoComplete="tel"
                  onChange={(e) => setPhone(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && phone.trim() && run('pair', () => api.whatsapp.pair(phone))}
                />
                <button className="btn" disabled={!phone.trim() || busy === 'pair'} onClick={() => run('pair', () => api.whatsapp.pair(phone))}>
                  {busy === 'pair' ? 'Getting a code…' : 'Get code'}
                </button>
              </>
            ) : (
              <button className="link small" onClick={() => setByPhone(true)}>
                Link with phone number instead
              </button>
            )}
          </div>
        )}
      </Section>
    )
  }
  if (st.state === 'connected') {
    return (
      <Section title="Linked">
        <div className="notice small" role="status">
          <span>
            Linked to {st.account ?? 'your account'}. Write in your “Message yourself” chat to reach the agent.
            {st.lastReceivedAt ? ` Last message ${new Date(st.lastReceivedAt).toLocaleTimeString()}.` : ''}
            {st.runError ? ` ${st.runError}` : ''}
          </span>
        </div>
        {st.sendError && (
          <div className="notice notice-error small" role="alert">
            {st.sendError}
          </div>
        )}
        <div className="inline">
          <button className="btn" disabled={busy === 'test'} onClick={() => run('test', () => api.whatsapp.test())}>
            {busy === 'test' ? 'Sending…' : 'Send test message'}
          </button>
          {sent && (
            <span className="small okc" role="status">
              Sent.
            </span>
          )}
          <button className="btn danger" disabled={busy === 'unlink'} onClick={() => run('unlink', () => api.whatsapp.unlink())}>
            {busy === 'unlink' ? 'Unlinking…' : 'Unlink'}
          </button>
        </div>
      </Section>
    )
  }
  const held = st.state === 'qr-expired' ? 'Show a new code' : st.state === 'logged-out' ? 'Link again' : st.state === 'replaced' ? 'Use this computer' : st.state === 'error' ? 'Try again' : null
  return (
    <Section title="Link your account">
      <div className={`notice small ${st.state === 'error' ? 'notice-error' : st.state === 'reconnecting' || held ? 'notice-warn' : ''}`} role="status">
        <span>{st.message}</span>
      </div>
      {held && <div className="inline">{retry(held)}</div>}
    </Section>
  )
}
