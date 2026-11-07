import { useState } from 'react'
import { LANGS, LANGUAGE_NAMES } from '@harness/core/i18n'
import type { MessageKey } from '../../../../../shared/i18n/catalog'
import { api } from '../../../lib/api'
import { useSystemLang, useT } from '../../../lib/i18n'
import { FIXED_SHORTCUTS, SHORTCUTS, comboFromEvent, comboProblem, formatCombo, isMac, shortcutFor, type ShortcutId } from '../../../lib/shortcuts'
import { ListField, Row, Section, Select, Slider, TextField, Toggle } from '../../fields'
import { LayoutPicker, withLayout } from '../../LayoutPicker'
import type { PageProps } from '../common'
import { promptStyles } from './model'

type T = ReturnType<typeof useT>['t']

export function ChatPage({ app, save }: PageProps) {
  const { t } = useT()
  const a = app.settings.appearance
  const mod = app.platform === 'darwin' ? '⌘Enter' : 'Ctrl+Enter'
  return (
    <Section>
      <Row label={t('settings.chat.enterSends')} hint={t('settings.chat.enterSendsHint', { keys: mod })}>
        <Toggle label={t('settings.chat.enterSends')} value={a.sendWithEnter} onChange={(v) => save((s) => ((s.appearance.sendWithEnter = v), s))} />
      </Row>
      <Row label={t('settings.chat.showReasoning')} hint={t('settings.chat.showReasoningHint')}>
        <Toggle label={t('settings.chat.showReasoning')} value={a.showReasoning} onChange={(v) => save((s) => ((s.appearance.showReasoning = v), s))} />
      </Row>
      <Row label={t('settings.chat.expandTools')} hint={t('settings.chat.expandToolsHint')}>
        <Toggle label={t('settings.chat.expandTools')} value={a.expandToolCalls} onChange={(v) => save((s) => ((s.appearance.expandToolCalls = v), s))} />
      </Row>
    </Section>
  )
}

/** Custom instructions and the system prompt (Agent tab). */
export function InstructionsPage({ app, save }: PageProps) {
  const { t } = useT()
  const g = app.settings.agent
  return (
    <Section>
      <Row label={t('settings.instructions.custom')} hint={t('settings.instructions.customHint')} wide>
        <TextField
          label={t('settings.instructions.custom')}
          multiline
          rows={5}
          value={g.customInstructions}
          placeholder={t('settings.instructions.customPlaceholder')}
          onChange={(v) => save((s) => ((s.agent.customInstructions = v), s))}
        />
      </Row>
      <Row label={t('settings.instructions.systemPrompt')} hint={t('settings.instructions.systemPromptHint')}>
        <Select
          label={t('settings.instructions.systemPrompt')}
          value={g.promptStyle}
          options={promptStyles(t) as { value: typeof g.promptStyle; label: string }[]}
          onChange={(v) => save((s) => ((s.agent.promptStyle = v), s))}
        />
      </Row>
      <Row label={t('settings.instructions.override')} hint={t('settings.instructions.overrideHint')} wide>
        <TextField
          label={t('settings.instructions.override')}
          multiline
          mono
          rows={6}
          value={g.systemPromptOverride}
          placeholder={t('settings.instructions.overridePlaceholder')}
          onChange={(v) => save((s) => ((s.agent.systemPromptOverride = v), s))}
        />
      </Row>
    </Section>
  )
}

export const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'oled', label: 'OLED black' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'contrast', label: 'High contrast' },
] as const

/** THEMES with labels in the current language. */
export const themes = (t: T) => THEMES.map((th) => ({ value: th.value, label: t(`settings.theme.${th.value}`) }))

