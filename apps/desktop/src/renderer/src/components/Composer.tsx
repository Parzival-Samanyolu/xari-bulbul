import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, AttachmentInput, PermissionMode } from '../../../shared/ipc'
import { api } from '../lib/api'
import { PATH_DRAG_TYPE } from './Panels'
import { modelLabel } from '../lib/format'
import { MicButton } from './MicButton'
import { HandsFree } from './HandsFree'
import { MakerLogo, ProviderLogo } from './ProviderLogo'
import { ThinkingPicker } from './ThinkingPicker'
import { moaOn, moaReady } from '@harness/core/moa'
import { activeBot } from '@harness/core/bots'
import { useFormat, useT } from '../lib/i18n'

type T = ReturnType<typeof useT>['t']

/** The permission modes with their labels in the interface language. */
export function modes(t: T): { id: PermissionMode; label: string; hint: string }[] {
  return [
    { id: 'ask', label: t('chat.mode.ask'), hint: t('chat.mode.askHint') },
    { id: 'acceptEdits', label: t('chat.mode.acceptEdits'), hint: t('chat.mode.acceptEditsHint') },
    { id: 'plan', label: t('chat.mode.plan'), hint: t('chat.mode.planHint') },
    { id: 'auto', label: t('chat.mode.auto'), hint: t('chat.mode.autoHint') },
  ]
}

interface Pending extends AttachmentInput {
  id: number
  /** Data URL thumbnail for images we have bytes for. */
  preview?: string
}

let attachId = 0
const IMAGE = /^image\/(png|jpeg|gif|webp)$/

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

/** Dropped or pasted files: real files are sent by path; pasted images (no path) by content. */
async function toPending(files: File[], t: T): Promise<Pending[]> {
  return Promise.all(
    files.map(async (f) => {
      const path = api.files.pathFor(f)
      const image = IMAGE.test(f.type)
      const preview = image && f.size < 8 * 1024 * 1024 ? await readAsDataUrl(f) : undefined
      if (path) return { id: ++attachId, name: f.name, path, size: f.size, preview }
      if (image && preview) return { id: ++attachId, name: f.name || 'pasted-image.png', mediaType: f.type, data: preview.split(',')[1], size: f.size, preview }
      throw new Error(t('chat.composer.attachFailed', { name: f.name }))
    }),
  )
}


interface Props {
  app: AppState
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  onOpenPicker: () => void
}

