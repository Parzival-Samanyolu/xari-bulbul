import { useState } from 'react'
import type { AppState, ModelRef, Settings, UpdateStatus } from '../../../../shared/ipc'
import { modelLabel } from '../../lib/format'
import { ModelPicker } from '../ModelPicker'

export type Save = (fn: (s: Settings) => Settings) => void

export interface PageProps {
  app: AppState
  save: Save
  onState: (s: AppState) => void
  onError: (e: unknown) => void
  /** Opens another settings page. */
  go: (pageId: string) => void
  update: UpdateStatus
  /** Closes Settings (e.g. to show a chat a page started). */
  close: () => void
  /** Opens the bot dialog: a bot's id to edit it, nothing for a new one. */
  editBot: (id?: string) => void
}

export const KEY_LINKS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/keys',
  'ollama-cloud': 'https://ollama.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  mistral: 'https://console.mistral.ai/api-keys',
  xai: 'https://console.x.ai',
  groq: 'https://console.groq.com/keys',
  cerebras: 'https://cloud.cerebras.ai',
  nvidia: 'https://build.nvidia.com/settings/api-keys',
  zai: 'https://z.ai/manage-apikey/apikey-list',
  deepseek: 'https://platform.deepseek.com/api_keys',
}

export const refText = (r: ModelRef) => `${modelLabel(r.modelId)} · ${r.providerId}`

/** A model setting: a button that opens the model switcher, plus a reset link while one is chosen. */
export function ModelChoice({
  app,
  value,
  empty,
  resetLabel = 'reset',
  required,
  title,
  onChange,
  onState,
  onError,
}: {
  app: AppState
  value: ModelRef | null
  /** Shown when nothing is chosen. */
  empty: string
  resetLabel?: string
  /** A model must stay chosen: no reset link. */
  required?: boolean
  title?: string
  onChange: (r: ModelRef | null) => void
  onState: (s: AppState) => void
  onError: (e: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="inline">
      <button className="btn" onClick={() => setOpen(true)}>
        {value ? refText(value) : empty}
      </button>
      {value && !required && (
        <button className="link small" onClick={() => onChange(null)}>
          {resetLabel}
        </button>
      )}
      {open && <ModelPicker app={app} onClose={() => setOpen(false)} onState={onState} onError={onError} onPick={(r) => onChange(r)} title={title ?? 'Choose a model…'} />}
    </div>
  )
}

/** Masked input that saves a secret on Enter or Save. */
export function SecretInput({
  id,
  saved,
  placeholder,
  onSave,
  label,
}: {
  id: string
  saved: boolean
  placeholder: string
  label: string
  onSave: (value: string) => Promise<unknown>
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const commit = () => {
    if (!text.trim() || busy) return
    setBusy(true)
    onSave(text.trim())
      .then(() => setText(''))
      .finally(() => setBusy(false))
  }
  return (
    <div className="key-row">
      <input
        id={id}
        type="password"
        className="mono"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        placeholder={saved ? '•••••••• saved' : placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commit())}
      />
      <button className="btn primary" disabled={!text.trim() || busy} onClick={commit}>
        Save
      </button>
    </div>
  )
}
