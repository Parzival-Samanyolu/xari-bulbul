import { api } from '../../../lib/api'
import { NumberField, Row, Section, Select, TextField, Toggle } from '../../fields'
import type { Save, PageProps } from '../common'

/** A built-in tool switched through `tools.disabled`. */
export function toolToggle(app: PageProps['app'], save: Save, name: string, label: string) {
  const on = !app.settings.tools.disabled.includes(name)
  return <Toggle label={label} value={on} onChange={(v) => save((s) => ((s.tools.disabled = v ? s.tools.disabled.filter((x) => x !== name) : [...s.tools.disabled, name]), s))} />
}

export function DesktopPage({ app, save }: PageProps) {
  const a = app.settings.app
  const loginItems = app.platform === 'darwin' || app.platform === 'win32'
  return (
    <Section>
      <Row label="Launch at login" hint={loginItems ? 'Opens the app when you log in to this computer.' : 'Not available on Linux; add the app to your desktop’s startup programs instead.'}>
        <Toggle label="Launch at login" value={loginItems && a.launchAtLogin} disabled={!loginItems} onChange={(v) => save((s) => ((s.app.launchAtLogin = v), s))} />
      </Row>
      <Row label="Reopen the last chat" hint="On launch, show the last folder's most recent chat. Off starts a new chat in that folder.">
        <Toggle label="Reopen the last chat" value={a.resumeLastChat} onChange={(v) => save((s) => ((s.app.resumeLastChat = v), s))} />
      </Row>
      <Row label="Keep the computer awake" hint="Stops the computer from sleeping, so long tasks and schedules aren't paused. The screen can still turn off.">
        <Select
          label="Keep the computer awake"
          value={a.keepAwake}
          options={[
            { value: 'off', label: 'Never' },
            { value: 'working', label: 'While a chat is working' },
            { value: 'always', label: 'While the app is open' },
          ]}
          onChange={(v) => save((s) => ((s.app.keepAwake = v), s))}
        />
      </Row>
      <Row label="Data folder" hint={app.paths.data}>
        <button className="btn" onClick={() => api.app.openPath(app.paths.data)}>
          Open
        </button>
      </Row>
    </Section>
  )
}

export function LimitsPage({ app, save }: PageProps) {
  const a = app.settings.agent
  return (
    <Section>
      <Row label="Max steps per message" hint="Model requests per message before the agent pauses and asks to continue. A safety net against loops.">
        <NumberField label="Max steps per message" value={a.maxStepsPerTurn} min={1} max={1000} onChange={(v) => save((s) => ((s.agent.maxStepsPerTurn = v ?? 200), s))} />
      </Row>
      <Row label="Request retries" hint="Retries after rate limits (429) and server errors.">
        <NumberField label="Request retries" value={a.requestRetries} min={0} max={10} onChange={(v) => save((s) => ((s.agent.requestRetries = v ?? 3), s))} />
      </Row>
      <Row label="Stall timeout" hint="Stop waiting when a hosted provider sends nothing for this long. 0 waits forever.">
        <NumberField label="Stall timeout" value={a.stallTimeoutSec} min={0} max={3600} suffix="seconds" onChange={(v) => save((s) => ((s.agent.stallTimeoutSec = v ?? 90), s))} />
      </Row>
      <Row label="Batch while planning" hint="Plan mode sends requests through the Anthropic or OpenAI batch API: about half price, but each step can take minutes.">
        <Toggle label="Batch while planning" value={a.batchInPlanMode} onChange={(v) => save((s) => ((s.agent.batchInPlanMode = v), s))} />
      </Row>
    </Section>
  )
}

export function ToolAccessPage({ app, save, go }: PageProps) {
  const t = app.settings.tools
  return (
    <Section>
      <Row label="Check files after edits" hint="Runs the project's eslint or ruff, or a syntax check, on each edited file and shows the agent any problems.">
        <Toggle label="Check files after edits" value={t.checkAfterEdit} onChange={(v) => save((s) => ((s.tools.checkAfterEdit = v), s))} />
      </Row>
      <Row label="Check time limit" hint="A slower check is stopped, and the agent is told to run it itself.">
        <NumberField label="Check time limit" value={t.checkTimeoutSec} min={5} max={300} suffix="seconds" onChange={(v) => save((s) => ((s.tools.checkTimeoutSec = v ?? 30), s))} />
      </Row>
      <Row label="Let the agent ask you questions" hint="The ask_user tool: the agent stops and asks when a choice is yours to make.">
        {toolToggle(app, save, 'ask_user', 'Let the agent ask you questions')}
      </Row>
      <Row label="Every tool" hint="Turn single tools on or off.">
        <button className="link small" onClick={() => go('tools.list')}>
          Open Tools
        </button>
      </Row>
    </Section>
  )
}

export function TerminalPage({ app, save }: PageProps) {
  const a = app.settings.agent
  return (
    <Section>
      <Row label="Shell" hint={app.platform === 'win32' ? 'Empty: Git Bash if installed, else PowerShell. Or enter pwsh, powershell or a path.' : 'Empty: /bin/bash. Or enter a path such as /bin/zsh.'} labelFor="shell">
        <TextField id="shell" mono value={a.shell} placeholder="Default" onChange={(v) => save((s) => ((s.agent.shell = v), s))} />
      </Row>
      <Row label="Command timeout" hint="A command running longer is stopped. Background jobs don't have this limit.">
        <NumberField label="Command timeout" value={a.bashTimeoutSec} min={1} max={3600} suffix="seconds" onChange={(v) => save((s) => ((s.agent.bashTimeoutSec = v ?? 120), s))} />
      </Row>
    </Section>
  )
}

export function OutputPage({ app, save }: PageProps) {
  const a = app.settings.agent
  return (
    <Section>
      <Row label="Max tool output" hint="Longer tool results are shortened before the model sees them; the start and end are kept.">
        <NumberField label="Max tool output" value={a.toolOutputMaxChars} min={1000} step={1000} suffix="chars" onChange={(v) => save((s) => ((s.agent.toolOutputMaxChars = v ?? 30000), s))} />
      </Row>
    </Section>
  )
}
