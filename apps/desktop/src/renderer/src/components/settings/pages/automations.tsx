import { useState } from 'react'
import { MAIL_PRESETS, mailPreset } from '@harness/core/mail-presets'
import type { Settings } from '../../../../../shared/ipc'
import type { MessageKey } from '../../../../../shared/i18n/catalog'
import { api } from '../../../lib/api'
import { modelLabel } from '../../../lib/format'
import { useFormat, useT } from '../../../lib/i18n'
import { ListField, NumberField, Row, Section, Select, TextField, Toggle } from '../../fields'
import { ModelPicker } from '../../ModelPicker'
import { SecretInput, type PageProps } from '../common'

type T = ReturnType<typeof useT>['t']
type Automation = Settings['schedules'][number]
type MailAccount = Settings['mail']['accounts'][number]
type NotesSource = Settings['notes']['sources'][number]

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

// ---------------------------------------------------------------- templates

/** Ready-made automations. The prompt is written in the UI language; the model reads any. */
const TEMPLATES = ['blank', 'followUps', 'replyNew', 'greetings', 'digest'] as const
type Template = (typeof TEMPLATES)[number]

function fromTemplate(tpl: Template, t: T, cwd: string): Automation {
  const base: Automation = {
    id: newId('sch'),
    name: t(`settings.auto.tpl.${tpl}.name` as MessageKey),
    enabled: true,
    cwd,
    prompt: tpl === 'blank' ? '' : t(`settings.auto.tpl.${tpl}.prompt` as MessageKey),
    when: { kind: 'daily', time: '09:00', weekday: 1, hours: 24 },
    model: null,
    trigger: 'time',
    mailTrigger: { account: '', folder: 'INBOX', from: '', everyMinutes: 5 },
    mailAccounts: [],
    notes: [],
    send: { mode: 'review', maxPerRun: 10, maxPerDay: 50 },
    after: { notify: 'desktop', runNext: '' },
  }
  if (tpl === 'replyNew') base.trigger = 'mail'
  if (tpl === 'greetings') base.when.time = '08:00'
  if (tpl === 'digest') {
    base.when.time = '08:30'
    base.after.notify = 'whatsapp'
  }
  return base
}

// ---------------------------------------------------------------- Automations

const frequencies = (t: T) =>
  [
    { value: 'daily', label: t('settings.data.everyDay') },
    { value: 'weekly', label: t('settings.data.everyWeek') },
    { value: 'interval', label: t('settings.data.everyFewHours') },
  ] as const

/** Weekday names in the UI language, Sunday first (`when.weekday` is 0–6 from Sunday). */
function weekdays(lang: string) {
  const name = new Intl.DateTimeFormat(lang, { weekday: 'long' })
  // 1 January 2023 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const label = name.format(new Date(2023, 0, 1 + i))
    return { value: String(i), label: label.charAt(0).toLocaleUpperCase(lang) + label.slice(1) }
  })
}

