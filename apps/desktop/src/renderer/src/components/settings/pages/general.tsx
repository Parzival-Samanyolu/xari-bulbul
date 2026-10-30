import { useState } from 'react'
import { api } from '../../../lib/api'
import { FIXED_SHORTCUTS, SHORTCUTS, comboFromEvent, comboProblem, formatCombo, isMac, shortcutFor, type ShortcutId } from '../../../lib/shortcuts'
import { ListField, Row, Section, Select, Slider, TextField, Toggle } from '../../fields'
import { LayoutPicker, withLayout } from '../../LayoutPicker'
import type { PageProps } from '../common'
import { PROMPT_STYLES } from './model'

export function ChatPage({ app, save }: PageProps) {
  const a = app.settings.appearance
  const g = app.settings.agent
  const mod = app.platform === 'darwin' ? '⌘Enter' : 'Ctrl+Enter'
  return (
    <>
      <Section title="Messages">
        <Row label="Enter sends message" hint={`Off: Enter adds a new line and ${mod} sends.`}>
          <Toggle label="Enter sends message" value={a.sendWithEnter} onChange={(v) => save((s) => ((s.appearance.sendWithEnter = v), s))} />
        </Row>
        <Row label="Show model reasoning" hint="The thinking that reasoning models stream before they answer.">
          <Toggle label="Show model reasoning" value={a.showReasoning} onChange={(v) => save((s) => ((s.appearance.showReasoning = v), s))} />
        </Row>
        <Row label="Expand tool calls" hint="Open each tool call's details by default. Diffs are always open.">
          <Toggle label="Expand tool calls" value={a.expandToolCalls} onChange={(v) => save((s) => ((s.appearance.expandToolCalls = v), s))} />
        </Row>
      </Section>
      <Section title="Instructions">
        <Row label="Custom instructions" hint="Added to every chat, in every project." wide>
          <TextField label="Custom instructions" multiline rows={5} value={g.customInstructions} placeholder="e.g. Always use pnpm. Prefer small commits. Write tests with vitest." onChange={(v) => save((s) => ((s.agent.customInstructions = v), s))} />
        </Row>
        <Row label="System prompt" hint="Short drops the detailed guidance, which small models follow better. Auto uses it for free models.">
          <Select label="System prompt" value={g.promptStyle} options={PROMPT_STYLES as { value: typeof g.promptStyle; label: string }[]} onChange={(v) => save((s) => ((s.agent.promptStyle = v), s))} />
        </Row>
        <Row label="System prompt override" hint="Replaces the built-in system prompt entirely. Leave empty to use the built-in one." wide>
          <TextField label="System prompt override" multiline mono rows={6} value={g.systemPromptOverride} placeholder="Built-in prompt" onChange={(v) => save((s) => ((s.agent.systemPromptOverride = v), s))} />
        </Row>
      </Section>
    </>
  )
}

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'oled', label: 'OLED black' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'contrast', label: 'High contrast' },
] as const

export function AppearancePage({ app, save }: PageProps) {
  const a = app.settings.appearance
  return (
    <>
      <Section title="Layout">
        <Row label="Layout" hint="Elite opens a files and changes panel on the right and a terminal at the bottom. Either layout can open or close them." wide>
          <LayoutPicker value={a.layout} onChange={(v) => v !== a.layout && save((s) => withLayout(s, v))} />
        </Row>
      </Section>
      <Section title="Look">
        <Row label="Theme">
          <Select label="Theme" value={a.theme} options={[...THEMES]} onChange={(v) => save((s) => ((s.appearance.theme = v), s))} />
        </Row>
        <Row label="Font size">
          <Slider label="Font size" value={a.fontSize} min={11} max={20} step={1} format={(v) => `${v}px`} onChange={(v) => save((s) => ((s.appearance.fontSize = v), s))} />
        </Row>
        <Row label="Interface font" hint="A font installed on this computer, or a CSS font list. Empty uses the system font." labelFor="ui-font">
          <TextField id="ui-font" value={a.fontFamily} placeholder="System font" onChange={(v) => save((s) => ((s.appearance.fontFamily = v.trim()), s))} />
        </Row>
        <Row label="Code font" hint="Used for code, diffs and the terminal." labelFor="code-font">
          <TextField id="code-font" mono value={a.codeFontFamily} onChange={(v) => save((s) => ((s.appearance.codeFontFamily = v), s))} />
        </Row>
        <Row label="Density">
          <Select
            label="Density"
            value={a.density}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
            onChange={(v) => save((s) => ((s.appearance.density = v), s))}
          />
        </Row>
      </Section>
    </>
  )
}

