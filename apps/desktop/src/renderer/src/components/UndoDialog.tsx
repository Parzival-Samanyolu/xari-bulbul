import { useEffect, useId, useRef, useState } from 'react'
import type { Checkpoint } from '../../../shared/ipc'
import { useT } from '../lib/i18n'

/** `file` relative to `cwd` with / separators, or as is when it's outside. */
export function relTo(cwd: string, file: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = norm(cwd)
  const f = norm(file)
  return base && f.startsWith(`${base}/`) ? f.slice(base.length + 1) : f
}

/** Asks before putting back every file a turn changed, listing them. */
export function UndoDialog({ checkpoint, cwd, onCancel, onConfirm }: { checkpoint: Checkpoint; cwd: string; onCancel: () => void; onConfirm: () => Promise<unknown> }) {
  const { t } = useT()
  const ids = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const primary = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const files = Object.keys(checkpoint.files).map((f) => ({ abs: f, rel: relTo(cwd, f), added: checkpoint.files[f] === null }))
  files.sort((a, b) => a.rel.localeCompare(b.rel))

  // Focus the confirm button, and give focus back to whatever opened the dialog.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    primary.current?.focus()
    return () => before?.focus?.()
  }, [])

  const confirm = () => {
    setBusy(true)
    void onConfirm().finally(() => setBusy(false))
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !busy) (e.stopPropagation(), onCancel())
    if (e.key === 'Tab') {
      const f = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])]
      const i = f.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && i <= 0) (e.preventDefault(), f.at(-1)?.focus())
      else if (!e.shiftKey && i === f.length - 1) (e.preventDefault(), f[0]?.focus())
    }
  }

  return (
    <div className="overlay" onMouseDown={() => !busy && onCancel()}>
      <div
        className="dialog undo-dialog"
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${ids}-t`}
        aria-describedby={`${ids}-d`}
        aria-busy={busy}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <span className="dialog-title" id={`${ids}-t`}>
          {t('chat.undo.title')}
        </span>
        <div id={`${ids}-d`}>
          <p className="undo-intro">{t('chat.undo.intro', { count: files.length })}</p>
          <ul className="undo-files">
            {files.map((f) => (
              <li key={f.abs} className="mono ellipsis" title={f.abs}>
                {f.rel}
              </li>
            ))}
          </ul>
          <p className="muted small">{t('chat.undo.shell')}</p>
        </div>
        <div className="dialog-actions undo-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" ref={primary} onClick={confirm} disabled={busy} aria-busy={busy}>
            {t('chat.undo.button')}
          </button>
        </div>
      </div>
    </div>
  )
}
