import { useEffect, useRef, useState } from 'react'
import type { AppState, AutomationRunView, MailDraftView } from '../../../shared/ipc'
import { api } from '../lib/api'
import { useFormat, useT } from '../lib/i18n'

interface Props {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  /** Opens Settings at the Automations tab. */
  onManage: () => void
  /** Shows the chat area again after opening a run's chat. */
  onChat: () => void
}

const waiting = (r: AutomationRunView) => r.drafts.filter((d) => d.status === 'pending' || d.status === 'failed').length

/** The sidebar's Automations tab: every run, newest first, with the emails it wrote. */
export function AutomationsPanel({ app, onState, onError, onManage, onChat }: Props) {
  const { t } = useT()
  const fmt = useFormat()
  const runs = app.automations.runs
  const [open, setOpen] = useState<string | null>(null)
  const shown = runs.find((r) => r.id === open)
  const accounts = app.settings.mail.accounts
  const automations = app.settings.schedules
  const openRun = (r: AutomationRunView) => {
    setOpen(r.id)
    if (!r.read) api.automations.markRead(r.id).then(onState, onError)
  }
  return (
    <div className="auto-panel">
      <div className="auto-head">
        <span className="muted small">{t('auto.inbox.count', { count: runs.length })}</span>
        <div className="spacer" />
        {app.automations.unread > 0 && (
          <button className="link small" onClick={() => api.automations.markRead('all').then(onState, onError)}>
            {t('auto.inbox.markAllRead')}
          </button>
        )}
        <button className="link small" onClick={onManage}>
          {t('auto.inbox.manage')}
        </button>
      </div>
      {runs.length === 0 ? (
        <div className="empty-box">
          <b>{t('auto.inbox.empty')}</b>
          <span className="muted small">{automations.length ? t('auto.inbox.emptyHintRuns') : accounts.length ? t('auto.inbox.emptyHintNew') : t('auto.inbox.emptyHintSetup')}</span>
          <div>
            <button className="btn" onClick={onManage}>
              {automations.length ? t('auto.inbox.openSettings') : t('auto.inbox.create')}
            </button>
          </div>
        </div>
      ) : (
        <ul className="auto-runs" aria-label={t('auto.inbox.runs')}>
          {runs.map((r) => {
            const n = waiting(r)
            return (
              <li key={r.id}>
                <button className={`auto-run ${r.read && !n ? '' : 'unread'} ${open === r.id ? 'active' : ''}`} onClick={() => openRun(r)}>
                  <span className="auto-run-top">
                    <span className="auto-run-name">{r.automationId ? `⏰ ${r.name}` : `💬 ${r.name}`}</span>
                    <span className="muted small">{fmt.ago(r.startedAt)}</span>
                  </span>
                  <span className="auto-run-bottom">
                    <RunBadge run={r} />
                    {n > 0 && <span className="badge warn">{t('auto.inbox.toReview', { count: n })}</span>}
                  </span>
                  {r.summary && <span className="auto-run-summary muted small">{r.summary}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {shown && <RunDialog app={app} run={shown} onClose={() => setOpen(null)} onState={onState} onError={onError} onChat={onChat} />}
    </div>
  )
}

function RunBadge({ run }: { run: AutomationRunView }) {
  const { t } = useT()
  if (run.status === 'running')
    return (
      <span className="badge ok" role="status">
        {t('auto.status.running')}
      </span>
    )
  if (run.status === 'failed') return <span className="badge bad">{t('auto.status.failed')}</span>
  const sent = run.drafts.filter((d) => d.status === 'sent').length
  return <span className="badge">{sent ? t('auto.status.doneSent', { count: sent }) : t('auto.status.done')}</span>
}

/** One run: what it said, and each email it wrote, to send, edit or skip. */
function RunDialog({ app, run, onClose, onState, onError, onChat }: { app: AppState; run: AutomationRunView; onClose: () => void; onState: (s: AppState) => void; onError: (e: unknown) => void; onChat: () => void }) {
  const { t } = useT()
  const fmt = useFormat()
  const dialog = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => dialog.current?.focus(), [])
  // Escape closes even after a button that took focus with it became disabled.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return
      if (e.target instanceof HTMLElement && e.target.closest('.draft-edit')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  const n = waiting(run)
  const sendAll = () => {
    if (!confirm(t('auto.run.sendAllConfirm', { count: n }))) return
    setBusy(true)
    api.automations
      .sendAll(run.id)
      .then(onState, onError)
      .finally(() => setBusy(false))
  }
  const openChat = () =>
    api.sessions.open(run.sessionId).then((s) => {
      onState(s)
      onChat()
      onClose()
    }, onError)
  return (
    <div className="overlay" onMouseDown={() => !busy && onClose()}>
      <div
        className="dialog run-dialog"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="run-dialog-head">
          <span className="dialog-title" id="run-dialog-title">
            {run.name}
          </span>
          <RunBadge run={run} />
          <div className="spacer" />
          <span className="muted small">{fmt.date(run.startedAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div className="muted small">{t(`auto.trigger.${run.trigger}`)}</div>
        {run.error && <div className="notice notice-error small">{run.error}</div>}
        {run.summary && <p className="run-summary">{run.summary}</p>}
        {run.drafts.length > 0 && (
          <div className="run-drafts">
            <div className="run-drafts-head">
              <b>{t('auto.run.emails', { count: run.drafts.length })}</b>
              <div className="spacer" />
              {n > 1 && (
                <button className="btn primary" disabled={busy} onClick={sendAll}>
                  {t('auto.run.sendAll', { count: n })}
                </button>
              )}
            </div>
            {run.drafts.map((d) => (
              <DraftCard key={d.id} app={app} runId={run.id} draft={d} busy={busy} onState={onState} onError={onError} />
            ))}
          </div>
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={openChat}>
            {t('auto.run.openChat')}
          </button>
          <div className="spacer" />
          <button
            className="link danger small"
            disabled={busy}
            onClick={() => (!n || confirm(t('auto.run.removeConfirm', { count: n }))) && api.automations.removeRun(run.id).then(onState, onError).then(onClose)}
          >
            {t('auto.run.remove')}
          </button>
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

function DraftCard({ app, runId, draft, busy, onState, onError }: { app: AppState; runId: string; draft: MailDraftView; busy: boolean; onState: (s: AppState) => void; onError: (e: unknown) => void }) {
  const { t } = useT()
  const fmt = useFormat()
  const [editing, setEditing] = useState(false)
  const [sending, setSending] = useState(false)
  const [form, setForm] = useState({ to: draft.to.join(', '), cc: draft.cc.join(', '), subject: draft.subject, body: draft.body })
  const account = app.settings.mail.accounts.find((a) => a.id === draft.account)
  const open = draft.status === 'pending' || draft.status === 'failed'
  const send = () => {
    setSending(true)
    api.automations
      .send(runId, draft.id)
      .then(onState, onError)
      .finally(() => setSending(false))
  }
  const saveEdit = () =>
    api.automations.edit(runId, draft.id, form).then((s) => {
      onState(s)
      setEditing(false)
    }, onError)
  return (
    <div className={`draft-card ${draft.status}`}>
      <div className="draft-meta">
        <span className="muted small">{t('auto.draft.from', { address: account ? account.address : draft.account })}</span>
        <div className="spacer" />
        <DraftStatus draft={draft} when={draft.sentAt ? fmt.ago(draft.sentAt) : ''} />
      </div>
      {editing ? (
        <div className="draft-edit">
          <label className="small muted" htmlFor={`d-to-${draft.id}`}>
            {t('auto.draft.to')}
          </label>
          <input id={`d-to-${draft.id}`} value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
          <label className="small muted" htmlFor={`d-cc-${draft.id}`}>
            {t('auto.draft.cc')}
          </label>
          <input id={`d-cc-${draft.id}`} value={form.cc} onChange={(e) => setForm({ ...form, cc: e.target.value })} />
          <label className="small muted" htmlFor={`d-subject-${draft.id}`}>
            {t('auto.draft.subject')}
          </label>
          <input id={`d-subject-${draft.id}`} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          <label className="small muted" htmlFor={`d-body-${draft.id}`}>
            {t('auto.draft.body')}
          </label>
          <textarea id={`d-body-${draft.id}`} rows={10} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </div>
      ) : (
        <>
          <div className="draft-line">
            <span className="muted small">{t('auto.draft.to')}</span> {draft.to.join(', ')}
            {draft.cc.length > 0 && (
              <>
                {' · '}
                <span className="muted small">{t('auto.draft.cc')}</span> {draft.cc.join(', ')}
              </>
            )}
          </div>
          <div className="draft-subject">{draft.subject}</div>
          <pre className="draft-body">{draft.body}</pre>
          {account?.signature.trim() && <pre className="draft-body muted small">-- {'\n'}{account.signature.trim()}</pre>}
        </>
      )}
      {draft.error && <div className="notice notice-error small">{draft.error}</div>}
      {open && (
        <div className="dialog-actions">
          {editing ? (
            <>
              <button className="btn primary" onClick={saveEdit}>
                {t('common.save')}
              </button>
              <button className="btn" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </button>
            </>
          ) : (
            <>
              <button className="btn primary" disabled={busy || sending} onClick={send}>
                {sending ? t('auto.draft.sending') : draft.status === 'failed' ? t('auto.draft.retry') : t('auto.draft.send')}
              </button>
              <button className="btn" disabled={busy || sending} onClick={() => setEditing(true)}>
                {t('auto.draft.edit')}
              </button>
              <button className="btn ghost" disabled={busy || sending} onClick={() => api.automations.skip(runId, draft.id).then(onState, onError)}>
                {t('auto.draft.skip')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function DraftStatus({ draft, when }: { draft: MailDraftView; when: string }) {
  const { t } = useT()
  switch (draft.status) {
    case 'sent':
      return <span className="badge ok">{draft.auto ? t('auto.draft.sentAuto', { when }) : t('auto.draft.sent', { when })}</span>
    case 'sending':
      return (
        <span className="badge" role="status">
          {t('auto.draft.sending')}
        </span>
      )
    case 'skipped':
      return <span className="badge">{t('auto.draft.skipped')}</span>
    case 'failed':
      return <span className="badge bad">{t('auto.draft.failed')}</span>
    default:
      return <span className="badge warn">{t('auto.draft.pending')}</span>
  }
}
