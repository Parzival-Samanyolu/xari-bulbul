import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BOT_ALWAYS_TOOLS, BOT_COLORS, BOT_PETS, BOT_SHAPES, botFace, faceForName, newBot, newBotId, randomFace, type BotPet, type BotShape } from '@harness/core/bots'
import { EFFORT_LABELS, EFFORT_LEVELS, type ReasoningEffort } from '@harness/core/catalog'
import type { AppState, PermissionMode, Settings } from '../../../shared/ipc'
import { api } from '../lib/api'
import { basename } from '../lib/format'
import { BotFaceView } from './BotFace'
import { MODES } from './Composer'
import { ModelChoice } from './settings/common'

type Bot = Settings['bots'][number]
type Tab = 'bot' | 'pet' | 'upload'

const SHAPE_NAMES: Record<BotShape, string> = {
  blob: 'Blob',
  round: 'Round',
  squircle: 'Squircle',
  shield: 'Shield',
  drop: 'Drop',
  flower: 'Flower',
  triangle: 'Triangle',
  hexagon: 'Hexagon',
  cloud: 'Cloud',
  star: 'Star',
  ghost: 'Ghost',
}
const PET_NAMES: Record<BotPet, string> = { cat: 'Cat', dog: 'Dog', bunny: 'Bunny', bear: 'Bear', fox: 'Fox', frog: 'Frog', owl: 'Owl', panda: 'Panda' }

const MEMORY_HINT: Record<Bot['memory'], string> = {
  own: 'Remembers things about you that only it sees, plus your shared memories.',
  shared: 'Uses the same memories as your other chats.',
  off: "Doesn't read or save memories.",
}

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

interface Props {
  app: AppState
  /** The bot to edit; a new bot when unset. */
  botId?: string
  onClose: () => void
  onState: (s: AppState) => void
}

