import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LOBBY_ALL_ANSWER, LOBBY_CAST, newLobby } from '@harness/core/bots'
import type { AppState, Settings } from '../../../shared/ipc'
import { api } from '../lib/api'
import { useFormat, useT } from '../lib/i18n'
import { withSlots } from './BotDialog'
import { BotAvatar, StackedFaces } from './Bots'

type Lobby = Settings['lobbies'][number]

interface Props {
  app: AppState
  /** The lobby to edit; a new one when unset. */
  lobbyId?: string
  onClose: () => void
  onState: (s: AppState) => void
  onError: (e: unknown) => void
}

const NAME_MAX = 40
/** How long the bots may keep talking after everyone answered you (0 is off). */
const ROUNDS = [0, 1, 2, 3, 5]

/** New lobby / edit a lobby: a name and two or more bots. */
export function LobbyDialog({ app, lobbyId, onClose, onState, onError }: Props) {
  const { t } = useT()
  const fmt = useFormat()
  const existing = lobbyId ? app.settings.lobbies.find((l) => l.id === lobbyId) : undefined
  const [name, setName] = useState(existing?.name ?? '')
  const [members, setMembers] = useState<string[]>(existing?.botIds.filter((id) => app.settings.bots.some((b) => b.id === id)) ?? [])
  const [rounds, setRounds] = useState(existing?.maxRounds ?? 3)
  const [nameError, setNameError] = useState(false)
  const [membersError, setMembersError] = useState(false)
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const ids = useId()
  const bots = app.settings.bots
  const picked = members.map((id) => bots.find((b) => b.id === id)).filter((b): b is NonNullable<typeof b> => !!b)

  // Modal: the app behind is inert, focus starts on the name and returns where it was.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const root = document.getElementById('root')
    const was = root?.inert ?? false
    if (root) root.inert = true
    nameRef.current?.focus()
    return () => {
      if (root) root.inert = was
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  const close = () => !busy && onClose()

  const toggle = (id: string) => {
    setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]))
    setMembersError(false)
  }

  const save = async () => {
    const n = name.trim()
    const short = picked.length < 2
    setNameError(!n)
    setMembersError(short)
    if (!n) return nameRef.current?.focus()
    if (short) return dialog.current?.querySelector<HTMLButtonElement>('.ld-member')?.focus()
    setBusy(true)
    const s = structuredClone(app.settings)
    const botIds = picked.map((b) => b.id)
    let id = existing?.id
    if (existing) s.lobbies = s.lobbies.map((l): Lobby => (l.id === existing.id ? { ...l, name: n, botIds, maxRounds: rounds } : l))
    else {
      const lobby = { ...newLobby(n, botIds, s.lobbies.map((l) => l.id)), maxRounds: rounds }
      id = lobby.id
      s.lobbies = [...s.lobbies, lobby]
    }
    try {
      onState(await api.settings.set(s))
      if (!existing && id) onState(await api.lobbies.open(id))
      onClose()
    } catch (e) {
      setBusy(false)
      onError(e)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    const target = e.target as HTMLElement
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (target instanceof HTMLInputElement && target.type === 'text'))) {
      e.preventDefault()
      void save()
    } else if (e.key === 'Tab') {
      const f = [...(dialog.current?.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])') ?? [])].filter((el) => el.offsetParent !== null)
      const i = f.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && i <= 0) (e.preventDefault(), f.at(-1)?.focus())
      else if (!e.shiftKey && i === f.length - 1) (e.preventDefault(), f[0]?.focus())
    }
  }

  return createPortal(
    <div className="overlay bd-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog lobby-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${ids}-t`} aria-describedby={`${ids}-d`} aria-busy={busy} onKeyDown={onKey}>
        <header className="bd-head ld-head">
          <StackedFaces app={app} bots={picked} size={30} max={5} />
          <div>
            <h2 className="dialog-title" id={`${ids}-t`}>
              {existing ? t('bots.editNamed', { name: existing.name }) : t('bots.lobbies.new')}
            </h2>
            <p className="muted small" id={`${ids}-d`}>
              {t('bots.lobbyDialog.description')}
            </p>
          </div>
        </header>

        <div className="bd-field">
          <label htmlFor={`${ids}-name`}>{t('bots.dialog.name')}</label>
          <input
            id={`${ids}-name`}
            ref={nameRef}
            type="text"
            value={name}
            maxLength={NAME_MAX}
            placeholder={t('bots.lobbyDialog.namePlaceholder')}
            autoComplete="off"
            aria-required
            aria-invalid={nameError || undefined}
            aria-describedby={nameError ? `${ids}-name-err` : undefined}
            onChange={(e) => {
              setName(e.target.value)
              if (e.target.value.trim()) setNameError(false)
            }}
          />
          {nameError && (
            <span className="bd-field-error" id={`${ids}-name-err`}>
              {t('bots.lobbyDialog.nameRequired')}
            </span>
          )}
        </div>

        <fieldset className="ld-fieldset" aria-describedby={`${ids}-m-hint${membersError ? ` ${ids}-m-err` : ''}`}>
          <legend>{t('bots.lobbyDialog.members')}</legend>
          <p className="muted small ld-hint" id={`${ids}-m-hint`}>
            {t('bots.lobbyDialog.membersHint')}
          </p>
          <div className="ld-members">
            {bots.map((b) => {
              const at = members.indexOf(b.id)
              return (
                <button
                  key={b.id}
                  type="button"
                  className={`ld-member ${b.enabled ? '' : 'off'}`}
                  aria-pressed={at >= 0}
                  title={b.enabled ? undefined : t('bots.lobbyDialog.memberOff', { name: b.name })}
                  onClick={() => toggle(b.id)}
                >
                  <BotAvatar app={app} bot={b} size={28} />
                  <span className="ld-member-text">
                    <span className="ld-member-name">{b.name || t('bots.botName')}</span>
                    <span className="ld-member-tag">{b.enabled ? b.tagline || ' ' : t('bots.panel.off')}</span>
                  </span>
                  <span className="ld-order" aria-hidden>
                    {at >= 0 ? at + 1 : ''}
                  </span>
                </button>
              )
            })}
          </div>
          {membersError && (
            <span className="bd-field-error" id={`${ids}-m-err`} role="alert">
              {t('bots.lobbyDialog.pickTwo')}
            </span>
          )}
        </fieldset>

        <div className="bd-field">
          <span id={`${ids}-r`}>{t('bots.lobbyDialog.rounds')}</span>
          <div className="bd-seg ld-rounds" role="group" aria-labelledby={`${ids}-r`} aria-describedby={`${ids}-r-hint`}>
            {ROUNDS.map((r) => (
              <button key={r} type="button" aria-pressed={rounds === r} onClick={() => setRounds(r)}>
                {r === 0 ? t('common.off') : fmt.num(r)}
              </button>
            ))}
          </div>
          <span className="muted small" id={`${ids}-r-hint`}>
            {rounds === 0 ? t('bots.lobbyDialog.roundsOff') : t('bots.lobbyDialog.roundsHint', { count: rounds })}
            {members.length > LOBBY_ALL_ANSWER && ` ${t('bots.lobbyDialog.cast', { count: LOBBY_CAST, max: LOBBY_ALL_ANSWER })}`}
          </span>
        </div>

        <div className="dialog-actions bd-actions">
          <span className="muted small bd-keys">
            {withSlots(t('bots.dialog.keys'), { save: <kbd>Enter</kbd>, cancel: <kbd>Esc</kbd> })}
          </span>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            {busy ? t('bots.dialog.saving') : existing ? t('common.save') : t('bots.dialog.create')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
