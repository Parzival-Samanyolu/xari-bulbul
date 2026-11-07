import { useT } from '../../../lib/i18n'
import { modes } from '../../Composer'
import { ListField, NumberField, Row, Section, TextField, Toggle } from '../../fields'
import type { PageProps } from '../common'
import { rich } from '../../../lib/rich'

type HookKind = 'preTool' | 'postTool'

export function SafetyPage({ app, save }: PageProps) {
  const { t } = useT()
  const p = app.settings.permissions
  return (
    <>
      <Section title={t('settings.safety.permissionMode')}>
        <Row label={t('settings.safety.defaultMode')} search="Default mode" hint={t('settings.safety.defaultModeHint', { hint: modes(t).find((m) => m.id === p.mode)?.hint ?? '' })}>
          <div className="modes large" role="radiogroup" aria-label={t('settings.safety.defaultModeLabel')}>
            {modes(t).map((m) => (
              <button key={m.id} role="radio" aria-checked={p.mode === m.id} className={`mode mode-${m.id} ${p.mode === m.id ? 'on' : ''}`} onClick={() => save((s) => ((s.permissions.mode = m.id), s))}>
                {m.label}
              </button>
            ))}
          </div>
        </Row>
      </Section>
      <Section title={t('settings.safety.guards')}>
        <Row label={t('settings.safety.confirmDestructive')} search="Confirm destructive commands" hint={t('settings.safety.confirmDestructiveHint')}>
          <Toggle label={t('settings.safety.confirmDestructive')} value={p.confirmDestructive} onChange={(v) => save((s) => ((s.permissions.confirmDestructive = v), s))} />
        </Row>
        <Row label={t('settings.safety.allowOutside')} search="Allow edits outside the project folder" hint={t('settings.safety.allowOutsideHint')}>
          <Toggle label={t('settings.safety.allowOutside')} value={p.allowOutsideWorkspace} onChange={(v) => save((s) => ((s.permissions.allowOutsideWorkspace = v), s))} />
        </Row>
      </Section>
      <Section
        title={t('settings.safety.rules')}
        description={rich(t('settings.safety.rulesFormat'), {
          tool: <code>tool</code>,
          toolPattern: <code>tool(pattern)</code>,
          star: <code>*</code>,
          bashExample: <code>bash(npm test*)</code>,
          doubleStar: <code>**</code>,
          editExample: <code>edit_file(src/**)</code>,
        })}
      >
        <Row label={t('settings.safety.alwaysAllow')} search="Always allow" wide>
          <ListField label={t('settings.safety.alwaysAllow')} value={p.allow} placeholder="bash(npm test*)" onChange={(v) => save((s) => ((s.permissions.allow = v), s))} />
        </Row>
        <Row label={t('settings.safety.alwaysDeny')} search="Always deny" wide>
          <ListField label={t('settings.safety.alwaysDeny')} value={p.deny} placeholder="bash(git push*)" onChange={(v) => save((s) => ((s.permissions.deny = v), s))} />
        </Row>
      </Section>
    </>
  )
}

/** Shell commands around tool calls (the Hooks tab). */
export function HooksPage({ app, save }: PageProps) {
  const { t } = useT()
  const h = app.settings.hooks
  const hooks = (kind: HookKind, label: string, search: string, hint: string) => (
    <Row label={label} search={search} hint={hint} wide>
      {h[kind].length === 0 && <p className="muted small">{t('settings.safety.noHooks')}</p>}
      {h[kind].map((rule, i) => (
        <div key={i} className="override hook-card">
          <div className="provider-head">
            <Toggle label={t('settings.safety.hookOn', { n: i + 1 })} value={rule.enabled} onChange={(v) => save((s) => ((s.hooks[kind][i].enabled = v), s))} />
            <span className="muted small">{rule.enabled ? t('common.on') : t('common.off')}</span>
            <div className="spacer" />
            <button className="link danger small" onClick={() => save((s) => (s.hooks[kind].splice(i, 1), s))}>
              {t('common.remove')}
            </button>
          </div>
          <div className="hook-grid">
            <label>
              {t('settings.safety.match')}
              <TextField label={t('settings.safety.match')} mono value={rule.match} placeholder="bash(git commit*)" onChange={(v) => save((s) => ((s.hooks[kind][i].match = v), s))} />
            </label>
            <label>
              {t('settings.safety.command')}
              <TextField label={t('settings.safety.command')} mono value={rule.command} placeholder="./scripts/check.sh" onChange={(v) => save((s) => ((s.hooks[kind][i].command = v), s))} />
            </label>
            <label>
              {t('settings.safety.timeLimit')}
              <NumberField label={t('settings.safety.timeLimit')} value={rule.timeoutSec} min={1} max={600} suffix={t('settings.parts.secondsShort')} onChange={(v) => save((s) => ((s.hooks[kind][i].timeoutSec = v ?? 30), s))} />
            </label>
          </div>
        </div>
      ))}
      <div>
        <button className="btn" onClick={() => save((s) => (s.hooks[kind].push({ match: '*', command: '', timeoutSec: 30, enabled: true }), s))}>
          {t('settings.safety.addHook')}
        </button>
      </div>
    </Row>
  )
  return (
    <Section
      description={rich(t('settings.safety.hooksIntro'), {
        match: <b>{t('settings.safety.match')}</b>,
        tool: <code>tool</code>,
        toolPattern: <code>tool(pattern)</code>,
        star: <code>*</code>,
        toolVar: <code>HARNESS_TOOL</code>,
        subjectVar: <code>HARNESS_SUBJECT</code>,
        cwdVar: <code>HARNESS_CWD</code>,
      })}
    >
      {hooks('preTool', t('settings.safety.beforeTool'), 'Before a tool runs', t('settings.safety.beforeToolHint'))}
      {hooks('postTool', t('settings.safety.afterTool'), 'After a tool runs', t('settings.safety.afterToolHint'))}
    </Section>
  )
}