export function AutomationsPage({ app, save, onState, onError, go }: PageProps) {
  const { t, lang } = useT()
  const fmt = useFormat()
  const when = (ts: number | null) => (ts == null ? '—' : fmt.date(ts, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
  const list = app.settings.schedules
  const accounts = app.settings.mail.accounts
  const sources = app.settings.notes.sources
  const status = new Map(app.schedules.map((s) => [s.id, s]))
  const [picking, setPicking] = useState<number | null>(null)
  const [template, setTemplate] = useState<Template>('blank')
  const update = (i: number, fn: (s: Automation) => void) => save((st) => (fn(st.schedules[i]), st))
  const add = () => save((st) => (st.schedules.push(fromTemplate(template, t, app.workspace ?? '')), st))
  const pickFolder = (i: number) => api.schedules.pickFolder().then((dir) => dir && update(i, (s) => (s.cwd = dir)), onError)
  const toggleIn = (arr: string[], id: string) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id])
  const days = weekdays(lang)
  const notifyOptions = [
    { value: 'desktop', label: t('settings.auto.notifyDesktop') },
    { value: 'whatsapp', label: 'WhatsApp' },
    ...(app.platform === 'darwin' ? [{ value: 'imessage', label: 'iMessage' }] : []),
    { value: 'none', label: t('settings.auto.notifyNone') },
  ] as { value: Automation['after']['notify']; label: string }[]
  return (
    <>
      <Section>
        {(!accounts.length || !sources.length) && (
          <div className="notice small">
            {!accounts.length && (
              <div>
                {t('settings.auto.noAccountsYet')}{' '}
                <button className="link small" onClick={() => go('automations.mail')}>
                  {t('settings.auto.addMailAccount')}
                </button>
              </div>
            )}
            {!sources.length && (
              <div>
                {t('settings.auto.noNotesYet')}{' '}
                <button className="link small" onClick={() => go('automations.notes')}>
                  {t('settings.auto.addNotes')}
                </button>
              </div>
            )}
          </div>
        )}
        {list.length === 0 && (
          <div className="empty-box">
            <b>{t('settings.auto.none')}</b>
            <span className="muted small">{t('settings.auto.noneHint')}</span>
          </div>
        )}
        {list.map((sch, i) => {
          const st = status.get(sch.id)
          const isMail = sch.trigger === 'mail'
          const missing = !sch.cwd.trim()
            ? t('settings.data.chooseFolder')
            : !sch.prompt.trim()
              ? t('settings.data.writePrompt')
              : isMail && !sch.mailTrigger.account
                ? t('settings.auto.chooseTriggerAccount')
                : null
          const lastRun = st?.lastRun ? t('settings.data.lastRunAt', { when: when(st.lastRun), ago: Date.now() - st.lastRun < 60_000 ? t('settings.data.justNow') : t('settings.data.timeAgo', { time: fmt.ago(st.lastRun) }) }) : t('settings.data.never')
          const nextRun = !sch.enabled || missing ? t('settings.data.nextRunOff') : isMail ? t('settings.auto.onNewMail') : when(st?.nextRun ?? null)
          const others = list.filter((x) => x.id !== sch.id)
          return (
            <div key={sch.id} className="provider-card schedule">
              <div className="provider-head">
                <Toggle label={t('settings.data.enableSchedule', { name: sch.name })} value={sch.enabled} onChange={(v) => update(i, (s) => (s.enabled = v))} />
                <b>{sch.name || t('settings.data.schedule')}</b>
                {st?.running && (
                  <span className="badge ok" role="status">
                    {t('settings.data.running')}
                  </span>
                )}
                <div className="spacer" />
                <button className="btn ghost" disabled={!!missing || st?.running} onClick={() => api.schedules.runNow(sch.id).then(onState, onError)}>
                  {t('settings.data.runNow')}
                </button>
                <button
                  className="link danger small"
                  onClick={() => confirm(sch.name ? t('settings.data.removeScheduleConfirm', { name: sch.name }) : t('settings.data.removeThisScheduleConfirm')) && save((x) => ((x.schedules = x.schedules.filter((y) => y.id !== sch.id)), x))}
                >
                  {t('common.remove')}
                </button>
              </div>
              <div className="muted small schedule-times">
                {t('settings.data.lastRun', { when: lastRun })} · {t('settings.data.nextRun', { when: nextRun })}
              </div>
              {missing && <div className="small warn">{missing}</div>}
              {st?.error && <div className="notice notice-error small">{t('settings.data.lastRunFailed', { error: st.error })}</div>}
              <Row label={t('settings.data.name')} labelFor={`sch-name-${sch.id}`} search="">
                <TextField label={t('settings.data.name')} id={`sch-name-${sch.id}`} value={sch.name} onChange={(v) => update(i, (s) => (s.name = v))} />
              </Row>
              <Row label={t('settings.data.folder')} hint={t('settings.data.folderHint')} search="">
                <div className="inline">
                  <span className="mono small schedule-path" title={sch.cwd}>
                    {sch.cwd || t('common.none')}
                  </span>
                  <button className="btn" onClick={() => pickFolder(i)}>
                    {t('settings.parts.choose')}
                  </button>
                </div>
              </Row>
              <Row label={t('settings.auto.instructions')} hint={t('settings.auto.instructionsHint')} wide search="">
                <TextField label={t('settings.auto.instructions')} multiline rows={6} value={sch.prompt} placeholder={t('settings.data.promptPlaceholder')} onChange={(v) => update(i, (s) => (s.prompt = v))} />
              </Row>
              <Row label={t('settings.auto.starts')} search="">
                <Select
                  label={t('settings.auto.starts')}
                  value={sch.trigger}
                  options={[
                    { value: 'time', label: t('settings.auto.startsTime') },
                    { value: 'mail', label: t('settings.auto.startsMail') },
                  ]}
                  onChange={(v) => update(i, (s) => (s.trigger = v))}
                />
              </Row>
              {!isMail ? (
                <Row label={t('settings.data.frequency')} search="">
                  <div className="inline">
                    <Select label={t('settings.data.frequency')} value={sch.when.kind} options={[...frequencies(t)]} onChange={(v) => update(i, (s) => (s.when.kind = v))} />
                    {sch.when.kind === 'weekly' && <Select label={t('settings.data.weekday')} value={String(sch.when.weekday)} options={days} onChange={(v) => update(i, (s) => (s.when.weekday = Number(v)))} />}
                    {sch.when.kind !== 'interval' ? (
                      <input type="time" aria-label={t('settings.data.time')} value={sch.when.time} onChange={(e) => e.target.value && update(i, (s) => (s.when.time = e.target.value))} />
                    ) : (
                      <IntervalField hours={sch.when.hours} onChange={(h) => update(i, (s) => (s.when.hours = h))} />
                    )}
                  </div>
                </Row>
              ) : (
                <Row label={t('settings.auto.watch')} hint={t('settings.auto.watchHint')} search="">
                  <div className="inline">
                    <Select
                      label={t('settings.auto.watchAccount')}
                      value={sch.mailTrigger.account}
                      options={[{ value: '', label: t('settings.auto.pickAccount') }, ...accounts.map((a) => ({ value: a.id, label: a.address || a.name }))]}
                      onChange={(v) => update(i, (s) => (s.mailTrigger.account = v))}
                    />
                    <TextField label={t('settings.auto.watchFolder')} value={sch.mailTrigger.folder} placeholder="INBOX" onChange={(v) => update(i, (s) => (s.mailTrigger.folder = v.trim() || 'INBOX'))} />
                    <TextField label={t('settings.auto.watchFrom')} value={sch.mailTrigger.from} placeholder={t('settings.auto.watchFromPlaceholder')} onChange={(v) => update(i, (s) => (s.mailTrigger.from = v))} />
                    <NumberField label={t('settings.auto.everyMinutes')} value={sch.mailTrigger.everyMinutes} min={1} max={1440} suffix={t('settings.auto.minutesSuffix')} onChange={(v) => v && update(i, (s) => (s.mailTrigger.everyMinutes = v))} />
                  </div>
                </Row>
              )}
              <Row label={t('settings.auto.mailAccounts')} hint={accounts.length ? t('settings.auto.allWhenNone') : t('settings.auto.noAccountsYet')} wide search="">
                <div className="choice-chips">
                  {accounts.map((a) => (
                    <label key={a.id} className={`choice-chip ${sch.mailAccounts.includes(a.id) ? 'on' : ''}`}>
                      <input type="checkbox" checked={sch.mailAccounts.includes(a.id)} onChange={() => update(i, (s) => (s.mailAccounts = toggleIn(s.mailAccounts, a.id)))} />
                      {a.address || a.name}
                    </label>
                  ))}
                </div>
              </Row>
              <Row label={t('settings.auto.notes')} hint={sources.length ? t('settings.auto.allWhenNone') : t('settings.auto.noNotesYet')} wide search="">
                <div className="choice-chips">
                  {sources.map((n) => (
                    <label key={n.id} className={`choice-chip ${sch.notes.includes(n.id) ? 'on' : ''}`}>
                      <input type="checkbox" checked={sch.notes.includes(n.id)} onChange={() => update(i, (s) => (s.notes = toggleIn(s.notes, n.id)))} />
                      {n.name}
                    </label>
                  ))}
                </div>
              </Row>
              <Row label={t('settings.auto.emails')} hint={sch.send.mode === 'auto' ? t('settings.auto.sendAutoHint') : t('settings.auto.sendReviewHint')} search="">
                <Select
                  label={t('settings.auto.emails')}
                  value={sch.send.mode}
                  options={[
                    { value: 'review', label: t('settings.auto.sendReview') },
                    { value: 'auto', label: t('settings.auto.sendAuto') },
                  ]}
                  onChange={(v) => {
                    if (v === 'auto' && !confirm(t('settings.auto.sendAutoConfirm', { name: sch.name }))) return
                    update(i, (s) => (s.send.mode = v))
                  }}
                />
              </Row>
              {sch.send.mode === 'auto' && (
                <Row label={t('settings.auto.limits')} hint={t('settings.auto.limitsHint')} search="">
                  <div className="inline">
                    <NumberField label={t('settings.auto.maxPerRun')} value={sch.send.maxPerRun} min={1} max={500} suffix={t('settings.auto.perRun')} onChange={(v) => v && update(i, (s) => (s.send.maxPerRun = v))} />
                    <NumberField label={t('settings.auto.maxPerDay')} value={sch.send.maxPerDay} min={1} max={2000} suffix={t('settings.auto.perDay')} onChange={(v) => v && update(i, (s) => (s.send.maxPerDay = v))} />
                  </div>
                </Row>
              )}
              <Row label={t('settings.auto.whenDone')} hint={sch.after.notify === 'whatsapp' && app.whatsapp.state !== 'connected' ? t('settings.auto.whatsappOff') : undefined} search="">
                <div className="inline">
                  <Select label={t('settings.auto.tellMe')} value={sch.after.notify} options={notifyOptions} onChange={(v) => update(i, (s) => (s.after.notify = v))} />
                  <Select
                    label={t('settings.auto.thenRun')}
                    value={sch.after.runNext}
                    options={[{ value: '', label: t('settings.auto.thenNothing') }, ...others.map((o) => ({ value: o.id, label: t('settings.auto.thenRunName', { name: o.name }) }))]}
                    onChange={(v) => update(i, (s) => (s.after.runNext = v))}
                  />
                </div>
              </Row>
              <Row label={t('settings.data.model')} search="">
                <div className="inline">
                  <button className="btn" onClick={() => setPicking(i)}>
                    {sch.model ? `${modelLabel(sch.model.modelId)} · ${sch.model.providerId}` : t('settings.data.defaultModel')}
                  </button>
                  {sch.model && (
                    <button className="link small" onClick={() => update(i, (s) => (s.model = null))}>
                      {t('settings.parts.resetLink')}
                    </button>
                  )}
                </div>
              </Row>
            </div>
          )
        })}
        <div className="inline">
          <Select label={t('settings.auto.template')} value={template} options={TEMPLATES.map((x) => ({ value: x, label: t(`settings.auto.tpl.${x}.name` as MessageKey) }))} onChange={setTemplate} />
          <button className="btn" onClick={add}>
            {t('settings.auto.add')}
          </button>
        </div>
      </Section>
      {picking != null && <ModelPicker app={app} onClose={() => setPicking(null)} onState={onState} onError={onError} onPick={(r) => update(picking, (s) => (s.model = r))} title={t('settings.data.pickModelTitle')} />}
    </>
  )
}

