import { Row, Section, Toggle } from '../../fields'
import { BotAvatar } from '../../Bots'
import type { PageProps } from '../common'

// ---------------------------------------------------------------- Bots

export function BotsPage({ app, save, editBot }: PageProps) {
  const bots = app.settings.bots
  const on = app.settings.botOptions.enabled
  const remove = (id: string, name: string) => {
    if (!confirm(`Delete ${name}? Its chats are kept and move to Sessions as plain chats.`)) return
    save((s) => ((s.bots = s.bots.filter((b) => b.id !== id)), s))
  }

  return (
    <>
      <Section>
        <Row
          label="Show the Bots tab"
          hint="Bots are characters to chat with, next to your sessions. Off hides the tab; bot chats then open as plain chats in their folders, and your bots and their memories are kept."
        >
          <Toggle label="Show the Bots tab" value={on} onChange={(v) => save((s) => ((s.botOptions.enabled = v), s))} />
        </Row>
        <Row label="Mute all bots" hint="No notification when a bot finishes replying while you're in another chat. Approvals and questions still notify.">
          <Toggle label="Mute all bots" value={app.settings.botOptions.muted} onChange={(v) => save((s) => ((s.botOptions.muted = v), s))} />
        </Row>
      </Section>
      <Section
        title="Your bots"
        description="Each bot works in full auto with every tool, unless you change that under Advanced. Deleting files, force pushes and writes outside the folder still ask."
      >
        {bots.length === 0 && (
          <div className="empty-box">
            <b>No bots yet</b>
            <span className="muted small">Make one to give it a face, a personality and its own memory.</span>
          </div>
        )}
        {bots.length > 0 && (
          <ul className="bot-list" aria-label="Bots">
            {bots.map((b) => (
              <li key={b.id} className={`bot-item ${b.enabled ? '' : 'off'}`}>
                <Toggle label={`${b.name} on`} value={b.enabled} onChange={(v) => save((s) => ((s.bots = s.bots.map((x) => (x.id === b.id ? { ...x, enabled: v } : x))), s))} />
                <BotAvatar app={app} bot={b} size={30} />
                <span className="bot-item-text">
                  <span>{b.name || 'Bot'}</span>
                  <span className="muted small">{b.enabled ? b.tagline || 'No title' : 'Turned off'}</span>
                </span>
                <button className="btn ghost" onClick={() => editBot(b.id)}>
                  Edit…
                </button>
                <button className="link danger small" aria-label={`Delete ${b.name}`} onClick={() => remove(b.id, b.name)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <button className="btn" onClick={() => editBot()}>
            New bot
          </button>
        </div>
      </Section>
    </>
  )
}