export function WorkspacePage({ app, save, onState, onError }: PageProps) {
  const open = app.settings.app.openWorkspaces
  return (
    <>
      <Section title="Folders">
        <Row label="Open folders" hint="Shown in the sidebar. Closing one keeps its chats on disk." wide>
          <div className="list-field">
            {open.length === 0 && <p className="muted small">No folder is open.</p>}
            {open.map((w) => (
              <div key={w} className="list-item">
                <code title={w}>{w}</code>
                {w === app.workspace && <span className="badge ok">current</span>}
                <button className="link danger small" aria-label={`Close ${w}`} onClick={() => api.workspace.close(w).then(onState, onError)}>
                  Close
                </button>
              </div>
            ))}
          </div>
          <div>
            <button className="btn" onClick={() => api.workspace.pick().then(onState, onError)}>
              Open folder…
            </button>
          </div>
        </Row>
      </Section>
      <Section title="Project files">
        <Row label="Project instruction files" hint="Read from the project folder and its parents up to the repository root, and added to the prompt." wide>
          <ListField label="Project instruction files" value={app.settings.agent.projectInstructionFiles} placeholder="AGENTS.md" onChange={(v) => save((s) => ((s.agent.projectInstructionFiles = v), s))} />
        </Row>
        <Row label="Load project tool code" hint="Runs .harness/tools/*.mjs from the open project. Only turn on for projects you trust. Project commands always load.">
          <Toggle label="Load project tool code" value={app.settings.tools.loadProjectExtensions} onChange={(v) => save((s) => ((s.tools.loadProjectExtensions = v), s))} />
        </Row>
      </Section>
    </>
  )
}

export function NotificationsPage({ app, save }: PageProps) {
  const a = app.settings.app
  const n = a.notify
  const set = (k: keyof typeof n) => (v: boolean) => save((s) => ((s.app.notify[k] = v), s))
  return (
    <>
      <Section>
        <Row label="Notify me" hint="A system notification for chats you're not looking at, including scheduled runs. Clicking it opens the chat.">
          <Toggle label="Notify me" value={a.notifications} onChange={(v) => save((s) => ((s.app.notifications = v), s))} />
        </Row>
      </Section>
      <Section title="When a chat">
        <Row label="Finishes" hint="The agent is done and waiting for you.">
          <Toggle label="Notify when a chat finishes" value={n.finished} onChange={set('finished')} />
        </Row>
        <Row label="Stops early" hint="An error, the step limit or the budget stopped it.">
          <Toggle label="Notify when a chat stops early" value={n.failed} onChange={set('failed')} />
        </Row>
        <Row label="Needs approval" hint="A tool call is waiting for you to allow or deny it.">
          <Toggle label="Notify when a chat needs approval" value={n.approval} onChange={set('approval')} />
        </Row>
        <Row label="Has a question" hint="The agent asked you something and is waiting for the answer.">
          <Toggle label="Notify when a chat has a question" value={n.question} onChange={set('question')} />
        </Row>
      </Section>
    </>
  )
}

export function ShortcutsPage({ app, save }: PageProps) {
  const mac = isMac(app.platform)
  const [recording, setRecording] = useState<ShortcutId | null>(null)
  const [problem, setProblem] = useState<{ id: ShortcutId; text: string } | null>(null)
  const record = (id: ShortcutId) => (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') return (setRecording(null), setProblem(null))
    const combo = comboFromEvent(e.nativeEvent, mac)
    if (!combo) return
    const why = comboProblem(combo, id, app.settings)
    if (why) return setProblem({ id, text: `${formatCombo(combo, mac)}: ${why}` })
    setProblem(null)
    setRecording(null)
    const def = SHORTCUTS.find((s) => s.id === id)!.combo
    save((s) => {
      if (combo === def) delete s.shortcuts[id]
      else s.shortcuts[id] = combo
      return s
    })
  }
  return (
    <>
      <Section title="Shortcuts you can change" description="Click a shortcut, then press the new keys. Esc cancels.">
        {SHORTCUTS.map((sc) => {
          const combo = shortcutFor(app.settings, sc.id)
          const changed = !!app.settings.shortcuts[sc.id]
          const live = recording === sc.id
          return (
            <Row key={sc.id} label={sc.label} hint={problem?.id === sc.id ? <span className="warn">{problem.text}</span> : sc.help}>
              <div className="inline">
                <button
                  className={`btn kbd-btn ${live ? 'recording' : ''}`}
                  aria-label={live ? `Press the new keys for ${sc.label}` : `${sc.label}: ${formatCombo(combo, mac)}. Change`}
                  onClick={() => (setRecording(live ? null : sc.id), setProblem(null))}
                  onKeyDown={live ? record(sc.id) : undefined}
                  onBlur={() => live && setRecording(null)}
                >
                  {live ? 'Press keys…' : <kbd>{formatCombo(combo, mac)}</kbd>}
                </button>
                {changed && (
                  <button className="link small" onClick={() => save((s) => (delete s.shortcuts[sc.id], s))}>
                    Default
                  </button>
                )}
              </div>
            </Row>
          )
        })}
      </Section>
      <Section title="Fixed shortcuts">
        {FIXED_SHORTCUTS.map((f) => (
          <Row key={f.label} label={f.label}>
            <kbd>{formatCombo(f.combo, mac)}</kbd>
          </Row>
        ))}
      </Section>
    </>
  )
}
