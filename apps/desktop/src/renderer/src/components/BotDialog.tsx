import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BOT_ALWAYS_TOOLS, BOT_COLORS, BOT_PETS, BOT_SHAPES, botFace, faceForName, newBot, newBotId, randomFace, type BotFace, type BotPet, type BotShape } from '@harness/core/bots'
import { EFFORT_LEVELS, type ReasoningEffort } from '@harness/core/catalog'
import type { AppState, PermissionMode, Settings } from '../../../shared/ipc'
import { api } from '../lib/api'
import { basename } from '../lib/format'
import { useT } from '../lib/i18n'
import { Markdown } from '../lib/Markdown'
import { pixelatePicture, spritePng, type PixelPng } from '../lib/pixel-art'
import { BotVoiceFields } from './BotVoiceFields'
import { BotFaceView, type BotMood } from './BotFace'
import { ModelChoice } from './settings/common'

type Bot = Settings['bots'][number]
type Tab = 'bot' | 'pet' | 'pixel' | 'upload'

type T = ReturnType<typeof useT>['t']

const shapeNames = (t: T): Record<BotShape, string> => ({
  blob: t('bots.dialog.shape.blob'),
  round: t('bots.dialog.shape.round'),
  squircle: t('bots.dialog.shape.squircle'),
  shield: t('bots.dialog.shape.shield'),
  drop: t('bots.dialog.shape.drop'),
  flower: t('bots.dialog.shape.flower'),
  triangle: t('bots.dialog.shape.triangle'),
  hexagon: t('bots.dialog.shape.hexagon'),
  cloud: t('bots.dialog.shape.cloud'),
  star: t('bots.dialog.shape.star'),
  ghost: t('bots.dialog.shape.ghost'),
})
const petNames = (t: T): Record<BotPet, string> => ({
  cat: t('bots.dialog.pet.cat'),
  dog: t('bots.dialog.pet.dog'),
  bunny: t('bots.dialog.pet.bunny'),
  bear: t('bots.dialog.pet.bear'),
  fox: t('bots.dialog.pet.fox'),
  frog: t('bots.dialog.pet.frog'),
  owl: t('bots.dialog.pet.owl'),
  panda: t('bots.dialog.pet.panda'),
})
const colorNames = (t: T): Record<(typeof BOT_COLORS)[number]['id'], string> => ({
  plum: t('bots.dialog.color.plum'),
  rose: t('bots.dialog.color.rose'),
  apricot: t('bots.dialog.color.apricot'),
  honey: t('bots.dialog.color.honey'),
  moss: t('bots.dialog.color.moss'),
  mint: t('bots.dialog.color.mint'),
  sky: t('bots.dialog.color.sky'),
  periwinkle: t('bots.dialog.color.periwinkle'),
  lilac: t('bots.dialog.color.lilac'),
  stone: t('bots.dialog.color.stone'),
})
const tabs = (t: T): [Tab, string][] => [
  ['bot', t('bots.dialog.tab.shape')],
  ['pet', t('bots.dialog.tab.animal')],
  ['pixel', t('bots.dialog.tab.pixel')],
  ['upload', t('bots.dialog.tab.picture')],
]
const memoryHints = (t: T): Record<Bot['memory'], string> => ({
  own: t('bots.dialog.memoryOwnHint'),
  shared: t('bots.dialog.memorySharedHint'),
  off: t('bots.dialog.memoryOffHint'),
})
/** The permission modes a bot can run in, as in the message box. */
const modes = (t: T): { id: PermissionMode; label: string; hint: string }[] => [
  { id: 'ask', label: t('bots.dialog.mode.ask'), hint: t('bots.dialog.mode.askHint') },
  { id: 'acceptEdits', label: t('bots.dialog.mode.acceptEdits'), hint: t('bots.dialog.mode.acceptEditsHint') },
  { id: 'plan', label: t('bots.dialog.mode.plan'), hint: t('bots.dialog.mode.planHint') },
  { id: 'auto', label: t('bots.dialog.mode.auto'), hint: t('bots.dialog.mode.autoHint') },
]
const effortNames = (t: T): Record<ReasoningEffort, string> => ({
  none: t('bots.dialog.effort.none'),
  low: t('bots.dialog.effort.low'),
  medium: t('bots.dialog.effort.medium'),
  high: t('bots.dialog.effort.high'),
  xhigh: t('bots.dialog.effort.xhigh'),
  max: t('bots.dialog.effort.max'),
})

