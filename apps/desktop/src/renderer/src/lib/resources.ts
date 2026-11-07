import { useEffect, useState } from 'react'
import { formatNumber, type Lang } from '@harness/core/i18n'
import type { ResourceSample } from '../../../shared/ipc'
import { api } from './api'

/** CPU as a percent of one core, in the language's number format. */
export function cpuText(lang: Lang, n: number | null | undefined): string {
  if (n == null) return '—'
  const digits = n < 10 ? 1 : 0
  return formatNumber(lang, n / 100, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits })
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
