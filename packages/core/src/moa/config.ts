// Mixture of Agents settings helpers. No Node imports: the renderer uses this too (`@harness/core/moa`).
import type { Settings } from '../settings/schema.js'

export const MOA_MIN_PROPOSERS = 2
export const MOA_MAX_PROPOSERS = 4

/** Configured well enough to run: at least two proposers and a combining model. */
export function moaReady(settings: Pick<Settings, 'moa'>): boolean {
  return settings.moa.proposers.length >= MOA_MIN_PROPOSERS && !!settings.moa.aggregator
}

/** Whether a chat mixes its final answers: its own toggle, else the default, and only once configured. */
export function moaOn(settings: Pick<Settings, 'moa'>, meta: { moa?: boolean } | undefined): boolean {
  return moaReady(settings) && (meta?.moa ?? settings.moa.enabled)
}
