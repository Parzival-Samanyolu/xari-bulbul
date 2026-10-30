import { MODES } from '../../Composer'
import { ListField, NumberField, Row, Section, TextField, Toggle } from '../../fields'
import type { PageProps } from '../common'

type HookKind = 'preTool' | 'postTool'

export function SafetyPage({ app, save }: PageProps) {
  const p = app.settings.permissions
  const h = app.settings.hooks
  const hooks = (kind: HookKind, label: string, hint: string) => (
    <Row label={label} hint={hint} wide>
      {h[kind].length === 0 && <p className="muted small">None.</p>}
      {h[kind].map((rule, i) => (
        <div key={i} className="override">
          <div className="provider-head">
            <Toggle label={`Hook ${i + 1} on`} value={rule.enabled} onChange={(v) => save((s) => ((s.hooks[kind][i].enabled = v), s))} />
            <span className="muted small">{rule.enabled ? 'On' : 'Off'}</span>
            <div className="spacer" />
            <button className="link danger small" onClick={() => save((s) => (s.hooks[kind].splice(i, 1), s))}>
              Remove
            </button>
          </div>
          <div className="hook-grid">
            <label>
              Match
              <TextField label="Match" mono value={rule.match} placeholder="bash(git commit*)" onChange={(v) => save((s) => ((s.hooks[kind][i].match = v), s))} />
            </label>
            <label>
              Command
              <TextField label="Command" mono value={rule.command} placeholder="./scripts/check.sh" onChange={(v) => save((s) => ((s.hooks[kind][i].command = v), s))} />
            </label>
            <label>
              Time limit
              <NumberField label="Time limit" value={rule.timeoutSec} min={1} max={600} suffix="s" onChange={(v) => save((s) => ((s.hooks[kind][i].timeoutSec = v ?? 30), s))} />
            </label>
          </div>
        </div>
      ))}
      <div>
        <button className="btn" onClick={() => save((s) => (s.hooks[kind].push({ match: '*', command: '', timeoutSec: 30, enabled: true }), s))}>
          Add hook
        </button>
      </div>
    </Row>
  )
  return (
    <>
      <Section title="Permission mode">
        <Row label="Default mode" hint={`${MODES.find((m) => m.id === p.mode)?.hint ?? ''}. New windows start in it; switch any time in the message box or with Shift+Tab.`}>
          <div className="modes large" role="radiogroup" aria-label="Default permission mode">
            {MODES.map((m) => (
              <button key={m.id} role="radio" aria-checked={p.mode === m.id} className={`mode mode-${m.id} ${p.mode === m.id ? 'on' : ''}`} onClick={() => save((s) => ((s.permissions.mode = m.id), s))}>
                {m.label}
              </button>
            ))}
          </div>
        </Row>
      </Section>
      <Section title="Guards">
        <Row label="Confirm destructive commands" hint="Asks before rm, git reset --hard, force pushes and similar, even in Full auto. Allow rules below still apply.">
          <Toggle label="Confirm destructive commands" value={p.confirmDestructive} onChange={(v) => save((s) => ((s.permissions.confirmDestructive = v), s))} />
        </Row>
        <Row label="Allow edits outside the project folder" hint="Off: writing outside the open folder always asks, even in Full auto.">
          <Toggle label="Allow edits outside the project folder" value={p.allowOutsideWorkspace} onChange={(v) => save((s) => ((s.permissions.allowOutsideWorkspace = v), s))} />
        </Row>
      </Section>
      <Section
        title="Rules"
        description={
          <>
            Format: <code>tool</code> or <code>tool(pattern)</code>. For commands <code>*</code> matches anything (<code>bash(npm test*)</code>); for paths <code>*</code> is one folder level and <code>**</code> any depth (<code>edit_file(src/**)</code>). Deny rules win over everything, including Full auto.
          </>
        }
      >
        <Row label="Always allow" wide>
          <ListField label="Always allow" value={p.allow} placeholder="bash(npm test*)" onChange={(v) => save((s) => ((s.permissions.allow = v), s))} />
        </Row>
        <Row label="Always deny" wide>
          <ListField label="Always deny" value={p.deny} placeholder="bash(git push*)" onChange={(v) => save((s) => ((s.permissions.deny = v), s))} />
        </Row>
      </Section>
      <Section
        title="Hooks"
        description={
          <>
            Shell commands that run around the agent's tool calls, in the project folder, with your permissions and without asking. <b>Match</b> uses the rule format above, or <code>*</code> for every call. The command gets the call as JSON on stdin and <code>HARNESS_TOOL</code>, <code>HARNESS_SUBJECT</code> and <code>HARNESS_CWD</code> in its environment.
          </>
        }
      >
        {hooks('preTool', 'Before a tool runs', 'Exit code 2 blocks the call; what the command printed to stderr is the reason the agent sees.')}
        {hooks('postTool', 'After a tool runs', "What the command prints is added to the tool's result. Exit code 2 adds its stderr as feedback.")}
      </Section>
    </>
  )
}
