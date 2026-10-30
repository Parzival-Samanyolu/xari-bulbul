import { useState } from 'react'
import { EFFORT_LABELS, EFFORT_LEVELS, refKey } from '@harness/core/catalog'
import type { ModelRef, Settings } from '../../../../../shared/ipc'
import { ListOfModels } from './parts'
import { NumberField, Row, Section, Select, Toggle } from '../../fields'
import { ModelPicker } from '../../ModelPicker'
import { ModelChoice, refText, type PageProps } from '../common'

export const EFFORTS = [{ value: '', label: 'Provider default' }, ...EFFORT_LEVELS.map((e) => ({ value: e, label: EFFORT_LABELS[e] }))]

const TRI_STATE = [
  { value: '', label: 'Auto' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]

export const PROMPT_STYLES = [
  { value: 'auto', label: 'Auto (short for free models)' },
  { value: 'full', label: 'Full' },
  { value: 'lean', label: 'Short' },
]

const SPEEDS = [
  { value: '', label: 'Standard' },
  { value: 'fast', label: 'Fast' },
  { value: 'batch', label: 'Batch' },
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
  const m = app.settings.models
  const [picking, setPicking] = useState<null | 'override' | 'favorite'>(null)
  const defKey = refKey(m.default)
  const mod = app.platform === 'darwin' ? '⌘K' : 'Ctrl+K'
  const onPick = (r: ModelRef) => {
    const k = refKey(r)
    if (picking === 'favorite') save((s) => (s.models.favorites.some((f) => refKey(f) === k) || s.models.favorites.push(r), s))
    if (picking === 'override') save((s) => ((s.models.overrides[k] ??= {}), s))
  }
  return (
    <>
      <Section title="Defaults">
        <Row label="Default model" hint={`Used for new chats. Switch any time with ${mod}.`}>
          <ModelChoice app={app} value={m.default} empty="Choose…" required onChange={(r) => r && save((s) => ((s.models.default = r), s))} onState={onState} onError={onError} title="Default model for new chats…" />
        </Row>
        <Row label="Reasoning effort" hint="How long thinking models think before answering, when the model supports it.">
          <Select label="Reasoning effort" value={(m.reasoningEffort ?? '') as string} options={EFFORTS} onChange={(v) => save((s) => ((s.models.reasoningEffort = (v || null) as never), s))} />
        </Row>
        <Row label="Context window" hint={`For ${refText(m.default)}. Empty uses the size the provider reports.`}>
          <NumberField
            label="Context window"
            nullable
            value={m.overrides[defKey]?.contextLength ?? null}
            min={1000}
            step={1000}
            placeholder="Auto"
            suffix="tokens"
            onChange={(v) => save((s) => setOverride(s, defKey, { contextLength: v ?? undefined }))}
          />
        </Row>
        <Row label="Temperature" hint="Empty uses the provider's default.">
          <NumberField label="Temperature" nullable value={m.temperature} min={0} max={2} step={0.1} placeholder="Default" onChange={(v) => save((s) => ((s.models.temperature = v), s))} />
        </Row>
        <Row label="Max output tokens" hint="Longest reply per request. Empty uses the provider's default.">
          <NumberField label="Max output tokens" nullable value={m.maxTokens} min={1} placeholder="Default" onChange={(v) => save((s) => ((s.models.maxTokens = v), s))} />
        </Row>
        <Row label="Fallback context size" hint="Used when a provider doesn't report a model's context size (Ollama, some local servers).">
          <NumberField label="Fallback context size" value={m.defaultContextLength} min={1000} step={1000} suffix="tokens" onChange={(v) => save((s) => ((s.models.defaultContextLength = v ?? 128000), s))} />
        </Row>
      </Section>
      <Section title="Model switcher">
        <Row label="Free models only" hint="Hides paid models from providers that list prices. The switcher has the same filter.">
          <Toggle label="Free models only" value={m.picker.freeOnly} onChange={(v) => save((s) => ((s.models.picker.freeOnly = v), s))} />
        </Row>
        <Row label="Only models that can use tools" hint="The agent needs tools to read and edit files and run commands.">
          <Toggle label="Only models that can use tools" value={m.picker.toolsOnly} onChange={(v) => save((s) => ((s.models.picker.toolsOnly = v), s))} />
        </Row>
        <Row label="Favorites" hint="Pinned at the top of the switcher." wide>
          <ListOfModels refs={m.favorites} onRemove={(r) => save((s) => ((s.models.favorites = s.models.favorites.filter((x) => refKey(x) !== refKey(r))), s))} />
          <button className="btn" onClick={() => setPicking('favorite')}>
            Add favorite
          </button>
        </Row>
      </Section>
      <Section title="Per-model overrides" description="Settings that apply to one model only.">
        {Object.entries(m.overrides).map(([k, o]) => (
          <div key={k} className="override">
            <div className="provider-head">
              <code>{k}</code>
              <div className="spacer" />
              <button className="link danger small" onClick={() => save((s) => (delete s.models.overrides[k], s))}>
                Remove
              </button>
            </div>
            <div className="override-grid">
              <label>
                Temperature
                <NumberField nullable value={o.temperature ?? null} min={0} max={2} step={0.1} placeholder="—" onChange={(v) => save((s) => setOverride(s, k, { temperature: v ?? undefined }))} />
              </label>
              <label>
                Max tokens
                <NumberField nullable value={o.maxTokens ?? null} min={1} placeholder="—" onChange={(v) => save((s) => setOverride(s, k, { maxTokens: v ?? undefined }))} />
              </label>
              <label>
                Context size
                <NumberField nullable value={o.contextLength ?? null} min={1000} placeholder="—" onChange={(v) => save((s) => setOverride(s, k, { contextLength: v ?? undefined }))} />
              </label>
              <label>
                Reasoning
                <Select value={(o.reasoningEffort ?? '') as string} options={EFFORTS} onChange={(v) => save((s) => setOverride(s, k, { reasoningEffort: (v || undefined) as never }))} />
              </label>
              <label title="Fast: the provider's fast option (Anthropic fast mode, OpenAI priority, OpenRouter fastest host), costs more. Batch: Anthropic and OpenAI batch APIs, about half price but each step can take minutes.">
                Speed
                <Select value={o.speed === 'standard' ? '' : (o.speed ?? '')} options={SPEEDS} onChange={(v) => save((s) => setOverride(s, k, { speed: (v || undefined) as never }))} />
              </label>
              <label title="Send the model's reasoning back during a tool loop. Auto = on, except OpenAI's own API.">
                Replay reasoning
                <Select value={o.replayReasoning == null ? '' : o.replayReasoning ? 'on' : 'off'} options={TRI_STATE} onChange={(v) => save((s) => setOverride(s, k, { replayReasoning: v ? v === 'on' : undefined }))} />
              </label>
              <label>
                Prompt
                <Select value={o.promptStyle ?? ''} options={[{ value: '', label: 'Chat setting' }, ...PROMPT_STYLES.slice(1)]} onChange={(v) => save((s) => setOverride(s, k, { promptStyle: (v || undefined) as never }))} />
              </label>
            </div>
          </div>
        ))}
        <div>
          <button className="btn" onClick={() => setPicking('override')}>
            Add override
          </button>
        </div>
      </Section>
      {picking && <ModelPicker app={app} onClose={() => setPicking(null)} onState={onState} onError={onError} onPick={onPick} title="Choose a model…" />}
    </>
  )
}

export function AuxModelsPage({ app, save, onState, onError, go }: PageProps) {
  const m = app.settings.models
  const common = { app, onState, onError }
  return (
    <Section title="Background tasks">
      <Row label="Chat naming model" hint="Names new chats from the first message. Off: the first line becomes the title.">
        <ModelChoice {...common} value={m.title} empty="Off" resetLabel="turn off" onChange={(r) => save((s) => ((s.models.title = r), s))} />
      </Row>
      <Row label="Memory model" hint="After each reply, saves lasting facts (your preferences, project commands) to memory. Empty uses the chat naming model.">
        <ModelChoice {...common} value={m.memoryReview} empty={m.title ? 'Same as chat naming model' : 'Off'} onChange={(r) => save((s) => ((s.models.memoryReview = r), s))} />
      </Row>
      <Row label="Summarization model" hint="Summarizes older messages when a chat fills its context. A cheap, fast model works well. Empty uses the chat's model.">
        <ModelChoice {...common} value={m.compaction} empty="Same as the chat's model" onChange={(r) => save((s) => ((s.models.compaction = r), s))} />
      </Row>
      <Row label="Transcription model" hint="Turns voice recordings into text.">
        <div className="inline">
          <span className="muted small">{m.transcription ? refText(m.transcription) : 'Off'}</span>
          <button className="link small" onClick={() => go('voice.stt')}>
            Change in Speech to text
          </button>
        </div>
      </Row>
    </Section>
  )
}

export function SubagentsPage({ app, save, onState, onError }: PageProps) {
  const a = app.settings.agent.subagents
  return (
    <Section>
      <Row label="Allow subagents" hint="Gives the agent the task tool. Subagents follow the same permissions, and their cost counts toward the chat.">
        <Toggle label="Allow subagents" value={a.enabled} onChange={(v) => save((s) => ((s.agent.subagents.enabled = v), s))} />
      </Row>
      <Row label="Subagent model" hint="A fast free model suits searching and research. Empty uses the chat's model.">
        <ModelChoice app={app} onState={onState} onError={onError} value={a.model} empty="Same as the chat's model" onChange={(r) => save((s) => ((s.agent.subagents.model = r), s))} />
      </Row>
      <Row label="Subagents can edit" hint="Off: subagents only read and search. Edits and commands still ask in Ask mode.">
        <Toggle label="Subagents can edit" value={a.allowWrite} onChange={(v) => save((s) => ((s.agent.subagents.allowWrite = v), s))} />
      </Row>
      <Row label="Run at once" hint="Subagents started together run in parallel, up to this many.">
        <NumberField label="Subagents at once" value={a.maxParallel} min={1} max={8} onChange={(v) => save((s) => ((s.agent.subagents.maxParallel = v ?? 3), s))} />
      </Row>
      <Row label="Max steps per subagent" hint="Model requests one subagent may make before it has to report back.">
        <NumberField label="Max steps per subagent" value={a.maxSteps} min={1} max={500} onChange={(v) => save((s) => ((s.agent.subagents.maxSteps = v ?? 50), s))} />
      </Row>
    </Section>
  )
}
