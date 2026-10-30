import { api } from '../../../lib/api'
import { Row, Section, Select, TextField, Toggle } from '../../fields'
import { EXPERIENCE_LABELS, PROFILE_EXPERIENCE, PROFILE_ROLES, PROFILE_USES, ROLE_LABELS, ShareInfoText, USE_LABELS, languageOptions } from '../../profile'
import type { PageProps } from '../common'

type Role = (typeof PROFILE_ROLES)[number]
type Experience = (typeof PROFILE_EXPERIENCE)[number]

export function ProfilePage({ app, save }: PageProps) {
  const p = app.settings.profile
  return (
    <>
      <Section description="The agent uses these to address you and to pitch its explanations. They go to your model as part of its instructions, nowhere else.">
        <Row label="Name" hint="What the agent calls you, now and then." labelFor="profile-name">
          <TextField id="profile-name" value={p.name} placeholder="Your name" onChange={(v) => save((s) => ((s.profile.name = v.trim().slice(0, 80)), s))} />
        </Row>
        <Row label="Role">
          <Select<Role | ''>
            label="Role"
            value={p.role ?? ''}
            options={[{ value: '', label: 'Not set' }, ...PROFILE_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))]}
            onChange={(v) => save((s) => ((s.profile.role = v || null), s))}
          />
        </Row>
        <Row label="Experience" hint="New to coding gets plainer explanations; Experienced gets terse, technical ones.">
          <Select<Experience | ''>
            label="Experience"
            value={p.experience ?? ''}
            options={[{ value: '', label: 'Not set' }, ...PROFILE_EXPERIENCE.map((r) => ({ value: r, label: EXPERIENCE_LABELS[r] }))]}
            onChange={(v) => save((s) => ((s.profile.experience = v || null), s))}
          />
        </Row>
        <Row label="Main uses" wide>
          <div className="choice-chips">
            {PROFILE_USES.map((u) => {
              const on = p.uses.includes(u)
              return (
                <label key={u} className={`choice-chip ${on ? 'on' : ''}`}>
                  <input type="checkbox" checked={on} onChange={() => save((s) => ((s.profile.uses = on ? s.profile.uses.filter((x) => x !== u) : PROFILE_USES.filter((x) => x === u || s.profile.uses.includes(x))), s))} />
                  {USE_LABELS[u]}
                </label>
              )
            })}
          </div>
        </Row>
        <Row label="Reply language" hint="The language the agent answers in, whatever the code is written in. The app itself stays in English.">
          <Select label="Reply language" value={p.language} options={languageOptions(p.language)} onChange={(v) => save((s) => ((s.profile.language = v), s))} />
        </Row>
      </Section>
    </>
  )
}

const SERVER_CODE = 'https://github.com/Parzival-Samanyolu/xari-bulbul/tree/main/server/telemetry'

export function PrivacyPage({ app, save }: PageProps) {
  return (
    <Section>
      <Row label="Share anonymous usage info" hint="Helps fix crashes and decide what to build next. Sent every few minutes to this project's own server, and to no one else." wide>
        <Toggle label="Share anonymous usage info" value={app.settings.privacy.shareUsage} onChange={(v) => save((s) => ((s.privacy.shareUsage = v), s))} />
        <ShareInfoText />
        {app.shareInfoOff && <p className="muted small">Sending is turned off for this session by the XB_TELEMETRY or XB_TELEMETRY_URL environment variable.</p>}
        <p className="muted small">
          Turning it off also deletes anything waiting to be sent.{' '}
          <button className="link small" onClick={() => api.app.openExternal(SERVER_CODE)}>
            See the server code ↗
          </button>
        </p>
      </Row>
    </Section>
  )
}