/** A translated sentence with `{name}` slots filled by elements, e.g. key hints with <kbd>. */
export function withSlots(text: string, slots: Record<string, React.ReactNode>): React.ReactNode[] {
  return text.split(/\{(\w+)\}/).map((part, i) => (i % 2 ? <span key={i}>{slots[part] ?? `{${part}}`}</span> : part))
}

const NAME_MAX = 40

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

interface Props {
  app: AppState
  /** The bot to edit; a new bot when unset. */
  botId?: string
  onClose: () => void
  onState: (s: AppState) => void
}

/** "New bot" and "Edit bot": a live preview beside Identity, Personality, Brain, Abilities and Advanced. */
export function BotDialog({ app, botId, onClose, onState }: Props) {
  const { t } = useT()
  const existing = botId ? app.settings.bots.find((b) => b.id === botId) : undefined
  const [draft, setDraft] = useState<Bot>(() => structuredClone(existing) ?? { ...newBot('', []), name: '' })
  const [tab, setTab] = useState<Tab>(() => (draft.avatar.kind === 'pet' ? 'pet' : draft.avatar.kind === 'image' ? 'upload' : draft.avatar.kind === 'pixel' ? 'pixel' : 'bot'))
  /** The picture shown for image and pixel faces (a data URL). */
  const [image, setImage] = useState<string | undefined>(existing ? app.botAvatars[existing.id] : undefined)
  /** A pixel avatar made in this dialog, saved to disk only when the bot is saved. */
  const [pixel, setPixel] = useState<PixelPng | null>(null)
  const [rolls, setRolls] = useState(0)
  /** The "Describe the look" text for AI pictures. */
  const [look, setLook] = useState(draft.avatar.prompt ?? '')
  const [painter, setPainter] = useState<{ id: string; name: string; model: string } | null | undefined>(undefined)
  const [generating, setGenerating] = useState(false)
  const [pixelNote, setPixelNote] = useState('')
  const [nameError, setNameError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const ids = useId()

  const name = draft.name.trim()
  const avatar = draft.avatar
  const face: BotFace = avatar.kind === 'pixel' && image ? { kind: 'pixel', image: avatar.image || 'new', color: avatar.color } : botFace(draft.name || 'Bot', avatar)
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
    api.bots.imageProvider().then(
      (p) => alive.current && setPainter(p),
      () => alive.current && setPainter(null),
    )
    return () => {
      alive.current = false
      if (root) root.inert = was
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  const close = () => {
    if (!busy) onClose()
  }

  const onKey = (e: React.KeyboardEvent) => {
    // Opened from Settings: keys stay here instead of reaching the Settings overlay.
    e.stopPropagation()
    // The model switcher, open on top, handles its own keys.
    if ((e.target as HTMLElement).closest('.picker')) return
    const target = e.target as HTMLElement
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      // ⌘/Ctrl+Enter saves from anywhere, textareas included.
      e.preventDefault()
      void save()
    } else if (e.key === 'Enter' && !e.shiftKey && target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'search')) {
      // Enter in a one-line field saves, like a form.
      e.preventDefault()
      void save()
    } else if (e.key === 'Tab') {
      const f = [...(dialog.current?.querySelectorAll<HTMLElement>('a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])].filter(
        (el) => el.offsetParent !== null,
      )
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

  /** A picture from disk, pixelated like an AI one (32×32, 16 colors). */
  const pixelateFile = async () => {
    setError(null)
    try {
      const r = await api.bots.pickAvatar()
      if (!r) return
      const png = await pixelatePicture(r.url)
      if (!alive.current) return
      applyPixel(png, undefined)
      setPixelNote(t('bots.dialog.pixelated'))
    } catch (e) {
      setError(clean(e))
    }
  }

  /** Shows a pixel avatar made here. `prompt` is set (maybe '') for AI pictures and unset for sprites. */
  const applyPixel = (png: PixelPng, prompt: string | undefined) => {
    setPixel(png)
    setImage(png.url)
    setAvatar({ kind: 'pixel', image: undefined, locked: true, color: face.color, prompt })
  }
  const isSprite = avatar.kind === 'pixel' && avatar.prompt === undefined

  /** The keyless sprite: the name's own first, a new one on each reroll. */
  const sprite = async (roll: number) => {
    setError(null)
    try {
      const png = await spritePng(`${name || 'Bot'}#${roll}`)
      if (!alive.current) return
      setRolls(roll)
      applyPixel(png, undefined)
      setPixelNote(roll === 0 ? t('bots.dialog.spriteMade', { name: name || t('bots.botName') }) : t('bots.dialog.spriteNew'))
    } catch (e) {
      setError(clean(e))
    }
  }

  const generate = async () => {
    if (generating) return
    setError(null)
    setGenerating(true)
    setPixelNote(painter ? t('bots.dialog.asking', { provider: painter.name }) : t('bots.dialog.askingAny'))
    try {
      const r = await api.bots.generateAvatar({ name: name || 'Bot', tagline: draft.tagline, persona: draft.persona, prompt: look })
      const png = await pixelatePicture(r.dataUrl)
      if (!alive.current) return
      applyPixel(png, look.trim())
      setPixelNote(t('bots.dialog.made', { provider: r.provider, model: r.model }))
    } catch (e) {
      if (!alive.current) return
      setError(clean(e))
      setPixelNote('')
    } finally {
      if (alive.current) setGenerating(false)
    }
  }

  const chooseTab = (t: Tab) => {
    setTab(t)
    if (t !== 'pixel' || avatar.kind === 'pixel') return
    // Back to the pixel avatar made earlier, or the saved one; else a sprite, so the tab is never empty.
    if (pixel) {
      setImage(pixel.url)
      setAvatar({ kind: 'pixel', image: undefined, locked: true })
    } else if (existing?.avatar.kind === 'pixel' && existing.avatar.image && app.botAvatars[existing.id]) {
      setImage(app.botAvatars[existing.id])
      setAvatar({ ...existing.avatar })
    } else void sprite(0)
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
    if (busy || generating) return
    if (!name) {
      setNameError(true)
      setError(null)
      nameRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      let bot: Bot = { ...draft, name, greeting: draft.greeting?.trim() ? draft.greeting : undefined }
      // A face that follows the name is stored as the name's face, so files and older builds see it too.
      if (!bot.avatar.locked && bot.avatar.kind === 'shape') bot = { ...bot, avatar: { ...bot.avatar, ...faceForName(name) } }
      if (!bot.avatar.locked && bot.avatar.kind === 'pet') bot = { ...bot, avatar: { ...bot.avatar, color: faceForName(name).color } }
      // A pixel avatar made here is written to the data folder now.
      if (bot.avatar.kind === 'pixel' && pixel) bot = { ...bot, avatar: { ...bot.avatar, image: (await api.bots.saveAvatar(pixel.bytes)).path } }
      if (bot.avatar.kind === 'pixel' && !bot.avatar.image) bot = { ...bot, avatar: { ...bot.avatar, kind: 'shape', locked: false } }
      const s = structuredClone(app.settings)
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
      let state = await api.settings.set(s)
      // A new bot opens its chat right away when there's a folder to run in.
      if (!existing && bot.enabled && (state.workspace || bot.cwd)) state = await api.bots.open(bot.id)
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
  const skills = draft.skills
  const toggleSkill = (skill: string, on: boolean) => set({ skills: on ? [...(skills ?? []), skill] : (skills ?? []).filter((n) => n !== skill) })
  const mood: BotMood = generating ? 'thinking' : 'idle'
  const shapeLabels = shapeNames(t)
  const petLabels = petNames(t)
  const colorLabels = colorNames(t)
  const modeList = modes(t)
  const efforts = effortNames(t)
  const optional = <span className="muted">{t('bots.dialog.optional')}</span>

  const tile = (key: string, label: string, pressed: boolean, onClick: () => void, child: React.ReactNode) => (
    <button key={key} type="button" className="bd-tile" aria-pressed={pressed} aria-label={label} title={label} onClick={onClick}>
      {child}
    </button>
  )
  const section = (id: string, title: string, hint: string | null, children: React.ReactNode) => (
    <section className="bd-section" aria-labelledby={`${ids}-${id}`}>
      <h3 id={`${ids}-${id}`}>{title}</h3>
      {hint && <p className="muted small bd-section-hint">{hint}</p>}
      {children}
    </section>
  )

  return createPortal(
    <div className="overlay bd-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog bot-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${ids}-t`} aria-describedby={`${ids}-d`} aria-busy={busy} onKeyDown={onKey}>
        <header className="bd-head">
          <h2 className="dialog-title" id={`${ids}-t`}>
            {existing ? t('bots.editNamed', { name: existing.name }) : t('bots.panel.newBot')}
          </h2>
          <p className="muted small" id={`${ids}-d`}>
            {t('bots.dialog.description')}
          </p>
        </header>

        <div className="bd-body">
          {/* What the bot will look like in its chat. Decorative: every value is in the fields beside it. */}
          <aside className="bd-preview" aria-hidden style={{ '--bot': face.color } as React.CSSProperties}>
            <BotFaceView face={face} size={88} image={image} fallback={name.charAt(0).toUpperCase()} mood={mood} />
            <div className="bd-preview-name">{name || <span className="muted">{t('bots.dialog.name')}</span>}</div>
            {draft.tagline.trim() && <div className="bd-preview-tag">{draft.tagline}</div>}
            <div className="bd-preview-msg">
              <div className="bot-speaker">
                <BotFaceView face={face} size={18} image={image} fallback={name.charAt(0).toUpperCase()} />
                <span>{name || t('bots.botName')}</span>
              </div>
              {draft.greeting?.trim() ? <Markdown text={draft.greeting} /> : <p className="muted small">{t('bots.dialog.noGreeting')}</p>}
            </div>
          </aside>

          <div className="bd-form">
            {section(
              'identity',
              t('bots.dialog.identity'),
              null,
              <>
                <div className="bd-field">
                  <label htmlFor={`${ids}-name`}>{t('bots.dialog.name')}</label>
                  <input
                    id={`${ids}-name`}
                    ref={nameRef}
                    value={draft.name}
                    maxLength={NAME_MAX}
                    placeholder={t('bots.dialog.namePlaceholder')}
                    autoComplete="off"
                    spellCheck={false}
                    aria-required
                    aria-invalid={nameError || undefined}
                    aria-describedby={nameError ? `${ids}-name-err` : undefined}
                    onChange={(e) => {
                      set({ name: e.target.value })
                      if (e.target.value.trim()) setNameError(false)
                    }}
                  />
                  {nameError && (
                    <span className="bd-field-error" id={`${ids}-name-err`}>
                      {t('bots.dialog.nameRequired')}
                    </span>
                  )}
                </div>
                <div className="bd-field">
                  <label htmlFor={`${ids}-tag`}>
                    {t('bots.dialog.tagline')} {optional}
                  </label>
                  <input id={`${ids}-tag`} value={draft.tagline} maxLength={80} placeholder={t('bots.dialog.taglinePlaceholder')} autoComplete="off" onChange={(e) => set({ tagline: e.target.value })} />
                </div>

                <div className="bd-field">
                  <span id={`${ids}-face`}>{t('bots.dialog.face')}</span>
                  <div className="bd-seg" role="group" aria-labelledby={`${ids}-face`}>
                    {tabs(t).map(([id, label]) => (
                      <button key={id} type="button" aria-pressed={tab === id} onClick={() => chooseTab(id)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {tab === 'bot' && (
                  <div className="bd-grid" role="group" aria-label={t('bots.dialog.shapes')}>
                    {tile(
                      'auto',
                      t('bots.dialog.autoLabel'),
                      avatar.kind === 'shape' && !avatar.locked,
                      () => setAvatar({ kind: 'shape', locked: false }),
                      <span className="bd-auto">{t('bots.dialog.auto')}</span>,
                    )}
                    {BOT_SHAPES.map((shape) =>
                      tile(
                        shape,
                        shapeLabels[shape],
                        face.kind === 'shape' && avatar.locked && face.shape === shape,
                        () => setAvatar({ kind: 'shape', shape, color: face.color, locked: true }),
                        <BotFaceView face={{ kind: 'shape', shape, color: face.color }} size={32} />,
                      ),
                    )}
                  </div>
                )}
                {tab === 'pet' && (
                  <div className="bd-grid" role="group" aria-label={t('bots.dialog.animals')}>
                    {BOT_PETS.map((pet) =>
                      tile(
                        pet,
                        petLabels[pet],
                        face.kind === 'pet' && face.pet === pet,
                        () => setAvatar({ kind: 'pet', pet }),
                        <BotFaceView face={{ kind: 'pet', pet, color: face.color }} size={32} />,
                      ),
                    )}
                  </div>
                )}
                {tab === 'pixel' && (
                  <div className="bd-pixel">
                    <div className="bd-pixel-row">
                      <button type="button" className="btn" onClick={() => sprite(isSprite ? rolls + 1 : 0)} disabled={generating}>
                        {isSprite ? t('bots.dialog.anotherSprite') : t('bots.dialog.spriteFromName')}
                      </button>
                      <span className="muted small">{t('bots.dialog.spriteHint')}</span>
                    </div>
                    <div className="bd-field">
                      <label htmlFor={`${ids}-prompt`}>
                        {t('bots.dialog.describe')} {optional}
                      </label>
                      <textarea
                        id={`${ids}-prompt`}
                        rows={2}
                        value={look}
                        maxLength={600}
                        placeholder={t('bots.dialog.lookPlaceholder')}
                        aria-describedby={`${ids}-painter`}
                        onChange={(e) => setLook(e.target.value)}
                      />
                    </div>
                    <div className="bd-pixel-row">
                      <button type="button" className="btn" onClick={generate} disabled={!painter || generating}>
                        {generating ? t('bots.dialog.generating') : t('bots.dialog.generate')}
                      </button>
                      <span className="muted small" id={`${ids}-painter`}>
                        {painter === undefined
                          ? ''
                          : painter
                            ? t('bots.dialog.painter', { provider: painter.name, model: painter.model })
                            : t('bots.dialog.noPainter')}
                      </span>
                    </div>
                    <div className="bd-pixel-row">
                      <button type="button" className="btn" onClick={pixelateFile} disabled={generating}>
                        {t('bots.dialog.pixelate')}
                      </button>
                      <span className="muted small">{t('bots.dialog.pixelateHint')}</span>
                    </div>
                    <p className="muted small bd-note" role="status">
                      {pixelNote}
                    </p>
                  </div>
                )}
                {tab === 'upload' && (
                  <div className="bd-upload">
                    <button type="button" className="btn" onClick={pickImage}>
                      {avatar.kind === 'image' ? t('bots.dialog.chooseAnother') : t('bots.dialog.choosePicture')}
                    </button>
                    <span className="muted small">{t('bots.dialog.uploadHint')}</span>
                  </div>
                )}

                {(avatar.kind === 'shape' || avatar.kind === 'pet' || avatar.kind === 'pixel') && (tab === 'bot' || tab === 'pet' || tab === 'pixel') && (
                  <div className="bd-field">
                    <span id={`${ids}-color`}>{avatar.kind === 'pixel' ? t('bots.dialog.backdrop') : t('bots.dialog.color')}</span>
                    <div className="bd-colors" role="radiogroup" aria-labelledby={`${ids}-color`}>
                      {BOT_COLORS.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          role="radio"
                          aria-checked={face.color.toLowerCase() === c.value}
                          aria-label={colorLabels[c.id]}
                          title={colorLabels[c.id]}
                          className="bd-swatch"
                          style={{ background: c.value }}
                          onClick={() => setAvatar(avatar.kind === 'shape' ? { ...frozen(), color: c.value, locked: true } : { color: c.value, locked: true })}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {(avatar.kind === 'shape' || avatar.kind === 'pet') && (tab === 'bot' || tab === 'pet') && (
                  <>
                    <div className="bd-face-acts">
                      <button type="button" className="btn ghost" onClick={randomize}>
                        {t('bots.dialog.randomize')}
                      </button>
                      <label className="bd-check">
                        <input
                          type="checkbox"
                          checked={avatar.locked}
                          onChange={(e) => setAvatar(e.target.checked ? { ...(avatar.kind === 'shape' ? frozen() : { color: face.color }), locked: true } : { locked: false })}
                        />
                        {t('bots.dialog.lock')}
                      </label>
                    </div>
                    <p className="muted small bd-note">
                      {avatar.locked ? t('bots.dialog.lockedHint') : t('bots.dialog.unlockedHint')}
                    </p>
                  </>
                )}
                {avatar.kind === 'emoji' && <p className="muted small bd-note">{t('bots.dialog.emoji')}</p>}
              </>,
            )}

            {section(
              'persona',
              t('bots.dialog.personality'),
              null,
              <>
                <div className="bd-field">
                  <label htmlFor={`${ids}-persona`}>{t('bots.dialog.persona')}</label>
                  <textarea
                    id={`${ids}-persona`}
                    rows={5}
                    value={draft.persona}
                    placeholder={t('bots.dialog.personaPlaceholder')}
                    aria-describedby={`${ids}-persona-hint`}
                    onChange={(e) => set({ persona: e.target.value })}
                  />
                  <span className="muted small" id={`${ids}-persona-hint`}>
                    {t('bots.dialog.personaHint')}
                  </span>
                </div>
                <div className="bd-field">
                  <label htmlFor={`${ids}-greet`}>
                    {t('bots.dialog.greeting')} {optional}
                  </label>
                  <textarea
                    id={`${ids}-greet`}
                    rows={2}
                    value={draft.greeting ?? ''}
                    placeholder={t('bots.dialog.greetingPlaceholder')}
                    aria-describedby={`${ids}-greet-hint`}
                    onChange={(e) => set({ greeting: e.target.value })}
                  />
                  <span className="muted small" id={`${ids}-greet-hint`}>
                    {t('bots.dialog.greetingHint')}
                  </span>
                </div>
              </>,
            )}

            {section(
              'brain',
              t('bots.dialog.brain'),
              null,
              <>
                <div className="bd-row">
                  <span>{t('bots.dialog.model')}</span>
                  <ModelChoice
                    app={app}
                    value={draft.model ?? null}
                    empty={t('bots.dialog.defaultModel')}
                    title={name ? t('bots.dialog.modelFor', { name }) : t('bots.dialog.modelForUnnamed')}
                    onChange={(r) => set({ model: r ?? undefined })}
                    onState={onState}
                    onError={(e) => setError(clean(e))}
                  />
                </div>
                <div className="bd-row">
                  <label htmlFor={`${ids}-think`}>{t('bots.dialog.thinking')}</label>
                  <select id={`${ids}-think`} value={draft.thinking ?? ''} onChange={(e) => set({ thinking: (e.target.value || undefined) as ReasoningEffort | undefined })}>
                    <option value="">{t('bots.dialog.thinkingDefault')}</option>
                    {EFFORT_LEVELS.map((l) => (
                      <option key={l} value={l}>
                        {efforts[l]}
                      </option>
                    ))}
                  </select>
                </div>
              </>,
            )}

            {section('voice', t('bots.voice.voice'), t('bots.dialog.voiceHint'), <BotVoiceFields app={app} bot={draft} onChange={(voice) => set({ voice })} />)}

            {section(
              'abilities',
              t('bots.dialog.abilities'),
              null,
              <>
                <div className="bd-row">
                  <label htmlFor={`${ids}-mode`}>{t('bots.dialog.permissions')}</label>
                  <select id={`${ids}-mode`} value={draft.mode} aria-describedby={`${ids}-mode-hint`} onChange={(e) => set({ mode: e.target.value as PermissionMode })}>
                    {modeList.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="muted small bd-hint" id={`${ids}-mode-hint`}>
                  {draft.mode === 'auto' ? t('bots.dialog.autoModeHint') : modeList.find((m) => m.id === draft.mode)?.hint}
                </p>
                <div className="bd-row">
                  <label htmlFor={`${ids}-tools`}>{t('bots.dialog.tools')}</label>
                  <select
                    id={`${ids}-tools`}
                    value={chosen ? 'some' : 'all'}
                    onChange={(e) => set({ tools: e.target.value === 'all' ? 'all' : tools.filter((tool) => tool.readOnly).map((tool) => tool.name) })}
                  >
                    <option value="all">{t('bots.dialog.everyTool')}</option>
                    <option value="some">{t('bots.dialog.onlyThese')}</option>
                  </select>
                </div>
                {chosen && (
                  <div className="bot-tools" role="group" aria-label={name ? t('bots.dialog.toolsFor', { name }) : t('bots.dialog.toolsForUnnamed')}>
                    {tools.map((tool) => (
                      <label key={tool.name} title={tool.description}>
                        <input type="checkbox" checked={chosen.includes(tool.name)} onChange={(e) => toggleTool(tool.name, e.target.checked)} /> {tool.name}
                      </label>
                    ))}
                    {chosen
                      .filter((n) => !tools.some((tool) => tool.name === n))
                      .map((n) => (
                        <label key={n} title={t('bots.dialog.notHere')}>
                          <input type="checkbox" checked onChange={(e) => toggleTool(n, e.target.checked)} /> {n}
                        </label>
                      ))}
                  </div>
                )}
                <div className="bd-row">
                  <label htmlFor={`${ids}-skills`}>{t('bots.dialog.skills')}</label>
                  <select id={`${ids}-skills`} value={skills ? 'some' : 'all'} onChange={(e) => set({ skills: e.target.value === 'all' ? undefined : [] })}>
                    <option value="all">{t('bots.dialog.everySkill')}</option>
                    <option value="some">{t('bots.dialog.onlyThese')}</option>
                  </select>
                </div>
                {skills && (
                  <div className="bot-tools" role="group" aria-label={name ? t('bots.dialog.skillsFor', { name }) : t('bots.dialog.skillsForUnnamed')}>
                    {app.skills.length === 0 && skills.length === 0 && <span className="muted small">{t('bots.dialog.noSkills')}</span>}
                    {app.skills.map((sk) => (
                      <label key={sk.name} title={sk.description}>
                        <input type="checkbox" checked={skills.includes(sk.name)} onChange={(e) => toggleSkill(sk.name, e.target.checked)} /> {sk.name}
                      </label>
                    ))}
                    {skills
                      .filter((n) => !app.skills.some((sk) => sk.name === n))
                      .map((n) => (
                        <label key={n} title={t('bots.dialog.notHere')}>
                          <input type="checkbox" checked onChange={(e) => toggleSkill(n, e.target.checked)} /> {n}
                        </label>
                      ))}
                  </div>
                )}
                <div className="bd-row">
                  <label htmlFor={`${ids}-memory`}>{t('bots.dialog.memory')}</label>
                  <select id={`${ids}-memory`} value={draft.memory} aria-describedby={`${ids}-memory-hint`} onChange={(e) => set({ memory: e.target.value as Bot['memory'] })}>
                    <option value="own">{t('bots.dialog.memoryOwn')}</option>
                    <option value="shared">{t('bots.dialog.memoryShared')}</option>
                    <option value="off">{t('common.off')}</option>
                  </select>
                </div>
                <p className="muted small bd-hint" id={`${ids}-memory-hint`}>
                  {memoryHints(t)[draft.memory]}
                </p>
              </>,
            )}

            {section(
              'advanced',
              t('bots.dialog.advanced'),
              null,
              <>
                <div className="bd-row">
                  <span>{t('bots.dialog.folder')}</span>
                  <span className="bd-folder">
                    <span className="muted small" title={draft.cwd ?? undefined}>
                      {draft.cwd ? basename(draft.cwd) : t('bots.dialog.folderDefault')}
                    </span>
                    <button
                      type="button"
                      className="btn ghost"
                      aria-label={draft.cwd ? t('bots.dialog.changeFolder', { folder: basename(draft.cwd) }) : t('bots.dialog.chooseFolder')}
                      onClick={() =>
                        api.bots.pickFolder().then(
                          (p) => p && set({ cwd: p }),
                          (e) => setError(clean(e)),
                        )
                      }
                    >
                      {t('bots.dialog.choose')}
                    </button>
                    {draft.cwd && (
                      <button type="button" className="link small" onClick={() => set({ cwd: null })}>
                        {t('common.reset')}
                      </button>
                    )}
                  </span>
                </div>
                <div className="bd-row">
                  <span>{t('bots.dialog.notifications')}</span>
                  <label className="bd-check">
                    <input type="checkbox" checked={draft.muted} onChange={(e) => set({ muted: e.target.checked })} />
                    {t('bots.dialog.mute')}
                  </label>
                </div>
              </>,
            )}
          </div>
        </div>

        {error && (
          <p className="bd-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions bd-actions">
          <span className="muted small bd-keys">
            {withSlots(t('bots.dialog.keys'), {
              save: (
                <>
                  <kbd>{app.platform === 'darwin' ? '⌘' : 'Ctrl'}</kbd>
                  <kbd>Enter</kbd>
                </>
              ),
              cancel: <kbd>Esc</kbd>,
            })}
          </span>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy || generating}>
            {busy ? t('bots.dialog.saving') : existing ? t('common.save') : t('bots.dialog.create')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