export function AppearancePage({ app, save }: PageProps) {
  const a = app.settings.appearance
  const { t } = useT()
  // Each language is named in itself; "System" names the one it resolves to now.
  const systemLang = useSystemLang()
  const languages = [
    { value: 'system' as const, label: t('settings.general.languageSystem', { lang: LANGUAGE_NAMES[systemLang] }) },
    ...LANGS.map((l) => ({ value: l, label: LANGUAGE_NAMES[l] })),
  ]
  return (
    <>
      <Section title={t('settings.general.layout')}>
        <Row label={t('settings.general.layout')} hint={t('settings.general.layoutHint')} wide>
          <LayoutPicker value={a.layout} onChange={(v) => v !== a.layout && save((s) => withLayout(s, v))} />
        </Row>
      </Section>
      <Section title={t('settings.general.look')}>
        <Row label={t('settings.general.language')} search="Language" hint={t('settings.general.languageHint')}>
          <Select label={t('settings.general.language')} value={a.language} options={languages} onChange={(v) => save((s) => ((s.appearance.language = v), s))} />
        </Row>
        <Row label={t('settings.general.theme')}>
          <Select label={t('settings.general.theme')} value={a.theme} options={themes(t)} onChange={(v) => save((s) => ((s.appearance.theme = v), s))} />
        </Row>
        <Row label={t('settings.general.fontSize')}>
          <Slider label={t('settings.general.fontSize')} value={a.fontSize} min={11} max={20} step={1} format={(v) => `${v}px`} onChange={(v) => save((s) => ((s.appearance.fontSize = v), s))} />
        </Row>
        <Row label={t('settings.general.uiFont')} hint={t('settings.general.uiFontHint')} labelFor="ui-font">
          <TextField id="ui-font" value={a.fontFamily} placeholder={t('settings.general.uiFontPlaceholder')} onChange={(v) => save((s) => ((s.appearance.fontFamily = v.trim()), s))} />
        </Row>
        <Row label={t('settings.general.codeFont')} hint={t('settings.general.codeFontHint')} labelFor="code-font">
          <TextField id="code-font" mono value={a.codeFontFamily} onChange={(v) => save((s) => ((s.appearance.codeFontFamily = v), s))} />
        </Row>
        <Row label={t('settings.general.density')}>
          <Select
            label={t('settings.general.density')}
            value={a.density}
            options={[
              { value: 'comfortable', label: t('settings.general.densityComfortable') },
              { value: 'compact', label: t('settings.general.densityCompact') },
            ]}
            onChange={(v) => save((s) => ((s.appearance.density = v), s))}
          />
        </Row>
      </Section>
    </>
  )
}

export function WorkspacePage({ app, save, onState, onError }: PageProps) {
  const { t } = useT()
  const open = app.settings.app.openWorkspaces
  return (
    <>
      <Section title={t('settings.workspace.folders')}>
        <Row label={t('settings.workspace.openFolders')} hint={t('settings.workspace.openFoldersHint')} wide>
          <div className="list-field">
            {open.length === 0 && <p className="muted small">{t('settings.workspace.noFolder')}</p>}
            {open.map((w) => (
              <div key={w} className="list-item">
                <code title={w}>{w}</code>
                {w === app.workspace && <span className="badge ok">{t('settings.workspace.current')}</span>}
                <button className="link danger small" aria-label={t('settings.workspace.closeFolder', { path: w })} onClick={() => api.workspace.close(w).then(onState, onError)}>
                  {t('common.close')}
                </button>
              </div>
            ))}
          </div>
          <div>
            <button className="btn" onClick={() => api.workspace.pick().then(onState, onError)}>
              {t('settings.workspace.openFolder')}
            </button>
          </div>
        </Row>
      </Section>
      <Section title={t('settings.workspace.projectFiles')}>
        <Row label={t('settings.workspace.instructionFiles')} hint={t('settings.workspace.instructionFilesHint')} wide>
          <ListField label={t('settings.workspace.instructionFiles')} value={app.settings.agent.projectInstructionFiles} placeholder="AGENTS.md" onChange={(v) => save((s) => ((s.agent.projectInstructionFiles = v), s))} />
        </Row>
        <Row label={t('settings.workspace.loadProjectCode')} hint={t('settings.workspace.loadProjectCodeHint')}>
          <Toggle label={t('settings.workspace.loadProjectCode')} value={app.settings.tools.loadProjectExtensions} onChange={(v) => save((s) => ((s.tools.loadProjectExtensions = v), s))} />
        </Row>
      </Section>
    </>
  )
}

