import { useState } from 'react'
import { EFFORT_LEVELS, refKey } from '@harness/core/catalog'
import type { ModelRef, Settings } from '../../../../../shared/ipc'
import { moaReady, MOA_MAX_PROPOSERS } from '@harness/core/moa'
import { useFormat, useT } from '../../../lib/i18n'
import { ListOfModels, OrderedModels } from './parts'
import { NumberField, Row, Section, Select, Toggle } from '../../fields'
import { ModelPicker } from '../../ModelPicker'
import { ModelChoice, refText, type PageProps } from '../common'

type T = ReturnType<typeof useT>['t']

/** Reasoning effort options, "provider default" first. */
export const efforts = (t: T) => [{ value: '', label: t('settings.effort.default') }, ...EFFORT_LEVELS.map((e) => ({ value: e, label: t(`settings.effort.${e}`) }))]

const triState = (t: T) => [
  { value: '', label: t('settings.model.auto') },
  { value: 'on', label: t('common.on') },
  { value: 'off', label: t('common.off') },
]

export const promptStyles = (t: T) => [
  { value: 'auto', label: t('settings.promptStyle.auto') },
  { value: 'full', label: t('settings.promptStyle.full') },
  { value: 'lean', label: t('settings.promptStyle.lean') },
]

const speeds = (t: T) => [
  { value: '', label: t('settings.model.speedStandard') },
  { value: 'fast', label: t('settings.model.speedFast') },
  { value: 'batch', label: t('settings.model.speedBatch') },
]

/** Sets one field of a per-model override, dropping the override once it's empty. */
function setOverride(s: Settings, key: string, patch: Partial<Settings['models']['overrides'][string]>): Settings {
  const next = { ...(s.models.overrides[key] ?? {}), ...patch }
  for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined) delete next[k]
  if (Object.keys(next).length) s.models.overrides[key] = next
  else delete s.models.overrides[key]
  return s
}