export function Composer({ app, onState, onError, onOpenPicker }: Props) {
  const { t } = useT()
  const fmt = useFormat()
  const MODE_LIST = modes(t)
  const [text, setText] = useState('')
  const [sel, setSel] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [hIdx, setHIdx] = useState(-1)
  const [attachments, setAttachments] = useState<Pending[]>([])
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const sendWithEnter = app.settings.appearance.sendWithEnter
  const bot = activeBot(app.settings, app.session?.meta.botId)
  /** A lobby on screen: chat only, so no attachments, commands, model or mode; you can jump in while the bots talk. */
  const lobby = app.session?.meta.lobbyId ? (app.settings.lobbies.find((l) => l.id === app.session!.meta.lobbyId) ?? null) : undefined

  useEffect(() => ref.current?.focus(), [app.session?.meta.id])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 280) + 'px'
  }, [text])

  const slash = lobby === undefined ? /^\/(\S*)$/.exec(text) : null
  const matches = useMemo(
    () => (slash ? app.extensions.commands.filter((c) => c.name.startsWith(slash[1])).slice(0, 8) : []),
    [slash?.[1], app.extensions.commands],
  )

  const cycleMode = () => {
    const i = MODE_LIST.findIndex((m) => m.id === app.mode)
    api.agent.setMode(MODE_LIST[(i + 1) % MODE_LIST.length].id).then(onState, onError)
  }

  const add = (files: File[]) => {
    if (!files.length || lobby !== undefined) return
    toPending(files, t).then((p) => setAttachments((a) => [...a, ...p]), onError)
    ref.current?.focus()
  }

  // Dropping a file anywhere in the window attaches it (and never navigates away).
  useEffect(() => {
    let depth = 0
    // Real files, or a file dragged from the Files panel (by path).
    const isFile = (e: DragEvent) => !!e.dataTransfer && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(PATH_DRAG_TYPE))
    const over = (e: DragEvent) => {
      if (!isFile(e)) return
      e.preventDefault()
    }
    const enter = (e: DragEvent) => isFile(e) && (depth++, setDragging(true))
    const leave = () => --depth <= 0 && ((depth = 0), setDragging(false))
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const dragged = e.dataTransfer?.getData(PATH_DRAG_TYPE)
      if (dragged) {
        setAttachments((a) => [...a, { id: ++attachId, name: dragged.split(/[\\/]/).pop() || dragged, path: dragged }])
        ref.current?.focus()
        return
      }
      add([...(e.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files]
    if (!files.length) return
    e.preventDefault()
    add(files)
  }

  /** Dictated text goes where the cursor is (or replaces the selection), with a space on either side when needed. */
  const insert = (said: string) => {
    const el = ref.current
    setText((cur) => {
      const start = el ? el.selectionStart : cur.length
      const end = el ? el.selectionEnd : cur.length
      const before = cur.slice(0, start)
      const after = cur.slice(end)
      const piece = (before && !/\s$/.test(before) ? ' ' : '') + said + (after && !/^\s/.test(after) ? ' ' : '')
      requestAnimationFrame(() => {
        if (!el) return
        el.focus()
        el.setSelectionRange(start + piece.length, start + piece.length)
      })
      return before + piece + after
    })
  }

  const pick = () =>
    api.files.pick().then((p) => p.length && setAttachments((a) => [...a, ...p.map((x) => ({ ...x, id: ++attachId }))]), onError)

  const submit = async (raw = text) => {
    const msg = raw.trim()
    if (lobby !== undefined) {
      // Sending while the bots talk interrupts them.
      if (!msg) return
      setHistory((h) => [msg, ...h.filter((x) => x !== msg)].slice(0, 50))
      setHIdx(-1)
      setText('')
      api.agent.send(msg).catch((e) => {
        setText((cur) => cur || msg)
        onError(e)
      })
      return
    }
    if ((!msg && !attachments.length) || app.running) return
    if (attachments.length) {
      const sending = attachments
      setText('')
      setAttachments([])
      if (msg) setHistory((h) => [msg, ...h.filter((x) => x !== msg)].slice(0, 50))
      // Put them back if the send is rejected (e.g. an unreadable file), so nothing is lost.
      api.agent.send(msg, sending.map(({ id, preview, ...a }) => a)).catch((e) => {
        setText((cur) => cur || msg)
        setAttachments((cur) => (cur.length ? cur : sending))
        onError(e)
      })
      return
    }
    setHistory((h) => [msg, ...h.filter((x) => x !== msg)].slice(0, 50))
    setHIdx(-1)
    setText('')
    // Built-in commands handled by the UI.
    // In a bot chat, /clear starts a new conversation with the same bot.
    if (msg === '/clear') return (bot ? api.bots.newThread(bot.id) : api.sessions.create()).then(onState, onError)
    if (msg === '/model') return onOpenPicker()
    if (msg === '/mode') return cycleMode()
    if (msg === '/compact') return api.agent.compact().catch(onError)
    api.agent.send(msg).catch(onError)
  }

  // Transcribed speech: typed in, or sent right away (Settings › Voice). A ref, because the
  // recording finishes long after the render that started it.
  const onVoice = useRef((_said: string) => {})
  onVoice.current = (said: string) => {
    if (app.settings.voice.autoSend && (!app.running || lobby !== undefined)) submit(text.trim() ? `${text.trimEnd()} ${said}` : said)
    else insert(said)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
      return
    }
    if (matches.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
      e.preventDefault()
      const cmd = matches[Math.min(sel, matches.length - 1)]
      if (cmd.source === 'builtin' && e.key === 'Enter') submit(`/${cmd.name}`)
      else setText(`/${cmd.name} `)
      setSel(0)
      return
    }
    if (e.key === 'Tab' && e.shiftKey && lobby === undefined) {
      e.preventDefault()
      cycleMode()
      return
    }
    if (e.key === 'ArrowUp' && !text.includes('\n') && (text === '' || hIdx >= 0) && history.length) {
      e.preventDefault()
      const i = Math.min(hIdx + 1, history.length - 1)
      setHIdx(i)
      setText(history[i])
      return
    }
    if (e.key === 'ArrowDown' && hIdx >= 0) {
      e.preventDefault()
      const i = hIdx - 1
      setHIdx(i)
      setText(i >= 0 ? history[i] : '')
      return
    }
    const isSend = e.key === 'Enter' && (sendWithEnter ? !e.shiftKey : e.metaKey || e.ctrlKey)
    if (isSend && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const model = app.session?.meta.model
  const ready = model ? app.ready[model.providerId] : false
  const moa = app.settings.moa
  const mixing = moaOn(app.settings, app.session?.meta)

  return (
    <div className="composer">
      {matches.length > 0 && (
        <div className="slash-menu">
          {matches.map((c, i) => (
            <button key={c.name} className={i === sel ? 'sel' : ''} onMouseEnter={() => setSel(i)} onClick={() => (c.source === 'builtin' ? submit(`/${c.name}`) : setText(`/${c.name} `))}>
              <span className="slash-name">/{c.name}</span>
              <span className="muted">{c.description}</span>
              {c.source !== 'builtin' && <span className="badge">{c.source}</span>}
            </button>
          ))}
        </div>
      )}
      <div className={`composer-box ${app.running ? 'running' : ''} ${dragging ? 'dragging' : ''}`}>
        {dragging && <div className="drop-hint">{t('chat.composer.drop')}</div>}
        {attachments.length > 0 && (
          <ul className="attachments" aria-label={t('chat.composer.attachments')}>
            {attachments.map((a) => (
              <li key={a.id} className="attachment" title={a.path ?? a.name}>
                {a.preview ? <img src={a.preview} alt="" /> : <span className="attachment-icon" aria-hidden>{IMAGE.test(a.mediaType ?? '') || /\.(png|jpe?g|gif|webp)$/i.test(a.name) ? '▣' : '≡'}</span>}
                <span className="attachment-name">{a.name}</span>
                <span className="muted small">{a.size == null ? '' : fmt.bytes(a.size)}</span>
                <button className="attachment-del" aria-label={t('chat.composer.remove', { name: a.name })} onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ref}
          value={text}
          rows={1}
          aria-label={t('chat.composer.message')}
          placeholder={
            lobby !== undefined
              ? app.running
                ? t('chat.composer.lobbyRunning')
                : lobby
                  ? t('chat.composer.lobbyIdle', { name: lobby.name })
                  : t('chat.composer.lobbyIdleUnnamed')
              : app.running
                ? t('chat.composer.working')
                : bot
                  ? t('chat.composer.messageBot', { name: bot.name })
                  : t('chat.composer.placeholder')
          }
          onChange={(e) => {
            setText(e.target.value)
            setSel(0)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="composer-bar">
          <div className="composer-tools">
          {lobby !== undefined ? (
            <MicButton app={app} onText={(said) => onVoice.current(said)} onError={onError} />
          ) : (
            <>
              <button className="icon-btn attach" onClick={pick} aria-label={t('chat.composer.attach')} title={t('chat.composer.attachTitle')}>
                <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
                  <path d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5.2 5.2a4.2 4.2 0 0 0 6 6l4.4-4.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <MicButton app={app} onText={(said) => onVoice.current(said)} onError={onError} />
              <HandsFree app={app} send={(said) => void api.agent.send(said).catch(onError)} onError={onError} />
              <button className="chip model-chip" onClick={onOpenPicker} title={t('chat.composer.switchModel', { key: app.platform === 'darwin' ? '⌘K' : 'Ctrl+K' })}>
                <span className={`dot ${ready ? 'ok' : 'bad'}`} aria-label={t(ready ? 'chat.composer.providerReady' : 'chat.composer.providerSetup')} />
                {model && <ProviderLogo id={model.providerId} size={13} />}
                {model && <MakerLogo modelId={model.modelId} providerId={model.providerId} size={13} />}
                <span className="model-chip-name">{model ? modelLabel(model.modelId) : t('chat.composer.pickModel')}</span>
                <span className="muted small">{model?.providerId}</span>
              </button>
              {model && <ThinkingPicker app={app} model={model} onState={onState} onError={onError} />}
              {model && moaReady(app.settings) && (
                <button
                  className={`chip mix ${mixing ? 'on' : ''}`}
                  aria-pressed={mixing}
                  onClick={() => api.agent.setMoa(!mixing).then(onState, onError)}
                  title={t('chat.composer.mixTitle', { count: moa.proposers.length, model: modelLabel(moa.aggregator!.modelId) })}
                >
                  {mixing ? t('chat.composer.mixCount', { count: moa.proposers.length }) : t('chat.composer.mix')}
                </button>
            )}
              {/* Narrow windows: the same choice as one compact picker, so the bar never wraps. */}
              <select
                className="chip mode-compact"
                aria-label={t('chat.composer.mode')}
                title={t('chat.composer.modeTitle')}
                value={app.mode}
                onChange={(e) => api.agent.setMode(e.target.value as PermissionMode).then(onState, onError)}
              >
                {MODE_LIST.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <div className="modes" title={t('chat.composer.modeTitle')}>
                {MODE_LIST.map((m) => (
                  <button key={m.id} aria-pressed={app.mode === m.id} className={`mode mode-${m.id} ${app.mode === m.id ? 'on' : ''}`} title={m.hint} onClick={() => api.agent.setMode(m.id).then(onState, onError)}>
                    {m.label}
                  </button>
                ))}
              </div>
            </>
          )}
          </div>
          {app.running && lobby !== undefined && text.trim() ? (
            <button className="btn primary" onClick={() => submit()} title={t('chat.composer.interrupt')}>
              {t('chat.composer.send')} ↵
            </button>
          ) : app.running ? (
            <button className="btn stop" onClick={() => api.agent.stop()}>
              ■ {t('common.stop')}
            </button>
          ) : (
            <button className="btn primary" disabled={!text.trim() && !attachments.length} onClick={() => submit()}>
              {t('chat.composer.send')} ↵
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
