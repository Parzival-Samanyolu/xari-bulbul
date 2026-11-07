import { PROFILE_EXPERIENCE, PROFILE_ROLES, PROFILE_USES } from '@harness/core/profile'
import { useT } from '../lib/i18n'

// Profile choices and the share-info wording, used by first-run setup and Settings.

export { PROFILE_EXPERIENCE, PROFILE_ROLES, PROFILE_USES }

type T = ReturnType<typeof useT>['t']

export const roleLabels = (t: T): Record<(typeof PROFILE_ROLES)[number], string> => ({
  developer: t('bots.profile.role.developer'),
  designer: t('bots.profile.role.designer'),
  student: t('bots.profile.role.student'),
  researcher: t('bots.profile.role.researcher'),
  other: t('bots.profile.role.other'),
})
export const experienceLabels = (t: T): Record<(typeof PROFILE_EXPERIENCE)[number], string> => ({
  new: t('bots.profile.experience.new'),
  some: t('bots.profile.experience.some'),
  experienced: t('bots.profile.experience.experienced'),
})
export const purposeLabels = (t: T): Record<(typeof PROFILE_USES)[number], string> => ({
  coding: t('bots.profile.use.coding'),
  writing: t('bots.profile.use.writing'),
  research: t('bots.profile.use.research'),
  automation: t('bots.profile.use.automation'),
  learning: t('bots.profile.use.learning'),
})

/** Reply languages offered in a list; the value is what the prompt says ("Reply in Turkish"), the code names it in the UI language. */
const LANGUAGE_CODES: [name: string, code: string][] = [
  ['English', 'en'], ['Azerbaijani', 'az'], ['Turkish', 'tr'], ['Russian', 'ru'], ['German', 'de'], ['French', 'fr'], ['Spanish', 'es'], ['Portuguese', 'pt'],
  ['Italian', 'it'], ['Dutch', 'nl'], ['Polish', 'pl'], ['Ukrainian', 'uk'], ['Arabic', 'ar'], ['Persian', 'fa'], ['Hindi', 'hi'], ['Chinese', 'zh'],
  ['Japanese', 'ja'], ['Korean', 'ko'], ['Indonesian', 'id'], ['Vietnamese', 'vi'],
]
export const LANGUAGES = LANGUAGE_CODES.map(([name]) => name)

/** A reply language's name in the UI language ("Turkish" → "Türkçe" in Turkish), capitalised for a list. */
function languageName(name: string, code: string, lang: string): string {
  if (lang === 'en') return name
  try {
    const shown = new Intl.DisplayNames([lang], { type: 'language' }).of(code)
    return shown && shown !== code ? shown.charAt(0).toLocaleUpperCase(lang) + shown.slice(1) : name
  } catch {
    return name
  }
}

/** Options for the reply-language select, labelled in the UI language; values stay English, since the prompt uses them. */
export const languageOptions = (current: string, t: T, lang: string) => [
  { value: '', label: t('bots.profile.sameLanguage') },
  ...LANGUAGE_CODES.map(([name, code]) => ({ value: name, label: languageName(name, code, lang) })),
  ...(current && !LANGUAGES.includes(current) ? [{ value: current, label: current }] : []),
]

/** What share info sends and never sends. Also on Settings › About › Privacy. */
export function ShareInfoText() {
  const { t } = useT()
  return (
    <div className="share-info-text small">
      <p>
        <b>{t('bots.profile.sentLabel')}</b> {t('bots.profile.sent')}
      </p>
      <p>
        <b>{t('bots.profile.neverSentLabel')}</b> {t('bots.profile.neverSent')}
      </p>
    </div>
  )
}
