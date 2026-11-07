import { useT } from '../../../lib/i18n'
import { Row, Section, Toggle } from '../../fields'
import { BotAvatar } from '../../Bots'
import type { PageProps } from '../common'

// ---------------------------------------------------------------- Bots

export function BotsPage({ app, save, editBot }: PageProps) {
  const { t } = useT()
  const bots = app.settings.bots
  const on = app.settings.botOptions.enabled
  const remove = (id: string, name: string) => {
    if (!confirm(t('settings.bots.deleteConfirm', { name }))) return
    save((s) => ((s.bots = s.bots.filter((b) => b.id !== id)), s))
  }

  return (
    <>
      <Section>
        <Row label={t('settings.bots.showTab')} hint={t('settings.bots.showTabHint')}>
          <Toggle label={t('settings.bots.showTab')} value={on} onChange={(v) => save((s) => ((s.botOptions.enabled = v), s))} />
        </Row>
        <Row label={t('settings.bots.mute')} hint={t('settings.bots.muteHint')}>
          <Toggle label={t('settings.bots.mute')} value={app.settings.botOptions.muted} onChange={(v) => save((s) => ((s.botOptions.muted = v), s))} />
        </Row>
      </Section>
      <Section title={t('settings.bots.yourBots')} description={t('settings.bots.yourBotsDesc')}>
        {bots.length === 0 && (
          <div className="empty-box">
            <b>{t('settings.bots.none')}</b>
            <span className="muted small">{t('settings.bots.noneHint')}</span>
          </div>
        )}
        {bots.length > 0 && (
          <ul className="bot-list" aria-label={t('settings.bots.list')}>
            {bots.map((b) => (
              <li key={b.id} className={`bot-item ${b.enabled ? '' : 'off'}`}>
                <Toggle label={t('settings.bots.toggle', { name: b.name || t('settings.bots.unnamed') })} value={b.enabled} onChange={(v) => save((s) => ((s.bots = s.bots.map((x) => (x.id === b.id ? { ...x, enabled: v } : x))), s))} />
                <BotAvatar app={app} bot={b} size={30} />
                <span className="bot-item-text">
                  <span>{b.name || t('settings.bots.unnamed')}</span>
                  <span className="muted small" title={b.enabled ? b.tagline || undefined : undefined}>
                    {b.enabled ? b.tagline || t('settings.bots.noTitle') : t('settings.bots.turnedOff')}
                  </span>
                </span>
                <button className="btn ghost" onClick={() => editBot(b.id)}>
                  {t('settings.bots.edit')}
                </button>
                <button className="link danger small" aria-label={t('settings.bots.deleteLabel', { name: b.name || t('settings.bots.unnamed') })} onClick={() => remove(b.id, b.name || t('settings.bots.unnamed'))}>
                  {t('common.delete')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <button className="btn" onClick={() => editBot()}>
            {t('settings.bots.new')}
          </button>
        </div>
      </Section>
    </>
  )
}
