import { useEffect, useRef } from 'react'
import type { AppState } from '../../../shared/ipc'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import { ProviderLogo } from './ProviderLogo'

/** Where users review ChatGPT plan usage and set this app's limit. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'
export const CHATGPT_PROVIDER_ID = 'chatgpt'

const openUsage = () => api.app.openExternal(CHATGPT_USAGE_URL)

export function ManageUsageLink({ className = 'link small' }: { className?: string }) {
  const { t } = useT()
  return (
    <button type="button" className={className} onClick={openUsage}>
      {t('settings.chatgpt.manageUsage')}
    </button>
  )
}

interface ConnectProps {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
}

/**
 * "Continue with ChatGPT" and what follows: waiting for the browser, signed in (with sign-out
 * and a usage link), or signed in without plan use.
 */
export function ChatGptConnect({ app, onState, onError }: ConnectProps) {
  const { t } = useT()
  const c = app.chatgpt
  const signIn = (consent = false) => api.chatgpt.signIn(consent).then(onState, onError)
  if (c.pending)
    return (
      <div className="chatgpt-connect" role="status">
        <span className="muted small">{t('settings.chatgpt.waiting')}</span>
        <button type="button" className="btn ghost" onClick={() => api.chatgpt.cancel().then(onState, onError)}>
          {t('common.cancel')}
        </button>
      </div>
    )
  if (!c.signedIn)
    return (
      <div className="chatgpt-connect">
        <button type="button" className="btn chatgpt-button" data-oai-siwc-button="" onClick={() => signIn()}>
          <ProviderLogo id="openai" name="ChatGPT" size={16} />
          {t('settings.chatgpt.continue')}
        </button>
      </div>
    )
  const signOut = () =>
    api.chatgpt.signOut().then((r) => {
      onState(r.state)
      if (!r.revoked) alert(t('settings.chatgpt.notRevoked'))
    }, onError)
  return (
    <div className="chatgpt-connect">
      <span className="small">{c.email ? t('settings.chatgpt.signedInAs', { email: c.email }) : t('settings.chatgpt.signedIn')}</span>
      {!c.planEnabled && <span className="small warn">{t('settings.chatgpt.planOff')}</span>}
      {c.planEnabled ? (
        <ManageUsageLink />
      ) : (
        <button type="button" className="btn" onClick={() => signIn(true)}>
          {t('settings.chatgpt.turnOn')}
        </button>
      )}
      <button type="button" className="link danger small" onClick={signOut}>
        {t('settings.chatgpt.signOut')}
      </button>
    </div>
  )
}

/** Shown once, after the first sign-in that allows plan use. */
export function ChatGptWelcome({ app, onState }: { app: AppState; onState: (s: AppState) => void }) {
  const { t } = useT()
  const ok = useRef<HTMLButtonElement>(null)
  const show = app.chatgpt.signedIn && app.chatgpt.planEnabled && !app.chatgpt.welcomeSeen
  useEffect(() => {
    if (show) ok.current?.focus()
  }, [show])
  if (!show) return null
  const dismiss = () => api.chatgpt.dismissWelcome().then(onState, () => {})
  return (
    <div className="overlay" onMouseDown={dismiss}>
      <div
        className="dialog chatgpt-welcome"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chatgpt-welcome-title"
        aria-describedby="chatgpt-welcome-body"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => (e.key === 'Escape' || e.key === 'Tab') && (e.preventDefault(), e.key === 'Escape' ? dismiss() : ok.current?.focus())}
      >
        <ProviderLogo id="openai" name="ChatGPT" size={28} />
        <span className="dialog-title" id="chatgpt-welcome-title">
          {t('settings.chatgpt.welcomeTitle')}
        </span>
        <p id="chatgpt-welcome-body">{t('settings.chatgpt.welcomeBody')}</p>
        <div className="dialog-actions">
          <button ref={ok} type="button" className="btn primary" onClick={dismiss}>
            {t('settings.chatgpt.gotIt')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** "Using ChatGPT plan · Manage usage", near the model chip when the chat's model is on the plan. */
export function UsingPlanNote() {
  const { t } = useT()
  return (
    <span className="chatgpt-using small muted">
      {t('chat.chatgpt.usingPlan')}
      {' · '}
      <ManageUsageLink className="link small" />
    </span>
  )
}
