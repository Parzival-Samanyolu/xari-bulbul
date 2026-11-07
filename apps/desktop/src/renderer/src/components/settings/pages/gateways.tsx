import { useState } from 'react'
import { normalizeSender } from '@harness/core/gateway-senders'
import type { PermissionMode } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { useFormat, useT } from '../../../lib/i18n'
import { modes } from '../../Composer'
import { NumberField, Row, Section, Select, TextField, Toggle } from '../../fields'
import type { PageProps } from '../common'

// ---------------------------------------------------------------- iMessage

export function IMessagePage({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
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
      <Section description={t('settings.gateways.imIntro')}>
        <ul className="gw-notes small">
          <li>{t('settings.gateways.imNoteOpen')}</li>
          <li>{t('settings.gateways.imNoteSenders')}</li>
          <li>{t('settings.gateways.imNoteAsk')}</li>
        </ul>
        <Row label={t('settings.gateways.imReceive')} search="Receive texts from iMessage" hint={t('settings.gateways.imReceiveHint')}>
          <Toggle label={t('settings.gateways.imReceive')} value={g.enabled} onChange={(v) => save((s) => ((s.gateways.imessage.enabled = v), s))} />
        </Row>
      </Section>

      <Status app={app} busy={busy} onCheck={() => run('check', () => api.imessage.check())} />

      <Section title={t('settings.gateways.whoAndWhere')}>
        <Row label={t('settings.gateways.allowedSenders')} search="Allowed senders" hint={t('settings.gateways.allowedSendersHint')} wide>
          <SenderList value={g.senders} onChange={(senders) => save((s) => ((s.gateways.imessage.senders = senders), s))} />
        </Row>
        <Row label={t('settings.gateways.folder')} search="Folder" hint={t('settings.gateways.imFolderHint')}>
          <div className="inline">
            <span className="mono small schedule-path" title={g.cwd}>
              {g.cwd || t('common.none')}
            </span>
            <button className="btn" onClick={pickFolder}>
              {t('settings.parts.choose')}
            </button>
          </div>
        </Row>
        {bots.length > 0 && (
          <Row label={t('settings.gateways.bot')} search="Bot" hint={t('settings.gateways.imBotHint')}>
            <Select
              label={t('settings.gateways.bot')}
              value={g.botId && bots.some((b) => b.id === g.botId) ? g.botId : ''}
              options={[{ value: '', label: t('common.none') }, ...bots.map((b) => ({ value: b.id, label: b.name }))]}
              onChange={(v) => save((s) => ((s.gateways.imessage.botId = v || null), s))}
            />
          </Row>
        )}
        <Row label={t('settings.gateways.permissionMode')} search="Permission mode" hint={t('settings.gateways.imModeHint', { hint: modes(t).find((m) => m.id === g.mode)?.hint ?? '' })}>
          <Select<PermissionMode> label={t('settings.gateways.permissionMode')} value={g.mode} options={modes(t).map((m) => ({ value: m.id, label: m.label }))} onChange={(v) => save((s) => ((s.gateways.imessage.mode = v), s))} />
        </Row>
        {g.mode !== 'ask' && (
          <div className="notice notice-warn small">
            {t(g.mode === 'plan' ? 'settings.gateways.imModeWarnPlan' : 'settings.gateways.imModeWarn', { mode: modes(t).find((m) => m.id === g.mode)?.label ?? g.mode })}
          </div>
        )}
        <Row label={t('settings.gateways.startFresh')} search="Start fresh" hint={t('settings.gateways.imStartFreshHint')}>
          <QuietHours value={g.newChatAfterHours} onChange={(v) => save((s) => ((s.gateways.imessage.newChatAfterHours = v), s))} />
        </Row>
        <Row label={t('settings.gateways.pollEvery')} search="Check for new texts every" hint={t('settings.gateways.pollEveryHint')}>
          <NumberField label={t('settings.gateways.pollSeconds')} value={g.pollSeconds} min={2} max={300} onChange={(v) => v && save((s) => ((s.gateways.imessage.pollSeconds = Math.round(v)), s))} />
        </Row>
      </Section>

      <Section title={t('settings.gateways.replies')}>
        <Row
          label={t('settings.gateways.sendTest')}
          search="Send test message"
          hint={g.senders[0] ? t('settings.gateways.imSendTestHint', { sender: g.senders[0] }) : t('settings.gateways.imSendTestHintNobody')}
        >
          <div className="inline">
            <button className="btn" disabled={!g.senders.length || busy === 'test'} onClick={() => run('test', () => api.imessage.test())}>
              {busy === 'test' ? t('settings.parts.sending') : t('settings.gateways.sendTest')}
            </button>
            {sent && (
              <span className="small okc" role="status">
                {t('settings.parts.sent')}
              </span>
            )}
          </div>
        </Row>
        {st.automation === 'denied' ? (
          <div className="notice notice-error small gw-steps" role="alert">
            <div>
              <b>{t('settings.gateways.automationBlocked')}</b>
              <ol>
                <li>{t('settings.gateways.automationStep1')}</li>
                <li>{t('settings.gateways.automationStep2')}</li>
                <li>{t('settings.gateways.automationStep3')}</li>
              </ol>
            </div>
            <button className="btn" onClick={() => api.imessage.openPrivacy('automation').catch(onError)}>
              {t('settings.gateways.openAutomation')}
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
  const { t } = useT()
  const fmt = useFormat()
  const st = app.imessage
  if (st.state === 'off') return null
  if (st.state === 'no-access') {
    return (
      <Section title={t('settings.gateways.fullDiskAccess')}>
        <div className="notice notice-warn small gw-steps" role="alert">
          <div>
            <b>{t('settings.gateways.diskBlocked')}</b> {t('settings.gateways.diskBlockedWhy')}
            <ol>
              <li>{t('settings.gateways.diskStep1')}</li>
              <li>{t('settings.gateways.diskStep2')}</li>
              <li>{t('settings.gateways.diskStep3')}</li>
            </ol>
          </div>
        </div>
        <div className="inline">
          <button className="btn primary" onClick={() => api.imessage.openPrivacy('disk')}>
            {t('settings.gateways.openDiskAccess')}
          </button>
          <button className="btn" disabled={busy === 'check'} onClick={onCheck}>
            {busy === 'check' ? t('settings.parts.checking') : t('settings.parts.checkAgain')}
          </button>
        </div>
      </Section>
    )
  }
  const n = app.settings.gateways.imessage.senders.length
  const line =
    st.state === 'listening'
      ? t('settings.gateways.listening', { count: n }) + (st.lastReceivedAt ? ` ${t('settings.gateways.lastText', { time: fmt.date(st.lastReceivedAt, { timeStyle: 'medium' }) })}` : '')
      : (st.message ?? '')
  return (
    <div className={`notice small ${st.state === 'listening' ? '' : st.state === 'needs-setup' ? 'notice-warn' : 'notice-error'}`} role="status">
      <span>
        {line}
        {st.state === 'listening' && st.runError ? ` ${st.runError}` : ''}
      </span>
      {(st.state === 'error' || st.state === 'missing') && (
        <button className="btn" disabled={busy === 'check'} onClick={onCheck}>
          {t('settings.parts.checkAgain')}
        </button>
      )}
    </div>
  )
}

/** Allowed senders: one per line in a list, each normalized when added. */
function SenderList({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useT()
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const add = () => {
    const raw = text.trim()
    if (!raw) return
    const s = normalizeSender(raw)
    if (!s) {
      setError(raw.includes('@') ? t('settings.gateways.badEmail') : t('settings.gateways.badNumber', { example: '+15551234567' }))
      return
    }
    setError('')
    setText('')
    if (!value.includes(s)) onChange([...value, s])
  }
  return (
    <div className="gw-senders">
      {value.length === 0 ? (
        <p className="muted small">{t('settings.gateways.noSenders')}</p>
      ) : (
        <div className="list-field">
          {value.map((s) => (
            <div key={s} className="list-item">
              <code>{s}</code>
              <button className="link danger small" aria-label={t('settings.gateways.removeSender', { sender: s })} onClick={() => onChange(value.filter((x) => x !== s))}>
                {t('common.remove')}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="inline">
        <input
          className="grow"
          aria-label={t('settings.gateways.senderLabel')}
          aria-invalid={!!error}
          placeholder={t('settings.gateways.senderPlaceholder', { phone: '+15551234567', email: 'you@icloud.com' })}
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => (setText(e.target.value), setError(''))}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
        />
        <button className="btn" disabled={!text.trim()} onClick={add}>
          {t('common.add')}
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
  const { t } = useT()
  const g = app.settings.gateways.whatsapp
  const bots = app.settings.botOptions.enabled ? app.settings.bots.filter((b) => b.enabled) : []
  const pickFolder = () => api.whatsapp.pickFolder().then((dir) => dir && save((s) => ((s.gateways.whatsapp.cwd = dir), s)), onError)
  return (
    <>
      <Section description={t('settings.gateways.waIntro')}>
        <ul className="gw-notes small">
          <li>{t('settings.gateways.waNoteOpen')}</li>
          <li>{t('settings.gateways.waNoteSelf')}</li>
          <li>{t('settings.gateways.waNoteRisk')}</li>
          <li>{t('settings.gateways.waNoteBaileys')}</li>
        </ul>
        <Row label={t('settings.gateways.useWhatsApp')} search="Use WhatsApp" hint={t('settings.gateways.useWhatsAppHint')}>
          <Toggle label={t('settings.gateways.useWhatsApp')} value={g.enabled} onChange={(v) => save((s) => ((s.gateways.whatsapp.enabled = v), s))} />
        </Row>
      </Section>

      {g.enabled && <WhatsAppLink app={app} onState={onState} onError={onError} />}

      <Section title={t('settings.gateways.whereItRuns')}>
        <Row label={t('settings.gateways.folder')} search="Folder" hint={t('settings.gateways.waFolderHint', { name: '💬 WhatsApp' })}>
          <div className="inline">
            <span className="mono small schedule-path" title={g.cwd}>
              {g.cwd || t('common.none')}
            </span>
            <button className="btn" onClick={pickFolder}>
              {t('settings.parts.choose')}
            </button>
          </div>
        </Row>
        {g.enabled && !g.cwd && <div className="notice notice-warn small">{t('settings.gateways.waNoFolder')}</div>}
        {bots.length > 0 && (
          <Row label={t('settings.gateways.bot')} search="Bot" hint={t('settings.gateways.waBotHint')}>
            <Select
              label={t('settings.gateways.bot')}
              value={g.botId && bots.some((b) => b.id === g.botId) ? g.botId : ''}
              options={[{ value: '', label: t('common.none') }, ...bots.map((b) => ({ value: b.id, label: b.name }))]}
              onChange={(v) => save((s) => ((s.gateways.whatsapp.botId = v || null), s))}
            />
          </Row>
        )}
        <Row label={t('settings.gateways.permissionMode')} search="Permission mode" hint={t('settings.gateways.waModeHint', { hint: modes(t).find((m) => m.id === g.mode)?.hint ?? '' })}>
          <Select<PermissionMode> label={t('settings.gateways.permissionMode')} value={g.mode} options={modes(t).map((m) => ({ value: m.id, label: m.label }))} onChange={(v) => save((s) => ((s.gateways.whatsapp.mode = v), s))} />
        </Row>
        {g.mode !== 'ask' && (
          <div className="notice notice-warn small">
            {t(g.mode === 'plan' ? 'settings.gateways.waModeWarnPlan' : 'settings.gateways.waModeWarn', { mode: modes(t).find((m) => m.id === g.mode)?.label ?? g.mode })}
          </div>
        )}
        <Row label={t('settings.gateways.replyPrefix')} search="Reply prefix" hint={t('settings.gateways.replyPrefixHint')}>
          <TextField label={t('settings.gateways.replyPrefix')} value={g.prefix} onChange={(v) => save((s) => ((s.gateways.whatsapp.prefix = v.slice(0, 40)), s))} />
        </Row>
      </Section>

      <WhatsAppChats app={app} save={save} onState={onState} onError={onError} />
    </>
  )
}

const QUIET_HOURS = [2, 4, 8, 12, 24, 48]

/** "Never" or a number of quiet hours after which a gateway chat starts over. */
function QuietHours({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const { t } = useT()
  const label = (h: number) => (h % 24 === 0 ? t('settings.gateways.quietDays', { count: h / 24 }) : t('settings.gateways.quietHours', { count: h }))
  const options = [{ value: '', label: t('settings.gateways.quietNever') }, ...QUIET_HOURS.map((h) => ({ value: String(h), label: label(h) }))]
  if (value && !QUIET_HOURS.includes(value)) options.push({ value: String(value), label: t('settings.gateways.quietHours', { count: value }) })
  return <Select label={t('settings.gateways.startFresh')} value={value ? String(value) : ''} options={options} onChange={(v) => onChange(v ? Number(v) : null)} />
}

/** The current WhatsApp chat and earlier ones: start a new one, delete old ones. */
function WhatsAppChats({ app, save, onState, onError }: Pick<PageProps, 'app' | 'save' | 'onState' | 'onError'>) {
  const { t, lang } = useT()
  const day = (ts: number) => new Date(ts).toLocaleDateString(lang, { month: 'short', day: 'numeric', year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
  const chats = app.whatsappChats
  const earlier = chats.filter((c) => !c.current)
  const current = chats.find((c) => c.current)
  const remove = (id: string, title: string) => confirm(t('settings.gateways.deleteChatConfirm', { title })) && api.sessions.remove(id).then(onState, onError)
  const removeEarlier = () => {
    if (!confirm(t('settings.gateways.deleteEarlierConfirm', { count: earlier.length }))) return
    earlier.reduce<Promise<unknown>>((p, c) => p.then(() => api.sessions.remove(c.id).then(onState)), Promise.resolve()).catch(onError)
  }
  return (
    <Section title={t('settings.gateways.chats')} description={t('settings.gateways.chatsHint')}>
      <Row label={t('settings.gateways.currentChat')} search="Current chat" hint={current ? t('settings.gateways.since', { date: day(current.createdAt) }) : t('settings.gateways.noCurrentChat')}>
        <div className="inline">
          {current && <span className="small">{current.title}</span>}
          <button className="btn" disabled={!current} onClick={() => api.whatsapp.newChat().then(onState, onError)}>
            {t('settings.gateways.newChat')}
          </button>
        </div>
      </Row>
      <Row label={t('settings.gateways.startFresh')} search="Start fresh" hint={t('settings.gateways.waStartFreshHint')}>
        <QuietHours value={app.settings.gateways.whatsapp.newChatAfterHours} onChange={(v) => save((s) => ((s.gateways.whatsapp.newChatAfterHours = v), s))} />
      </Row>
      {earlier.length > 0 && (
        <>
          <ul className="wa-chats" aria-label={t('settings.gateways.earlierChats')}>
            {earlier.map((c) => (
              <li key={c.id} className="wa-chat">
                <span className="grow">{c.title}</span>
                <span className="muted small">
                  {day(c.createdAt)}
                  {c.updatedAt - c.createdAt > 86_400_000 ? ` – ${day(c.updatedAt)}` : ''}
                </span>
                <button className="link danger small" aria-label={t('settings.gateways.deleteChatLabel', { title: c.title, date: day(c.updatedAt) })} onClick={() => remove(c.id, c.title)}>
                  {t('common.delete')}
                </button>
              </li>
            ))}
          </ul>
          {earlier.length > 1 && (
            <button className="link danger small" onClick={removeEarlier}>
              {earlier.length === 1 ? t('settings.gateways.deleteEarlierOne') : t('settings.gateways.deleteEarlier', { count: earlier.length })}
            </button>
          )}
        </>
      )}
    </Section>
  )
}

/** Install progress, the QR code or pairing code, and the linked account. */
function WhatsAppLink({ app, onState, onError }: Pick<PageProps, 'app' | 'onState' | 'onError'>) {
  const { t } = useT()
  const fmt = useFormat()
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
      <Section title={t('settings.gateways.linkAccount')}>
        <div className="notice notice-warn small" role="alert">
          <span>{st.message ?? t('settings.gateways.needsNode')}</span>
        </div>
        <div className="inline">
          <button className="btn primary" onClick={() => api.app.openExternal(st.url ?? 'https://nodejs.org/en/download').catch(onError)}>
            {t('settings.gateways.downloadNode')}
          </button>
          <button className="btn" disabled={busy === 'retry'} onClick={() => run('retry', () => api.whatsapp.retry())}>
            {t('settings.gateways.installedRetry')}
          </button>
        </div>
      </Section>
    )
  }
  if (st.state === 'installing') {
    return (
      <Section title={t('settings.gateways.linkAccount')}>
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
      <Section title={t('settings.gateways.linkAccount')}>
        <div className="wa-link">
          {st.pairingCode ? (
            <div className="wa-code" aria-live="polite">
              <span className="small muted">{t('settings.gateways.yourCode')}</span>
              <b className="mono">{st.pairingCode}</b>
            </div>
          ) : st.qrSvg ? (
            <img className="wa-qr" alt={t('settings.gateways.qrAlt')} src={`data:image/svg+xml;utf8,${encodeURIComponent(st.qrSvg)}`} />
          ) : (
            <code className="small">{st.qr}</code>
          )}
          <ol className="small">
            <li>{t('settings.gateways.linkStep1')}</li>
            <li>{t('settings.gateways.linkStep2')}</li>
            <li>{st.pairingCode ? t('settings.gateways.linkStep3Code') : t('settings.gateways.linkStep3Qr')}</li>
          </ol>
        </div>
        {!st.pairingCode && (
          <div className="inline">
            {byPhone ? (
              <>
                <input
                  className="grow"
                  aria-label={t('settings.gateways.yourNumber')}
                  placeholder="+4915112345678"
                  value={phone}
                  spellCheck={false}
                  autoComplete="tel"
                  onChange={(e) => setPhone(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && phone.trim() && run('pair', () => api.whatsapp.pair(phone))}
                />
                <button className="btn" disabled={!phone.trim() || busy === 'pair'} onClick={() => run('pair', () => api.whatsapp.pair(phone))}>
                  {busy === 'pair' ? t('settings.gateways.gettingCode') : t('settings.gateways.getCode')}
                </button>
              </>
            ) : (
              <button className="link small" onClick={() => setByPhone(true)}>
                {t('settings.gateways.linkWithPhone')}
              </button>
            )}
          </div>
        )}
      </Section>
    )
  }
  if (st.state === 'connected') {
    return (
      <Section title={t('settings.gateways.linked')}>
        <div className="notice small" role="status">
          <span>
            {st.account ? t('settings.gateways.linkedTo', { account: st.account }) : t('settings.gateways.linkedToYours')}
            {st.lastReceivedAt ? ` ${t('settings.gateways.lastMessage', { time: fmt.date(st.lastReceivedAt, { timeStyle: 'medium' }) })}` : ''}
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
            {busy === 'test' ? t('settings.parts.sending') : t('settings.gateways.sendTest')}
          </button>
          {sent && (
            <span className="small okc" role="status">
              {t('settings.parts.sent')}
            </span>
          )}
          <button className="btn danger" disabled={busy === 'unlink'} onClick={() => run('unlink', () => api.whatsapp.unlink())}>
            {busy === 'unlink' ? t('settings.gateways.unlinking') : t('settings.gateways.unlink')}
          </button>
        </div>
      </Section>
    )
  }
  const held =
    st.state === 'qr-expired'
      ? t('settings.gateways.newCode')
      : st.state === 'logged-out'
        ? t('settings.gateways.linkAgain')
        : st.state === 'replaced'
          ? t('settings.gateways.useThisComputer')
          : st.state === 'error'
            ? t('settings.gateways.tryAgain')
            : null
  return (
    <Section title={t('settings.gateways.linkAccount')}>
      <div className={`notice small ${st.state === 'error' ? 'notice-error' : st.state === 'reconnecting' || held ? 'notice-warn' : ''}`} role="status">
        <span>{st.message}</span>
      </div>
      {held && <div className="inline">{retry(held)}</div>}
    </Section>
  )
}
