import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BOT_ALWAYS_TOOLS, BOT_COLORS, BOT_PETS, BOT_SHAPES, botFace, faceForName, newBot, newBotId, randomFace, type BotFace, type BotPet, type BotShape } from '@harness/core/bots'
import { EFFORT_LABELS, EFFORT_LEVELS, type ReasoningEffort } from '@harness/core/catalog'
import type { AppState, PermissionMode, Settings } from '../../../shared/ipc'
import { api } from '../lib/api'
import { basename } from '../lib/format'
import { Markdown } from '../lib/Markdown'
import { pixelatePicture, spritePng, type PixelPng } from '../lib/pixel-art'
import { BotVoiceFields } from './BotVoiceFields'
import { BotFaceView, type BotMood } from './BotFace'
import { MODES } from './Composer'
import { ModelChoice } from './settings/common'

type Bot = Settings['bots'][number]
type Tab = 'bot' | 'pet' | 'pixel' | 'upload'

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
const TABS: [Tab, string][] = [
  ['bot', 'Shape'],
  ['pet', 'Animal'],
  ['pixel', 'Pixel'],
  ['upload', 'Picture'],
]

const MEMORY_HINT: Record<Bot['memory'], string> = {
  own: 'Remembers things about you that only it sees, plus your shared memories.',
  shared: 'Uses the same memories as your other chats.',
  off: "Doesn't read or save memories.",
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
      setPixelNote('Picture pixelated to 32×32.')
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
      setPixelNote(roll === 0 ? `Sprite made from the name ${name || 'Bot'}.` : 'New sprite made.')
    } catch (e) {
      setError(clean(e))
    }
  }

  const generate = async () => {
    if (generating) return
    setError(null)
    setGenerating(true)
    setPixelNote(`Asking ${painter?.name ?? 'the provider'} for a picture. This can take half a minute.`)
    try {
      const r = await api.bots.generateAvatar({ name: name || 'Bot', tagline: draft.tagline, persona: draft.persona, prompt: look })
      const png = await pixelatePicture(r.dataUrl)
      if (!alive.current) return
      applyPixel(png, look.trim())
      setPixelNote(`Made with ${r.provider} (${r.model}) and pixelated to 32×32.`)
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
            {existing ? `Edit ${existing.name}` : 'New bot'}
          </h2>
          <p className="muted small" id={`${ids}-d`}>
            A character with its own memory, chat and tools.
          </p>
        </header>

        <div className="bd-body">
          {/* What the bot will look like in its chat. Decorative: every value is in the fields beside it. */}
          <aside className="bd-preview" aria-hidden style={{ '--bot': face.color } as React.CSSProperties}>
            <BotFaceView face={face} size={88} image={image} fallback={name.charAt(0).toUpperCase()} mood={mood} />
            <div className="bd-preview-name">{name || <span className="muted">Name</span>}</div>
            {draft.tagline.trim() && <div className="bd-preview-tag">{draft.tagline}</div>}
            <div className="bd-preview-msg">
              <div className="bot-speaker">
                <BotFaceView face={face} size={18} image={image} fallback={name.charAt(0).toUpperCase()} />
                <span>{name || 'Bot'}</span>
              </div>
              {draft.greeting?.trim() ? <Markdown text={draft.greeting} /> : <p className="muted small">No greeting: the chat starts empty.</p>}
            </div>
          </aside>

          <div className="bd-form">
            {section(
              'identity',
              'Identity',
              null,
              <>
                <div className="bd-field">
                  <label htmlFor={`${ids}-name`}>Name</label>
                  <input
                    id={`${ids}-name`}
                    ref={nameRef}
                    value={draft.name}
                    maxLength={NAME_MAX}
                    placeholder="Pip"
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
                      Give the bot a name.
                    </span>
                  )}
                </div>
                <div className="bd-field">
                  <label htmlFor={`${ids}-tag`}>
                    Title <span className="muted">(optional)</span>
                  </label>
                  <input id={`${ids}-tag`} value={draft.tagline} maxLength={80} placeholder="Space otter, pun enthusiast" autoComplete="off" onChange={(e) => set({ tagline: e.target.value })} />
                </div>

                <div className="bd-field">
                  <span id={`${ids}-face`}>Face</span>
                  <div className="bd-seg" role="group" aria-labelledby={`${ids}-face`}>
                    {TABS.map(([id, label]) => (
                      <button key={id} type="button" aria-pressed={tab === id} onClick={() => chooseTab(id)}>
                        {label}
                      </button>
                    ))}
                  </div>
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
                        <BotFaceView face={{ kind: 'shape', shape, color: face.color }} size={32} />,
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
                        <BotFaceView face={{ kind: 'pet', pet, color: face.color }} size={32} />,
                      ),
                    )}
                  </div>
                )}
                {tab === 'pixel' && (
                  <div className="bd-pixel">
                    <div className="bd-pixel-row">
                      <button type="button" className="btn" onClick={() => sprite(isSprite ? rolls + 1 : 0)} disabled={generating}>
                        {isSprite ? 'Another sprite' : 'Sprite from the name'}
                      </button>
                      <span className="muted small">A creature drawn from the name. Works without any provider.</span>
                    </div>
                    <div className="bd-field">
                      <label htmlFor={`${ids}-prompt`}>
                        Describe the look <span className="muted">(optional)</span>
                      </label>
                      <textarea
                        id={`${ids}-prompt`}
                        rows={2}
                        value={look}
                        maxLength={600}
                        placeholder="A sleepy fox in a green scarf"
                        aria-describedby={`${ids}-painter`}
                        onChange={(e) => setLook(e.target.value)}
                      />
                    </div>
                    <div className="bd-pixel-row">
                      <button type="button" className="btn" onClick={generate} disabled={!painter || generating}>
                        {generating ? 'Generating…' : 'Generate with AI'}
                      </button>
                      <span className="muted small" id={`${ids}-painter`}>
                        {painter === undefined
                          ? ''
                          : painter
                            ? `Draws with ${painter.name} (${painter.model}) from the name, personality and your description, then pixelates it. Your provider may charge for each picture.`
                            : 'Needs an OpenAI or OpenRouter API key (Settings › Providers).'}
                      </span>
                    </div>
                    <div className="bd-pixel-row">
                      <button type="button" className="btn" onClick={pixelateFile} disabled={generating}>
                        Pixelate a picture…
                      </button>
                      <span className="muted small">Turns a photo or drawing from your computer into pixel art.</span>
                    </div>
                    <p className="muted small bd-note" role="status">
                      {pixelNote}
                    </p>
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

                {(avatar.kind === 'shape' || avatar.kind === 'pet' || avatar.kind === 'pixel') && (tab === 'bot' || tab === 'pet' || tab === 'pixel') && (
                  <div className="bd-field">
                    <span id={`${ids}-color`}>{avatar.kind === 'pixel' ? 'Backdrop' : 'Color'}</span>
                    <div className="bd-colors" role="radiogroup" aria-labelledby={`${ids}-color`}>
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
                  </div>
                )}
                {(avatar.kind === 'shape' || avatar.kind === 'pet') && (tab === 'bot' || tab === 'pet') && (
                  <>
                    <div className="bd-face-acts">
                      <button type="button" className="btn ghost" onClick={randomize}>
                        Randomize
                      </button>
                      <label className="bd-check">
                        <input
                          type="checkbox"
                          checked={avatar.locked}
                          onChange={(e) => setAvatar(e.target.checked ? { ...(avatar.kind === 'shape' ? frozen() : { color: face.color }), locked: true } : { locked: false })}
                        />
                        Lock face
                      </label>
                    </div>
                    <p className="muted small bd-note">
                      {avatar.locked ? 'The face stays as it is when you rename the bot.' : 'The face follows the name: each name gets its own shape and color.'}
                    </p>
                  </>
                )}
                {avatar.kind === 'emoji' && <p className="muted small bd-note">This bot uses an emoji from an earlier version. Pick a shape, an animal or pixel art to change it.</p>}
              </>,
            )}

            {section(
              'persona',
              'Personality',
              null,
              <>
                <div className="bd-field">
                  <label htmlFor={`${ids}-persona`}>Who it is</label>
                  <textarea
                    id={`${ids}-persona`}
                    rows={5}
                    value={draft.persona}
                    placeholder="A cheerful space otter who explains things with food metaphors and keeps answers short."
                    aria-describedby={`${ids}-persona-hint`}
                    onChange={(e) => set({ persona: e.target.value })}
                  />
                  <span className="muted small" id={`${ids}-persona-hint`}>
                    How it talks and what it cares about. It changes tone only; safety and permission rules stay the same.
                  </span>
                </div>
                <div className="bd-field">
                  <label htmlFor={`${ids}-greet`}>
                    Greeting <span className="muted">(optional)</span>
                  </label>
                  <textarea
                    id={`${ids}-greet`}
                    rows={2}
                    value={draft.greeting ?? ''}
                    placeholder="Hi! What are we making today?"
                    aria-describedby={`${ids}-greet-hint`}
                    onChange={(e) => set({ greeting: e.target.value })}
                  />
                  <span className="muted small" id={`${ids}-greet-hint`}>
                    Shown as its first message in each new chat. The model never sees it.
                  </span>
                </div>
              </>,
            )}

            {section(
              'brain',
              'Brain',
              null,
              <>
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
                <div className="bd-row">
                  <label htmlFor={`${ids}-think`}>Thinking</label>
                  <select id={`${ids}-think`} value={draft.thinking ?? ''} onChange={(e) => set({ thinking: (e.target.value || undefined) as ReasoningEffort | undefined })}>
                    <option value="">The model's default</option>
                    {EFFORT_LEVELS.map((l) => (
                      <option key={l} value={l}>
                        {EFFORT_LABELS[l]}
                      </option>
                    ))}
                  </select>
                </div>
              </>,
            )}

            {section('voice', 'Voice', 'How replies sound when read aloud and in hands-free mode.', <BotVoiceFields app={app} bot={draft} onChange={(voice) => set({ voice })} />)}

            {section(
              'abilities',
              'Abilities',
              null,
              <>
                <div className="bd-row">
                  <label htmlFor={`${ids}-mode`}>Permissions</label>
                  <select id={`${ids}-mode`} value={draft.mode} aria-describedby={`${ids}-mode-hint`} onChange={(e) => set({ mode: e.target.value as PermissionMode })}>
                    {MODES.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="muted small bd-hint" id={`${ids}-mode-hint`}>
                  {draft.mode === 'auto' ? 'Works on its own. Deleting files, force pushes and writes outside the folder still ask.' : MODES.find((m) => m.id === draft.mode)?.hint}
                </p>
                <div className="bd-row">
                  <label htmlFor={`${ids}-tools`}>Tools</label>
                  <select
                    id={`${ids}-tools`}
                    value={chosen ? 'some' : 'all'}
                    onChange={(e) => set({ tools: e.target.value === 'all' ? 'all' : tools.filter((t) => t.readOnly).map((t) => t.name) })}
                  >
                    <option value="all">Every tool</option>
                    <option value="some">Only these</option>
                  </select>
                </div>
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
                  <label htmlFor={`${ids}-skills`}>Skills</label>
                  <select id={`${ids}-skills`} value={skills ? 'some' : 'all'} onChange={(e) => set({ skills: e.target.value === 'all' ? undefined : [] })}>
                    <option value="all">Every skill</option>
                    <option value="some">Only these</option>
                  </select>
                </div>
                {skills && (
                  <div className="bot-tools" role="group" aria-label={`Skills for ${name || 'this bot'}`}>
                    {app.skills.length === 0 && skills.length === 0 && <span className="muted small">No skills in this folder yet.</span>}
                    {app.skills.map((sk) => (
                      <label key={sk.name} title={sk.description}>
                        <input type="checkbox" checked={skills.includes(sk.name)} onChange={(e) => toggleSkill(sk.name, e.target.checked)} /> {sk.name}
                      </label>
                    ))}
                    {skills
                      .filter((n) => !app.skills.some((sk) => sk.name === n))
                      .map((n) => (
                        <label key={n} title="Not available in this folder">
                          <input type="checkbox" checked onChange={(e) => toggleSkill(n, e.target.checked)} /> {n}
                        </label>
                      ))}
                  </div>
                )}
                <div className="bd-row">
                  <label htmlFor={`${ids}-memory`}>Memory</label>
                  <select id={`${ids}-memory`} value={draft.memory} aria-describedby={`${ids}-memory-hint`} onChange={(e) => set({ memory: e.target.value as Bot['memory'] })}>
                    <option value="own">Its own, plus shared</option>
                    <option value="shared">Shared only</option>
                    <option value="off">Off</option>
                  </select>
                </div>
                <p className="muted small bd-hint" id={`${ids}-memory-hint`}>
                  {MEMORY_HINT[draft.memory]}
                </p>
              </>,
            )}

            {section(
              'advanced',
              'Advanced',
              null,
              <>
                <div className="bd-row">
                  <span>Folder</span>
                  <span className="bd-folder">
                    <span className="muted small" title={draft.cwd ?? undefined}>
                      {draft.cwd ? basename(draft.cwd) : 'The folder on screen when a chat starts'}
                    </span>
                    <button
                      type="button"
                      className="btn ghost"
                      aria-label={draft.cwd ? `Change folder (${basename(draft.cwd)})` : 'Choose a folder'}
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
                <div className="bd-row">
                  <span>Notifications</span>
                  <label className="bd-check">
                    <input type="checkbox" checked={draft.muted} onChange={(e) => set({ muted: e.target.checked })} />
                    Mute: no notification when it replies in the background
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
            <kbd>{app.platform === 'darwin' ? '⌘' : 'Ctrl'}</kbd>
            <kbd>Enter</kbd> to save · <kbd>Esc</kbd> to cancel
          </span>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy || generating}>
            {busy ? 'Saving…' : existing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