export function NotificationsPage({ app, save }: PageProps) {
  const { t } = useT()
  const a = app.settings.app
  const n = a.notify
  const set = (k: keyof typeof n) => (v: boolean) => save((s) => ((s.app.notify[k] = v), s))
  return (
    <>
      <Section>
        <Row label={t('settings.notify.notifyMe')} hint={t('settings.notify.notifyMeHint')}>
          <Toggle label={t('settings.notify.notifyMe')} value={a.notifications} onChange={(v) => save((s) => ((s.app.notifications = v), s))} />
        </Row>
      </Section>
      <Section title={t('settings.notify.whenChat')}>
        <Row label={t('settings.notify.finishes')} hint={t('settings.notify.finishesHint')}>
          <Toggle label={t('settings.notify.finishesToggle')} value={n.finished} onChange={set('finished')} />
        </Row>
        <Row label={t('settings.notify.stopsEarly')} hint={t('settings.notify.stopsEarlyHint')}>
          <Toggle label={t('settings.notify.stopsEarlyToggle')} value={n.failed} onChange={set('failed')} />
        </Row>
        <Row label={t('settings.notify.needsApproval')} hint={t('settings.notify.needsApprovalHint')}>
          <Toggle label={t('settings.notify.needsApprovalToggle')} value={n.approval} onChange={set('approval')} />
        </Row>
        <Row label={t('settings.notify.hasQuestion')} hint={t('settings.notify.hasQuestionHint')}>
          <Toggle label={t('settings.notify.hasQuestionToggle')} value={n.question} onChange={set('question')} />
        </Row>
      </Section>
    </>
  )
}

/** A rebindable shortcut's name in the catalogue (also its search row). */
export const shortcutLabel = (id: ShortcutId): MessageKey => `settings.shortcuts.${id}`
const shortcutHelp = (id: ShortcutId): MessageKey => `settings.shortcuts.${id}Help`

export function ShortcutsPage({ app, save }: PageProps) {
  const { t } = useT()
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
    if (why) {
      const keys = formatCombo(combo, mac)
      const text =
        why.kind === 'taken'
          ? t('settings.shortcuts.problemTaken', { keys, name: t(shortcutLabel(why.by)) })
          : t(why.kind === 'reserved' ? 'settings.shortcuts.problemReserved' : 'settings.shortcuts.problemNoModifier', { keys })
      return setProblem({ id, text })
    }
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
      <Section title={t('settings.shortcuts.changeable')} description={t('settings.shortcuts.changeableDesc')}>
        {SHORTCUTS.map((sc) => {
          const combo = shortcutFor(app.settings, sc.id)
          const changed = !!app.settings.shortcuts[sc.id]
          const live = recording === sc.id
          const name = t(shortcutLabel(sc.id))
          return (
            <Row key={sc.id} label={name} hint={problem?.id === sc.id ? <span className="warn">{problem.text}</span> : t(shortcutHelp(sc.id))}>
              <div className="inline">
                <button
                  className={`btn kbd-btn ${live ? 'recording' : ''}`}
                  aria-label={live ? t('settings.shortcuts.pressFor', { name }) : t('settings.shortcuts.change', { name, keys: formatCombo(combo, mac) })}
                  onClick={() => (setRecording(live ? null : sc.id), setProblem(null))}
                  onKeyDown={live ? record(sc.id) : undefined}
                  onBlur={() => live && setRecording(null)}
                >
                  {live ? t('settings.shortcuts.pressKeys') : <kbd>{formatCombo(combo, mac)}</kbd>}
                </button>
                {changed && (
                  <button className="link small" onClick={() => save((s) => (delete s.shortcuts[sc.id], s))}>
                    {t('common.default')}
                  </button>
                )}
              </div>
            </Row>
          )
        })}
      </Section>
      <Section title={t('settings.shortcuts.fixed')}>
        {FIXED_SHORTCUTS.map((f) => (
          <Row key={f.combo} label={t(f.label)}>
            <kbd>{formatCombo(f.combo, mac)}</kbd>
          </Row>
        ))}
      </Section>
    </>
  )
}
