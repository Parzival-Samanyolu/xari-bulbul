import { PROFILE_EXPERIENCE, PROFILE_ROLES, PROFILE_USES } from '@harness/core/profile'

// Profile choices and the share-info wording, used by first-run setup and Settings.

export { PROFILE_EXPERIENCE, PROFILE_ROLES, PROFILE_USES }

export const ROLE_LABELS: Record<(typeof PROFILE_ROLES)[number], string> = { developer: 'Developer', designer: 'Designer', student: 'Student', researcher: 'Researcher', other: 'Other' }
export const EXPERIENCE_LABELS: Record<(typeof PROFILE_EXPERIENCE)[number], string> = { new: 'New to coding', some: 'Some experience', experienced: 'Experienced' }
export const USE_LABELS: Record<(typeof PROFILE_USES)[number], string> = { coding: 'Coding', writing: 'Writing', research: 'Research', automation: 'Automation', learning: 'Learning' }

/** Reply languages offered in a list; the value is what the prompt says ("Reply in Turkish"). */
export const LANGUAGES = [
  'English', 'Azerbaijani', 'Turkish', 'Russian', 'German', 'French', 'Spanish', 'Portuguese', 'Italian', 'Dutch', 'Polish', 'Ukrainian',
  'Arabic', 'Persian', 'Hindi', 'Chinese', 'Japanese', 'Korean', 'Indonesian', 'Vietnamese',
]

export const languageOptions = (current: string) => [
  { value: '', label: 'Same as my messages' },
  ...LANGUAGES.map((l) => ({ value: l, label: l })),
  ...(current && !LANGUAGES.includes(current) ? [{ value: current, label: current }] : []),
]

/** What share info sends and never sends. Also on Settings › About › Privacy. */
export function ShareInfoText() {
  return (
    <div className="share-info-text small">
      <p>
        <b>Sent:</b> the app version, your operating system, which features you use (as counts), and error reports with file paths removed. They're tied to a random install id, not to you.
      </p>
      <p>
        <b>Never sent:</b> your prompts, code, file names, paths, API keys or chat content.
      </p>
    </div>
  )
}