/** "Every N minutes/hours"; stored as hours. */
function IntervalField({ hours, onChange }: { hours: number; onChange: (hours: number) => void }) {
  const { t } = useT()
  const [unit, setUnit] = useState<'minutes' | 'hours'>(hours < 1 ? 'minutes' : 'hours')
  const shown = unit === 'minutes' ? Math.round(hours * 60) : Math.round(hours * 100) / 100
  return (
    <>
      <NumberField label={t('settings.data.interval')} value={shown} min={1} onChange={(v) => v && onChange(unit === 'minutes' ? v / 60 : v)} />
      <Select
        label={t('settings.data.unit')}
        value={unit}
        options={[
          { value: 'minutes', label: t('settings.data.minutes') },
          { value: 'hours', label: t('settings.data.hours') },
        ]}
        onChange={(u) => {
          setUnit(u)
          onChange(u === 'minutes' ? shown / 60 : shown)
        }}
      />
    </>
  )
}

// ---------------------------------------------------------------- Mail accounts

export function MailAccountsPage({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
  const accounts = app.settings.mail.accounts
  const [testing, setTesting] = useState<string | null>(null)
  const [ok, setOk] = useState<Record<string, boolean>>({})
  const update = (i: number, fn: (a: MailAccount) => void) => save((s) => (fn(s.mail.accounts[i]), s))
  const add = (provider: MailAccount['provider']) => {
    const p = mailPreset(provider)
    save((s) => {
      s.mail.accounts.push({ id: newId('mail'), name: p.id === 'custom' ? t('settings.mail.ownDomain') : p.label, enabled: true, provider, address: '', fromName: '', username: '', imap: { ...p.imap }, smtp: { ...p.smtp }, signature: '' })
      return s
    })
  }
  const test = (id: string) => {
    setTesting(id)
    api.mail
      .test(id)
      .then((s) => {
        onState(s)
        setOk((o) => ({ ...o, [id]: true }))
      }, onError)
      .finally(() => setTesting(null))
  }
  return (
    <Section description={t('settings.mail.intro')}>
      {accounts.length === 0 && (
        <div className="empty-box">
          <b>{t('settings.mail.none')}</b>
          <span className="muted small">{t('settings.mail.noneHint')}</span>
        </div>
      )}
      {accounts.map((a, i) => {
        const preset = mailPreset(a.provider)
        const hasPw = !!app.automations.passwords[a.id]
        return (
          <div key={a.id} className="provider-card">
            <div className="provider-head">
              <Toggle label={t('settings.mail.enable', { name: a.name })} value={a.enabled} onChange={(v) => update(i, (x) => (x.enabled = v))} />
              <b>{a.address || a.name}</b>
              <span className="badge">{preset.label}</span>
              {ok[a.id] && <span className="badge ok">{t('settings.mail.connected')}</span>}
              <div className="spacer" />
              <button className="btn ghost" disabled={!hasPw || !a.address.trim() || testing === a.id} onClick={() => test(a.id)}>
                {testing === a.id ? t('settings.mail.testing') : t('settings.mail.test')}
              </button>
              <button
                className="link danger small"
                onClick={() =>
                  confirm(t('settings.mail.removeConfirm', { name: a.address || a.name })) &&
                  api.mail.setPassword(a.id, null).then(() => save((s) => ((s.mail.accounts = s.mail.accounts.filter((x) => x.id !== a.id)), s)), onError)
                }
              >
                {t('common.remove')}
              </button>
            </div>
            <Row label={t('settings.mail.address')} labelFor={`mail-addr-${a.id}`} search="">
              <TextField id={`mail-addr-${a.id}`} label={t('settings.mail.address')} value={a.address} placeholder="you@example.com" onChange={(v) => update(i, (x) => (x.address = v.trim()))} />
            </Row>
            <Row label={t('settings.mail.fromName')} hint={t('settings.mail.fromNameHint')} labelFor={`mail-name-${a.id}`} search="">
              <TextField id={`mail-name-${a.id}`} label={t('settings.mail.fromName')} value={a.fromName} onChange={(v) => update(i, (x) => (x.fromName = v))} />
            </Row>
            <Row
              label={t('settings.mail.password')}
              hint={
                <>
                  {preset.appPassword ? t(`settings.mail.appPassword.${a.provider as 'gmail' | 'outlook'}`) : t('settings.mail.passwordHint')}
                  {preset.appPassword && (
                    <>
                      {' '}
                      <button className="link small" onClick={() => api.app.openExternal(preset.appPassword!.url)}>
                        {t('settings.mail.makeAppPassword')}
                      </button>
                    </>
                  )}
                </>
              }
              labelFor={`mail-pw-${a.id}`}
              search=""
            >
              <SecretInput id={`mail-pw-${a.id}`} label={t('settings.mail.password')} saved={hasPw} placeholder={t('settings.mail.pastePassword')} onSave={(v) => api.mail.setPassword(a.id, v).then(onState, onError)} />
            </Row>
            <Row label={t('settings.mail.signature')} hint={t('settings.mail.signatureHint')} wide search="">
              <TextField label={t('settings.mail.signature')} multiline rows={3} value={a.signature} onChange={(v) => update(i, (x) => (x.signature = v))} />
            </Row>
            <details className="advanced" open={a.provider === 'custom' && !a.imap.host}>
              <summary>{t('settings.mail.servers')}</summary>
              <Row label={t('settings.mail.username')} hint={t('settings.mail.usernameHint')} search="">
                <TextField label={t('settings.mail.username')} value={a.username} placeholder={a.address} onChange={(v) => update(i, (x) => (x.username = v.trim()))} />
              </Row>
              {(['imap', 'smtp'] as const).map((kind) => (
                <Row key={kind} label={kind === 'imap' ? t('settings.mail.imap') : t('settings.mail.smtp')} hint={kind === 'imap' ? t('settings.mail.imapHint') : t('settings.mail.smtpHint')} search="">
                  <div className="inline">
                    <TextField label={t('settings.mail.host')} mono value={a[kind].host} placeholder={kind === 'imap' ? 'imap.example.com' : 'smtp.example.com'} onChange={(v) => update(i, (x) => (x[kind].host = v.trim()))} />
                    <NumberField label={t('settings.mail.port')} value={a[kind].port} min={1} max={65535} onChange={(v) => v && update(i, (x) => (x[kind].port = v))} />
                    <label className="inline small">
                      <input type="checkbox" checked={a[kind].secure} onChange={(e) => update(i, (x) => (x[kind].secure = e.target.checked))} />
                      {t('settings.mail.tls')}
                    </label>
                  </div>
                </Row>
              ))}
            </details>
          </div>
        )
      })}
      <div className="inline">
        {MAIL_PRESETS.map((p) => (
          <button key={p.id} className="btn" onClick={() => add(p.id)}>
            {p.id === 'custom' ? t('settings.mail.addOwn') : t('settings.mail.addNamed', { name: p.label })}
          </button>
        ))}
      </div>
      <Row label={t('settings.mail.blocklist')} hint={t('settings.mail.blocklistHint')} wide search="">
        <ListField label={t('settings.mail.blocklist')} value={app.settings.mail.blocklist} placeholder="@competitor.com" onChange={(v) => save((s) => ((s.mail.blocklist = v), s))} />
      </Row>
    </Section>
  )
}

// ---------------------------------------------------------------- Notes

export function NotesSourcesPage({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
  const sources = app.settings.notes.sources
  const [result, setResult] = useState<Record<string, string>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const update = (i: number, fn: (n: NotesSource) => void) => save((s) => (fn(s.notes.sources[i]), s))
  const kinds: NotesSource['kind'][] = app.platform === 'darwin' ? ['obsidian', 'apple', 'notion'] : ['obsidian', 'notion']
  const label = (k: NotesSource['kind']) => (k === 'obsidian' ? 'Obsidian' : k === 'apple' ? 'Apple Notes' : 'Notion')
  const add = (kind: NotesSource['kind']) =>
    save((s) => {
      s.notes.sources.push({ id: newId('notes'), name: label(kind), enabled: true, kind, path: '', folder: '' })
      return s
    })
  const pickVault = (i: number) => api.notes.pickVault().then((dir) => dir && update(i, (n) => (n.path = dir)), onError)
  const test = (id: string) => {
    setTesting(id)
    api.notes
      .test(id)
      .then((count) => setResult((r) => ({ ...r, [id]: t('settings.notes.found', { count }) })), onError)
      .finally(() => setTesting(null))
  }
  return (
    <Section description={t('settings.notes.intro')}>
      {sources.length === 0 && (
        <div className="empty-box">
          <b>{t('settings.notes.none')}</b>
          <span className="muted small">{t('settings.notes.noneHint')}</span>
        </div>
      )}
      {sources.map((n, i) => {
        const ready = n.kind === 'obsidian' ? !!n.path : n.kind === 'notion' ? !!app.automations.tokens[n.id] : true
        return (
          <div key={n.id} className="provider-card">
            <div className="provider-head">
              <Toggle label={t('settings.notes.enable', { name: n.name })} value={n.enabled} onChange={(v) => update(i, (x) => (x.enabled = v))} />
              <b>{n.name}</b>
              <span className="badge">{label(n.kind)}</span>
              {result[n.id] && <span className="badge ok">{result[n.id]}</span>}
              <div className="spacer" />
              <button className="btn ghost" disabled={!ready || !n.enabled || testing === n.id} onClick={() => test(n.id)}>
                {testing === n.id ? t('settings.mail.testing') : t('settings.mail.test')}
              </button>
              <button
                className="link danger small"
                onClick={() => confirm(t('settings.notes.removeConfirm', { name: n.name })) && api.notes.setToken(n.id, null).then(() => save((s) => ((s.notes.sources = s.notes.sources.filter((x) => x.id !== n.id)), s)), onError)}
              >
                {t('common.remove')}
              </button>
            </div>
            <Row label={t('settings.data.name')} search="">
              <TextField label={t('settings.data.name')} value={n.name} onChange={(v) => update(i, (x) => (x.name = v))} />
            </Row>
            {n.kind === 'obsidian' && (
              <Row label={t('settings.notes.vault')} hint={t('settings.notes.vaultHint')} search="">
                <div className="inline">
                  <span className="mono small schedule-path" title={n.path}>
                    {n.path || t('common.none')}
                  </span>
                  <button className="btn" onClick={() => pickVault(i)}>
                    {t('settings.parts.choose')}
                  </button>
                </div>
              </Row>
            )}
            {n.kind === 'apple' && (
              <Row label={t('settings.notes.appleFolder')} hint={t('settings.notes.appleHint')} search="">
                <TextField label={t('settings.notes.appleFolder')} value={n.folder} placeholder={t('settings.notes.allFolders')} onChange={(v) => update(i, (x) => (x.folder = v))} />
              </Row>
            )}
            {n.kind === 'notion' && (
              <Row
                label={t('settings.notes.notionToken')}
                hint={
                  <>
                    {t('settings.notes.notionHint')}{' '}
                    <button className="link small" onClick={() => api.app.openExternal('https://www.notion.so/profile/integrations')}>
                      {t('settings.notes.notionMake')}
                    </button>
                  </>
                }
                search=""
              >
                <SecretInput id={`notion-${n.id}`} label={t('settings.notes.notionToken')} saved={!!app.automations.tokens[n.id]} placeholder="ntn_…" onSave={(v) => api.notes.setToken(n.id, v).then(onState, onError)} />
              </Row>
            )}
          </div>
        )
      })}
      <div className="inline">
        {kinds.map((k) => (
          <button key={k} className="btn" onClick={() => add(k)}>
            {t('settings.mail.addNamed', { name: label(k) })}
          </button>
        ))}
      </div>
    </Section>
  )
}