/** "New bot" and "Edit bot": face, name, personality, and the advanced choices. */
export function BotDialog({ app, botId, onClose, onState }: Props) {
  const existing = botId ? app.settings.bots.find((b) => b.id === botId) : undefined
  const [draft, setDraft] = useState<Bot>(() => structuredClone(existing) ?? { ...newBot('', []), name: '' })
  const [tab, setTab] = useState<Tab>(draft.avatar.kind === 'pet' ? 'pet' : draft.avatar.kind === 'image' ? 'upload' : 'bot')
  const [image, setImage] = useState<string | undefined>(existing ? app.botAvatars[existing.id] : undefined)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const ids = useId()

  const name = draft.name.trim()
  const face = botFace(draft.name || 'Bot', draft.avatar)
  const avatar = draft.avatar
  const set = (patch: Partial<Bot>) => setDraft((d) => ({ ...d, ...patch }))
  const setAvatar = (patch: Partial<Bot['avatar']>) => setDraft((d) => ({ ...d, avatar: { ...d.avatar, ...patch } }))
  /** The face as shown, written down so it stays when locked. */
  const frozen = () => ({ shape: face.kind === 'shape' ? face.shape : (avatar.shape ?? faceForName(draft.name).shape), color: face.color })

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

  const onKey = (e: React.KeyboardEvent) => {
    // Opened from Settings: keys stay here instead of reaching the Settings overlay.
    e.stopPropagation()
    // The model switcher, open on top, handles its own keys.
    if ((e.target as HTMLElement).closest('.picker')) return
    if (e.key === 'Escape' && !busy) {
      e.preventDefault()
      onClose()
    }
    if (e.key === 'Tab') {
      const f = [...(dialog.current?.querySelectorAll<HTMLElement>('input, textarea, select, summary, button:not([disabled])') ?? [])].filter((el) => el.offsetParent !== null)
      const i = f.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && i <= 0) (e.preventDefault(), f.at(-1)?.focus())
      else if (!e.shiftKey && i === f.length - 1) (e.preventDefault(), f[0]?.focus())
    }
  }

  const pickImage = async () => {
    setError(null)
    try {
      const r = await api.bots.pickAvatar()
      if (!r) return
      setImage(r.url)
      setAvatar({ kind: 'image', image: r.path, locked: true })
    } catch (e) {
      setError(clean(e))
    }
  }

  const randomize = () => {
    const r = randomFace()
    if (tab === 'pet') setAvatar({ kind: 'pet', pet: BOT_PETS[Math.floor(Math.random() * BOT_PETS.length)], color: r.color, locked: true })
    else {
      setTab('bot')
      setAvatar({ kind: 'shape', shape: r.shape, color: r.color, locked: true })
    }
  }

  const save = async () => {
    if (!name) {
      setError('Give the bot a name.')
      nameRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    const s = structuredClone(app.settings)
    let bot: Bot = { ...draft, name, greeting: draft.greeting?.trim() ? draft.greeting : undefined }
    // A face that follows the name is stored as the name's face, so files and older builds see it too.
    if (!bot.avatar.locked && bot.avatar.kind === 'shape') bot = { ...bot, avatar: { ...bot.avatar, ...faceForName(name) } }
    if (!bot.avatar.locked && bot.avatar.kind === 'pet') bot = { ...bot, avatar: { ...bot.avatar, color: faceForName(name).color } }
    if (existing) s.bots = s.bots.map((b) => (b.id === existing.id ? bot : b))
    else {
      bot = {
        ...bot,
        id: newBotId(
          name,
          s.bots.map((b) => b.id),
        ),
      }
      s.bots.push(bot)
    }
    try {
      let state = await api.settings.set(s)
      // A new bot opens its chat right away when there's a folder to run in.
      if (!existing && (state.workspace || bot.cwd)) state = await api.bots.open(bot.id)
      onState(state)
      onClose()
    } catch (e) {
      setError(clean(e))
      setBusy(false)
    }
  }

  const tools = app.extensions.tools.filter((t) => !BOT_ALWAYS_TOOLS.includes(t.name))
  const chosen = draft.tools === 'all' ? null : draft.tools
  const toggleTool = (tool: string, on: boolean) => set({ tools: on ? [...(chosen ?? []), tool] : (chosen ?? []).filter((n) => n !== tool) })

  const tile = (key: string, label: string, pressed: boolean, onClick: () => void, child: React.ReactNode) => (
    <button key={key} type="button" className="bd-tile" aria-pressed={pressed} aria-label={label} title={label} onClick={onClick}>
      {child}
    </button>
  )

  return createPortal(
    <div className="overlay bd-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog bot-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${ids}-t`} aria-describedby={`${ids}-d`} onKeyDown={onKey}>
        <header className="bd-head">
          <h2 className="dialog-title" id={`${ids}-t`}>
            {existing ? `Edit ${existing.name}` : 'New bot'}
          </h2>
          <p className="muted small" id={`${ids}-d`}>
            A character with its own memory, chat and tools.
          </p>
        </header>

        <div className="bd-body">
          <div className="bd-face">
            <div className="bd-preview">
              <BotFaceView face={face} size={96} image={image} fallback={name.charAt(0).toUpperCase()} />
            </div>

            <div className="bd-seg" role="group" aria-label="Face style">
              {(
                [
                  ['bot', 'Bot'],
                  ['pet', 'Pet'],
                  ['upload', 'Upload'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>

            {tab === 'bot' && (
              <div className="bd-grid" role="group" aria-label="Shapes">
                {tile(
                  'auto',
                  'Auto: the face follows the name',
                  avatar.kind === 'shape' && !avatar.locked,
                  () => setAvatar({ kind: 'shape', locked: false }),
                  <span className="bd-auto">Auto</span>,
                )}
                {BOT_SHAPES.map((shape) =>
                  tile(
                    shape,
                    SHAPE_NAMES[shape],
                    face.kind === 'shape' && avatar.locked && face.shape === shape,
                    () => setAvatar({ kind: 'shape', shape, color: face.color, locked: true }),
                    <BotFaceView face={{ kind: 'shape', shape, color: face.color }} size={34} />,
                  ),
                )}
              </div>
            )}
            {tab === 'pet' && (
              <div className="bd-grid" role="group" aria-label="Animals">
                {BOT_PETS.map((pet) =>
                  tile(
                    pet,
                    PET_NAMES[pet],
                    face.kind === 'pet' && face.pet === pet,
                    () => setAvatar({ kind: 'pet', pet }),
                    <BotFaceView face={{ kind: 'pet', pet, color: face.color }} size={34} />,
                  ),
                )}
              </div>
            )}
            {tab === 'upload' && (
              <div className="bd-upload">
                <button type="button" className="btn" onClick={pickImage}>
                  {avatar.kind === 'image' ? 'Choose another picture…' : 'Choose a picture…'}
                </button>
                <span className="muted small">PNG, JPEG, GIF or WebP, under 1 MB. It's copied into the app's data folder.</span>
              </div>
            )}

            {(avatar.kind === 'shape' || avatar.kind === 'pet') && (
              <>
                <div className="bd-colors" role="radiogroup" aria-label="Color">
                  {BOT_COLORS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="radio"
                      aria-checked={face.color.toLowerCase() === c.value}
                      aria-label={c.label}
                      title={c.label}
                      className="bd-swatch"
                      style={{ background: c.value }}
                      onClick={() => setAvatar(avatar.kind === 'shape' ? { ...frozen(), color: c.value, locked: true } : { color: c.value, locked: true })}
                    />
                  ))}
                </div>
                <div className="bd-face-acts">
                  <button type="button" className="btn ghost" onClick={randomize}>
                    Randomize
                  </button>
                  <label className="bd-lock">
                    <input
                      type="checkbox"
                      checked={avatar.locked}
                      onChange={(e) => setAvatar(e.target.checked ? { ...(avatar.kind === 'shape' ? frozen() : { color: face.color }), locked: true } : { locked: false })}
                    />{' '}
                    Lock face
                  </label>
                </div>
                <p className="muted small bd-note">
                  {avatar.locked ? 'The face stays as it is when you rename the bot.' : 'The face follows the name: each name gets its own shape and color.'}
                </p>
              </>
            )}
            {avatar.kind === 'emoji' && <p className="muted small bd-note">This bot uses an emoji from an earlier version. Pick a shape or an animal to change it.</p>}
          </div>

          <div className="bd-fields">
            <label className="bd-field">
              <span>Name</span>
              <input ref={nameRef} value={draft.name} maxLength={40} placeholder="Pip" onChange={(e) => set({ name: e.target.value })} aria-required />
            </label>
            <label className="bd-field">
              <span>Title</span>
              <input value={draft.tagline} maxLength={80} placeholder="Space otter, pun enthusiast" onChange={(e) => set({ tagline: e.target.value })} />
            </label>
            <label className="bd-field">
              <span>Personality</span>
              <textarea rows={5} value={draft.persona} placeholder="What is this bot like? How does it talk?" onChange={(e) => set({ persona: e.target.value })} />
            </label>
            <label className="bd-field">
              <span>
                Greeting <span className="muted">(optional)</span>
              </span>
              <textarea
                rows={2}
                value={draft.greeting ?? ''}
                placeholder="Shown as its first message. The model never sees it."
                onChange={(e) => set({ greeting: e.target.value })}
              />
            </label>

            <details className="bd-advanced">
              <summary>Advanced</summary>
              <div className="bd-adv-rows">
                <div className="bd-row">
                  <span>Model</span>
                  <ModelChoice
                    app={app}
                    value={draft.model ?? null}
                    empty="Default model"
                    title={`Model for ${name || 'this bot'}…`}
                    onChange={(r) => set({ model: r ?? undefined })}
                    onState={onState}
                    onError={(e) => setError(clean(e))}
                  />
                </div>
                <label className="bd-row">
                  <span>Thinking</span>
                  <select value={draft.thinking ?? ''} onChange={(e) => set({ thinking: (e.target.value || undefined) as ReasoningEffort | undefined })}>
                    <option value="">Default</option>
                    {EFFORT_LEVELS.map((l) => (
                      <option key={l} value={l}>
                        {EFFORT_LABELS[l]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="bd-row">
                  <span>Permissions</span>
                  <select value={draft.mode} onChange={(e) => set({ mode: e.target.value as PermissionMode })}>
                    {MODES.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="muted small bd-hint">
                  {draft.mode === 'auto' ? 'Works on its own. Deleting files, force pushes and writes outside the folder still ask.' : MODES.find((m) => m.id === draft.mode)?.hint}
                </p>
                <label className="bd-row">
                  <span>Memory</span>
                  <select value={draft.memory} onChange={(e) => set({ memory: e.target.value as Bot['memory'] })}>
                    <option value="own">Its own, plus shared</option>
                    <option value="shared">Shared only</option>
                    <option value="off">Off</option>
                  </select>
                </label>
                <p className="muted small bd-hint">{MEMORY_HINT[draft.memory]}</p>
                <label className="bd-row">
                  <span>Tools</span>
                  <select value={chosen ? 'some' : 'all'} onChange={(e) => set({ tools: e.target.value === 'all' ? 'all' : tools.filter((t) => t.readOnly).map((t) => t.name) })}>
                    <option value="all">Every tool</option>
                    <option value="some">Only these</option>
                  </select>
                </label>
                {chosen && (
                  <div className="bot-tools" role="group" aria-label={`Tools for ${name || 'this bot'}`}>
                    {tools.map((t) => (
                      <label key={t.name} title={t.description}>
                        <input type="checkbox" checked={chosen.includes(t.name)} onChange={(e) => toggleTool(t.name, e.target.checked)} /> {t.name}
                      </label>
                    ))}
                    {chosen
                      .filter((n) => !tools.some((t) => t.name === n))
                      .map((n) => (
                        <label key={n} title="Not available in this folder">
                          <input type="checkbox" checked onChange={(e) => toggleTool(n, e.target.checked)} /> {n}
                        </label>
                      ))}
                  </div>
                )}
                <div className="bd-row">
                  <span>Folder</span>
                  <span className="bd-folder">
                    <span className="muted small" title={draft.cwd ?? undefined}>
                      {draft.cwd ? basename(draft.cwd) : 'The folder on screen when a chat starts'}
                    </span>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() =>
                        api.bots.pickFolder().then(
                          (p) => p && set({ cwd: p }),
                          (e) => setError(clean(e)),
                        )
                      }
                    >
                      Choose…
                    </button>
                    {draft.cwd && (
                      <button type="button" className="link small" onClick={() => set({ cwd: null })}>
                        Reset
                      </button>
                    )}
                  </span>
                </div>
              </div>
            </details>
          </div>
        </div>

        {error && (
          <p className="bd-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions bd-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            {existing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
