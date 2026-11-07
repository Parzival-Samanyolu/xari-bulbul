import { api } from '../../../lib/api'
import { useT } from '../../../lib/i18n'
import { NumberField, Row, Section, Select, TextField, Toggle } from '../../fields'
import type { Save, PageProps } from '../common'

/** A built-in tool switched through `tools.disabled`. */
export function toolToggle(app: PageProps['app'], save: Save, name: string, label: string) {
  const on = !app.settings.tools.disabled.includes(name)
  return <Toggle label={label} value={on} onChange={(v) => save((s) => ((s.tools.disabled = v ? s.tools.disabled.filter((x) => x !== name) : [...s.tools.disabled, name]), s))} />
}

export function DesktopPage({ app, save }: PageProps) {
  const { t } = useT()
  const a = app.settings.app
  const loginItems = app.platform === 'darwin' || app.platform === 'win32'
  return (
    <Section>
      <Row label={t('settings.advanced.launchAtLogin')} search="Launch at login" hint={loginItems ? t('settings.advanced.launchAtLoginHint') : t('settings.advanced.launchAtLoginLinux')}>
        <Toggle label={t('settings.advanced.launchAtLogin')} value={loginItems && a.launchAtLogin} disabled={!loginItems} onChange={(v) => save((s) => ((s.app.launchAtLogin = v), s))} />
      </Row>
      <Row label={t('settings.advanced.reopenLastChat')} search="Reopen the last chat" hint={t('settings.advanced.reopenLastChatHint')}>
        <Toggle label={t('settings.advanced.reopenLastChat')} value={a.resumeLastChat} onChange={(v) => save((s) => ((s.app.resumeLastChat = v), s))} />
      </Row>
      <Row label={t('settings.advanced.keepAwake')} search="Keep the computer awake" hint={t('settings.advanced.keepAwakeHint')}>
        <Select
          label={t('settings.advanced.keepAwake')}
          value={a.keepAwake}
          options={[
            { value: 'off', label: t('settings.advanced.keepAwakeNever') },
            { value: 'working', label: t('settings.advanced.keepAwakeWorking') },
            { value: 'always', label: t('settings.advanced.keepAwakeAlways') },
          ]}
          onChange={(v) => save((s) => ((s.app.keepAwake = v), s))}
        />
      </Row>
      <Row label={t('settings.advanced.dataFolder')} search="Data folder" hint={app.paths.data}>
        <button className="btn" onClick={() => api.app.openPath(app.paths.data)}>
          {t('common.open')}
        </button>
      </Row>
    </Section>
  )
}

export function LimitsPage({ app, save }: PageProps) {
  const { t } = useT()
  const a = app.settings.agent
  return (
    <Section>
      <Row label={t('settings.advanced.maxSteps')} search="Max steps per message" hint={t('settings.advanced.maxStepsHint')}>
        <NumberField label={t('settings.advanced.maxSteps')} value={a.maxStepsPerTurn} min={1} max={500} onChange={(v) => save((s) => ((s.agent.maxStepsPerTurn = v ?? 200), s))} />
      </Row>
      <Row label={t('settings.advanced.retries')} search="Request retries" hint={t('settings.advanced.retriesHint')}>
        <NumberField label={t('settings.advanced.retries')} value={a.requestRetries} min={0} max={10} onChange={(v) => save((s) => ((s.agent.requestRetries = v ?? 3), s))} />
      </Row>
      <Row label={t('settings.advanced.stallTimeout')} search="Stall timeout" hint={t('settings.advanced.stallTimeoutHint')}>
        <NumberField label={t('settings.advanced.stallTimeout')} value={a.stallTimeoutSec} min={0} max={3600} suffix={t('settings.parts.seconds')} onChange={(v) => save((s) => ((s.agent.stallTimeoutSec = v ?? 90), s))} />
      </Row>
      <Row label={t('settings.advanced.batchPlanning')} search="Batch while planning" hint={t('settings.advanced.batchPlanningHint')}>
        <Toggle label={t('settings.advanced.batchPlanning')} value={a.batchInPlanMode} onChange={(v) => save((s) => ((s.agent.batchInPlanMode = v), s))} />
      </Row>
    </Section>
  )
}

export function ToolAccessPage({ app, save, go }: PageProps) {
  const { t } = useT()
  const tools = app.settings.tools
  return (
    <Section>
      <Row label={t('settings.advanced.checkAfterEdit')} search="Check files after edits" hint={t('settings.advanced.checkAfterEditHint')}>
        <Toggle label={t('settings.advanced.checkAfterEdit')} value={tools.checkAfterEdit} onChange={(v) => save((s) => ((s.tools.checkAfterEdit = v), s))} />
      </Row>
      <Row label={t('settings.advanced.checkTimeLimit')} search="Check time limit" hint={t('settings.advanced.checkTimeLimitHint')}>
        <NumberField label={t('settings.advanced.checkTimeLimit')} value={tools.checkTimeoutSec} min={5} max={300} suffix={t('settings.parts.seconds')} onChange={(v) => save((s) => ((s.tools.checkTimeoutSec = v ?? 30), s))} />
      </Row>
      <Row label={t('settings.advanced.askUser')} search="Let the agent ask you questions" hint={t('settings.advanced.askUserHint')}>
        {toolToggle(app, save, 'ask_user', t('settings.advanced.askUser'))}
      </Row>
      <Row label={t('settings.advanced.everyTool')} search="Every tool" hint={t('settings.advanced.everyToolHint')}>
        <button className="link small" onClick={() => go('tools.list')}>
          {t('settings.advanced.openTools')}
        </button>
      </Row>
    </Section>
  )
}

export function TerminalPage({ app, save }: PageProps) {
  const { t } = useT()
  const a = app.settings.agent
  return (
    <Section>
      <Row label={t('settings.advanced.shell')} search="Shell" hint={app.platform === 'win32' ? t('settings.advanced.shellHintWindows') : t('settings.advanced.shellHint')} labelFor="shell">
        <TextField id="shell" mono value={a.shell} placeholder={t('common.default')} onChange={(v) => save((s) => ((s.agent.shell = v), s))} />
      </Row>
      <Row label={t('settings.advanced.commandTimeout')} search="Command timeout" hint={t('settings.advanced.commandTimeoutHint')}>
        <NumberField label={t('settings.advanced.commandTimeout')} value={a.bashTimeoutSec} min={1} max={3600} suffix={t('settings.parts.seconds')} onChange={(v) => save((s) => ((s.agent.bashTimeoutSec = v ?? 120), s))} />
      </Row>
    </Section>
  )
}

export function OutputPage({ app, save }: PageProps) {
  const { t } = useT()
  const a = app.settings.agent
  return (
    <Section>
      <Row label={t('settings.advanced.maxToolOutput')} search="Max tool output" hint={t('settings.advanced.maxToolOutputHint')}>
        <NumberField label={t('settings.advanced.maxToolOutput')} value={a.toolOutputMaxChars} min={1000} step={1000} suffix={t('settings.parts.chars')} onChange={(v) => save((s) => ((s.agent.toolOutputMaxChars = v ?? 30000), s))} />
      </Row>
    </Section>
  )
}