export function MainModelPage({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
  const m = app.settings.models
  const [picking, setPicking] = useState<null | 'override' | 'favorite'>(null)
  const defKey = refKey(m.default)
  const mod = app.platform === 'darwin' ? '⌘K' : 'Ctrl+K'
  const effortOptions = efforts(t)
  const onPick = (r: ModelRef) => {
    const k = refKey(r)
    if (picking === 'favorite') save((s) => (s.models.favorites.some((f) => refKey(f) === k) || s.models.favorites.push(r), s))
    if (picking === 'override') save((s) => ((s.models.overrides[k] ??= {}), s))
  }
  return (
    <>
      <Section title={t('settings.model.defaults')}>
        <Row label={t('settings.model.defaultModel')} hint={t('settings.model.defaultModelHint', { keys: mod })}>
          <ModelChoice
            app={app}
            value={m.default}
            empty={t('settings.model.choose')}
            required
            onChange={(r) => r && save((s) => ((s.models.default = r), s))}
            onState={onState}
            onError={onError}
            title={t('settings.model.defaultModelTitle')}
          />
        </Row>
        <Row label={t('settings.model.reasoningEffort')} hint={t('settings.model.reasoningEffortHint')}>
          <Select label={t('settings.model.reasoningEffort')} value={(m.reasoningEffort ?? '') as string} options={effortOptions} onChange={(v) => save((s) => ((s.models.reasoningEffort = (v || null) as never), s))} />
        </Row>
        <Row label={t('settings.model.contextWindow')} hint={t('settings.model.contextWindowHint', { model: refText(m.default) })}>
          <NumberField
            label={t('settings.model.contextWindow')}
            nullable
            value={m.overrides[defKey]?.contextLength ?? null}
            min={1000}
            step={1000}
            placeholder={t('settings.model.auto')}
            suffix={t('settings.model.tokens')}
            onChange={(v) => save((s) => setOverride(s, defKey, { contextLength: v ?? undefined }))}
          />
        </Row>
        <Row label={t('settings.model.temperature')} hint={t('settings.model.temperatureHint')}>
          <NumberField label={t('settings.model.temperature')} nullable value={m.temperature} min={0} max={2} step={0.1} placeholder={t('common.default')} onChange={(v) => save((s) => ((s.models.temperature = v), s))} />
        </Row>
        <Row label={t('settings.model.maxOutputTokens')} hint={t('settings.model.maxOutputTokensHint')}>
          <NumberField label={t('settings.model.maxOutputTokens')} nullable value={m.maxTokens} min={1} placeholder={t('common.default')} onChange={(v) => save((s) => ((s.models.maxTokens = v), s))} />
        </Row>
        <Row label={t('settings.model.fallbackContext')} hint={t('settings.model.fallbackContextHint')}>
          <NumberField
            label={t('settings.model.fallbackContext')}
            value={m.defaultContextLength}
            min={1000}
            step={1000}
            suffix={t('settings.model.tokens')}
            onChange={(v) => save((s) => ((s.models.defaultContextLength = v ?? 128000), s))}
          />
        </Row>
      </Section>
      <Section title={t('settings.model.switcher')}>
        <Row label={t('settings.model.freeOnly')} hint={t('settings.model.freeOnlyHint')}>
          <Toggle label={t('settings.model.freeOnly')} value={m.picker.freeOnly} onChange={(v) => save((s) => ((s.models.picker.freeOnly = v), s))} />
        </Row>
        <Row label={t('settings.model.toolsOnly')} hint={t('settings.model.toolsOnlyHint')}>
          <Toggle label={t('settings.model.toolsOnly')} value={m.picker.toolsOnly} onChange={(v) => save((s) => ((s.models.picker.toolsOnly = v), s))} />
        </Row>
        <Row label={t('settings.model.favorites')} hint={t('settings.model.favoritesHint')} wide>
          <ListOfModels refs={m.favorites} onRemove={(r) => save((s) => ((s.models.favorites = s.models.favorites.filter((x) => refKey(x) !== refKey(r))), s))} />
          <button className="btn" onClick={() => setPicking('favorite')}>
            {t('settings.model.addFavorite')}
          </button>
        </Row>
      </Section>
      <Section title={t('settings.model.overrides')} description={t('settings.model.overridesDesc')}>
        {Object.entries(m.overrides).map(([k, o]) => (
          <div key={k} className="override">
            <div className="provider-head">
              <code>{k}</code>
              <div className="spacer" />
              <button className="link danger small" onClick={() => save((s) => (delete s.models.overrides[k], s))}>
                {t('common.remove')}
              </button>
            </div>
            <div className="override-grid">
              <label>
                {t('settings.model.temperature')}
                <NumberField nullable value={o.temperature ?? null} min={0} max={2} step={0.1} placeholder="—" onChange={(v) => save((s) => setOverride(s, k, { temperature: v ?? undefined }))} />
              </label>
              <label>
                {t('settings.model.maxTokens')}
                <NumberField nullable value={o.maxTokens ?? null} min={1} placeholder="—" onChange={(v) => save((s) => setOverride(s, k, { maxTokens: v ?? undefined }))} />
              </label>
              <label>
                {t('settings.model.contextSize')}
                <NumberField nullable value={o.contextLength ?? null} min={1000} placeholder="—" onChange={(v) => save((s) => setOverride(s, k, { contextLength: v ?? undefined }))} />
              </label>
              <label>
                {t('settings.model.reasoning')}
                <Select value={(o.reasoningEffort ?? '') as string} options={effortOptions} onChange={(v) => save((s) => setOverride(s, k, { reasoningEffort: (v || undefined) as never }))} />
              </label>
              <label title={t('settings.model.speedHelp')}>
                {t('settings.model.speed')}
                <Select value={o.speed === 'standard' ? '' : (o.speed ?? '')} options={speeds(t)} onChange={(v) => save((s) => setOverride(s, k, { speed: (v || undefined) as never }))} />
              </label>
              <label title={t('settings.model.replayHelp')}>
                {t('settings.model.replay')}
                <Select value={o.replayReasoning == null ? '' : o.replayReasoning ? 'on' : 'off'} options={triState(t)} onChange={(v) => save((s) => setOverride(s, k, { replayReasoning: v ? v === 'on' : undefined }))} />
              </label>
              <label>
                {t('settings.model.prompt')}
                <Select
                  value={o.promptStyle ?? ''}
                  options={[{ value: '', label: t('settings.model.chatSetting') }, ...promptStyles(t).slice(1)]}
                  onChange={(v) => save((s) => setOverride(s, k, { promptStyle: (v || undefined) as never }))}
                />
              </label>
            </div>
          </div>
        ))}
        <div>
          <button className="btn" onClick={() => setPicking('override')}>
            {t('settings.model.addOverride')}
          </button>
        </div>
      </Section>
      {picking && <ModelPicker app={app} onClose={() => setPicking(null)} onState={onState} onError={onError} onPick={onPick} title={t('settings.common.chooseModel')} />}
    </>
  )
}

export function AuxModelsPage({ app, save, onState, onError, go }: PageProps) {
  const { t } = useT()
  const m = app.settings.models
  const common = { app, onState, onError }
  return (
    <Section title={t('settings.model.background')}>
      <Row label={t('settings.model.titleModel')} hint={t('settings.model.titleModelHint')}>
        <ModelChoice {...common} value={m.title} empty={t('common.off')} resetLabel={t('settings.model.turnOff')} onChange={(r) => save((s) => ((s.models.title = r), s))} />
      </Row>
      <Row label={t('settings.model.memoryModel')} hint={t('settings.model.memoryModelHint')}>
        <ModelChoice {...common} value={m.memoryReview} empty={m.title ? t('settings.model.sameAsTitle') : t('common.off')} onChange={(r) => save((s) => ((s.models.memoryReview = r), s))} />
      </Row>
      <Row label={t('settings.model.summaryModel')} hint={t('settings.model.summaryModelHint')}>
        <ModelChoice {...common} value={m.compaction} empty={t('settings.model.sameAsChat')} onChange={(r) => save((s) => ((s.models.compaction = r), s))} />
      </Row>
      <Row label={t('settings.model.transcriptionModel')} hint={t('settings.model.transcriptionModelHint')}>
        <div className="inline">
          <span className="muted small">{m.transcription ? refText(m.transcription) : t('common.off')}</span>
          <button className="link small" onClick={() => go('voice.stt')}>
            {t('settings.model.changeInStt')}
          </button>
        </div>
      </Row>
    </Section>
  )
}

export function SubagentsPage({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
  const a = app.settings.agent.subagents
  return (
    <Section>
      <Row label={t('settings.subagents.allow')} hint={t('settings.subagents.allowHint')}>
        <Toggle label={t('settings.subagents.allow')} value={a.enabled} onChange={(v) => save((s) => ((s.agent.subagents.enabled = v), s))} />
      </Row>
      <Row label={t('settings.subagents.model')} hint={t('settings.subagents.modelHint')}>
        <ModelChoice app={app} onState={onState} onError={onError} value={a.model} empty={t('settings.model.sameAsChat')} onChange={(r) => save((s) => ((s.agent.subagents.model = r), s))} />
      </Row>
      <Row label={t('settings.subagents.canEdit')} hint={t('settings.subagents.canEditHint')}>
        <Toggle label={t('settings.subagents.canEdit')} value={a.allowWrite} onChange={(v) => save((s) => ((s.agent.subagents.allowWrite = v), s))} />
      </Row>
      <Row label={t('settings.subagents.parallel')} hint={t('settings.subagents.parallelHint')}>
        <NumberField label={t('settings.subagents.parallelLabel')} value={a.maxParallel} min={1} max={8} onChange={(v) => save((s) => ((s.agent.subagents.maxParallel = v ?? 3), s))} />
      </Row>
      <Row label={t('settings.subagents.maxSteps')} hint={t('settings.subagents.maxStepsHint')}>
        <NumberField label={t('settings.subagents.maxSteps')} value={a.maxSteps} min={1} max={500} onChange={(v) => save((s) => ((s.agent.subagents.maxSteps = v ?? 50), s))} />
      </Row>
    </Section>
  )
}

const sameRef = (a: ModelRef) => (b: ModelRef) => refKey(a) === refKey(b)

export function FallbackPage({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
  const list = app.settings.models.fallbacks
  const [adding, setAdding] = useState(false)
  return (
    <>
      <Section title={t('settings.fallback.models')} description={t('settings.fallback.modelsDesc')}>
        <Row label={t('settings.fallback.order')} hint={t('settings.fallback.orderHint')} wide>
          <OrderedModels refs={list} ready={app.ready} onChange={(refs) => save((s) => ((s.models.fallbacks = refs), s))} />
          <div>
            <button className="btn" onClick={() => setAdding(true)}>
              {t('settings.fallback.add')}
            </button>
          </div>
        </Row>
      </Section>
      <Section title={t('settings.fallback.noSwitch')} description={t('settings.fallback.noSwitchDesc')} />
      {adding && (
        <ModelPicker
          app={app}
          onClose={() => setAdding(false)}
          onState={onState}
          onError={onError}
          onPick={(r) => save((s) => (s.models.fallbacks.some(sameRef(r)) || s.models.fallbacks.push(r), s))}
          title={t('settings.fallback.addTitle')}
        />
      )}
    </>
  )
}

export function MoaPage({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
  const { num } = useFormat()
  const moa = app.settings.moa
  const ready = moaReady(app.settings)
  const [adding, setAdding] = useState(false)
  const full = moa.proposers.length >= MOA_MAX_PROPOSERS
  return (
    <>
      <Section title={t('settings.moa.title')} description={t('settings.moa.desc')}>
        <Row label={t('settings.moa.onByDefault')} hint={ready ? t('settings.moa.onByDefaultHint') : t('settings.moa.notReady')}>
          <Toggle label={t('settings.moa.onByDefault')} value={moa.enabled && ready} disabled={!ready} onChange={(v) => save((s) => ((s.moa.enabled = v), s))} />
        </Row>
        <Row label={t('settings.moa.proposers')} hint={t('settings.moa.proposersHint', { max: MOA_MAX_PROPOSERS })} wide>
          <ListOfModels refs={moa.proposers} onRemove={(r) => save((s) => ((s.moa.proposers = s.moa.proposers.filter((x) => !sameRef(r)(x))), s))} />
          <div>
            <button className="btn" disabled={full} onClick={() => setAdding(true)}>
              {full ? t('settings.moa.atMost', { count: MOA_MAX_PROPOSERS }) : t('settings.moa.addProposer')}
            </button>
          </div>
        </Row>
        <Row label={t('settings.moa.aggregator')} hint={t('settings.moa.aggregatorHint')}>
          <ModelChoice
            app={app}
            onState={onState}
            onError={onError}
            value={moa.aggregator}
            empty={t('settings.model.choose')}
            resetLabel={t('settings.moa.clear')}
            title={t('settings.moa.aggregatorTitle')}
            onChange={(r) => save((s) => ((s.moa.aggregator = r), s))}
          />
        </Row>
      </Section>
      <Section title={t('settings.moa.cost')} description={t('settings.moa.costDesc', { count: Math.max(moa.proposers.length, 2) + 1, tokens: num(6000) })} />
      {adding && (
        <ModelPicker
          app={app}
          onClose={() => setAdding(false)}
          onState={onState}
          onError={onError}
          onPick={(r) => save((s) => (s.moa.proposers.some(sameRef(r)) || s.moa.proposers.length >= MOA_MAX_PROPOSERS || s.moa.proposers.push(r), s))}
          title={t('settings.moa.addProposerTitle')}
        />
      )}
    </>
  )
}
