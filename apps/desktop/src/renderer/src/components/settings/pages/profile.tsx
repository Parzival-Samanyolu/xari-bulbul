import { api } from '../../../lib/api'
import { useT } from '../../../lib/i18n'
import { Row, Section, Select, TextField, Toggle } from '../../fields'
import { PROFILE_EXPERIENCE, PROFILE_ROLES, PROFILE_USES, ShareInfoText, experienceLabels, languageOptions, purposeLabels, roleLabels } from '../../profile'
import type { PageProps } from '../common'

type Role = (typeof PROFILE_ROLES)[number]
type Experience = (typeof PROFILE_EXPERIENCE)[number]

export function ProfilePage({ app, save }: PageProps) {
  const { t, lang } = useT()
  const p = app.settings.profile
  const roles = roleLabels(t)
  const levels = experienceLabels(t)
  const purposes = purposeLabels(t)
  return (
    <>
      <Section description={t('settings.profile.intro')}>
        <Row label={t('settings.profile.name')} hint={t('settings.profile.nameHint')} labelFor="profile-name">
          <TextField id="profile-name" value={p.name} placeholder={t('settings.profile.namePlaceholder')} onChange={(v) => save((s) => ((s.profile.name = v.trim().slice(0, 80)), s))} />
        </Row>
        <Row label={t('settings.profile.role')}>
          <Select<Role | ''>
            label={t('settings.profile.role')}
            value={p.role ?? ''}
            options={[{ value: '', label: t('settings.profile.notSet') }, ...PROFILE_ROLES.map((r) => ({ value: r, label: roles[r] }))]}
            onChange={(v) => save((s) => ((s.profile.role = v || null), s))}
          />
        </Row>
        <Row label={t('settings.profile.experience')} hint={t('settings.profile.experienceHint')}>
          <Select<Experience | ''>
            label={t('settings.profile.experience')}
            value={p.experience ?? ''}
            options={[{ value: '', label: t('settings.profile.notSet') }, ...PROFILE_EXPERIENCE.map((r) => ({ value: r, label: levels[r] }))]}
            onChange={(v) => save((s) => ((s.profile.experience = v || null), s))}
          />
        </Row>
        <Row label={t('settings.profile.uses')} wide>
          <div className="choice-chips">
            {PROFILE_USES.map((u) => {
              const on = p.uses.includes(u)
              return (
                <label key={u} className={`choice-chip ${on ? 'on' : ''}`}>
                  <input type="checkbox" checked={on} onChange={() => save((s) => ((s.profile.uses = on ? s.profile.uses.filter((x) => x !== u) : PROFILE_USES.filter((x) => x === u || s.profile.uses.includes(x))), s))} />
                  {purposes[u]}
                </label>
              )
            })}
          </div>
        </Row>
        <Row label={t('settings.profile.replyLanguage')} hint={t('settings.profile.replyLanguageHint')}>
          <Select label={t('settings.profile.replyLanguage')} value={p.language} options={languageOptions(p.language, t, lang)} onChange={(v) => save((s) => ((s.profile.language = v), s))} />
        </Row>
      </Section>
    </>
  )
}

const SERVER_CODE = 'https://github.com/Parzival-Samanyolu/xari-bulbul/tree/main/server/telemetry'

export function PrivacyPage({ app, save }: PageProps) {
  const { t } = useT()
  return (
    <Section>
      <Row label={t('settings.privacy.share')} hint={t('settings.privacy.shareHint')} wide>
        <Toggle label={t('settings.privacy.share')} value={app.settings.privacy.shareUsage} onChange={(v) => save((s) => ((s.privacy.shareUsage = v), s))} />
        <ShareInfoText />
        {app.shareInfoOff && <p className="muted small">{t('settings.privacy.envOff')}</p>}
        <p className="muted small">
          {t('settings.privacy.offDeletes')}{' '}
          <button className="link small" onClick={() => api.app.openExternal(SERVER_CODE)}>
            {t('settings.privacy.serverCode')}
          </button>
        </p>
      </Row>
    </Section>
  )
}
