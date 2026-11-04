import { useEffect, useState } from 'react'
import type { ResourceSample } from '../../../shared/ipc'
import { api } from './api'

/** Bytes as "512 MB" / "1.4 GB". */
export function bytes(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** CPU as a percent of one core. */
export function cpuText(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}%`
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

/**
 * Samples the app's memory and CPU every `everyMs` while `on` and the window is visible.
 * Main measures only when asked, so nothing runs while no readout is on screen.
 */
export function useResources(on: boolean, everyMs = 2000): ResourceSample | null {
  const [sample, setSample] = useState<ResourceSample | null>(null)
  const visible = usePageVisible()
  useEffect(() => {
    if (!on || !visible) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () =>
      void api.monitor
        .sample()
        .then((s) => alive && setSample(s), () => {})
        .finally(() => {
          if (alive) timer = setTimeout(tick, everyMs)
        })
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [on, visible, everyMs])
  return on ? sample : null
}
