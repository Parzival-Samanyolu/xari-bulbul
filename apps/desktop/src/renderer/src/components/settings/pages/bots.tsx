import { useEffect, useState } from 'react'
import { BOT_ALWAYS_TOOLS, isImageAvatar, newBotId } from '@harness/core/bots'
import { EFFORT_LABELS, EFFORT_LEVELS, type ReasoningEffort } from '@harness/core/catalog'
import type { PermissionMode, Settings } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { BotAvatar } from '../../Bots'
import { MODES } from '../../Composer'
import { Row, Section, Select, TextField, Toggle } from '../../fields'
import { ModelChoice, type PageProps } from '../common'

type Bot = Settings['bots'][number]

// ---------------------------------------------------------------- Experimental

export function ExperimentalPage({ app, save, go }: PageProps) {
  const on = app.settings.experimental.bots
  return (
    <Section>
      <Row
        label="Bots"
        hint={
          <>
            Saved agents with their own personality, model and tools, shown above your folders. Off hides them; chats with a bot then open as plain chats, and
            your bots and their memories are kept.{' '}
            {on && (
              <button className="link small" onClick={() => go('bots')}>
                Open Bots
              </button>
            )}
          </>
        }
      >
        <Toggle label="Bots" value={on} onChange={(v) => save((s) => ((s.experimental.bots = v), s))} />
      </Row>
    </Section>
  )
}

// ---------------------------------------------------------------- Bots

const MEMORY_HINT: Record<Bot['memory'], string> = {
  shared: 'Uses the same memories as your other chats.',
  own: 'Also keeps notes only this bot sees, saved in the data folder under memory/bots.',
  off: "Doesn't read or save memories.",
}

export function BotsPage({ app, save, onState, onError, close }: PageProps) {
  const bots = app.settings.bots
  const [selId, setSelId] = useState<string | null>(bots[0]?.id ?? null)
  const sel = bots.find((b) => b.id === selId) ?? bots[0] ?? null
  const ids = bots.map((b) => b.id)
  const update = (id: string, fn: (b: Bot) => void) =>
    save((s) => {
      const b = s.bots.find((x) => x.id === id)
      if (b) fn(b)
      return s
    })

  const add = () => {
    const id = newBotId('New bot', ids)
    save((s) => (s.bots.push({ id, enabled: true, name: 'New bot', avatar: '🤖', color: '#9b4d6e', tagline: '', persona: '', tools: 'all', memory: 'shared' }), s))
    setSelId(id)
  }
  const duplicate = (b: Bot) => {
    const name = `${b.name} copy`
    const id = newBotId(name, ids)
    save((s) => (s.bots.splice(s.bots.findIndex((x) => x.id === b.id) + 1, 0, { ...structuredClone(b), id, name }), s))
    setSelId(id)
  }
  const remove = (b: Bot) => {
    if (!confirm(`Remove ${b.name}? Its chats are kept and open as plain chats.`)) return
    save((s) => ((s.bots = s.bots.filter((x) => x.id !== b.id)), s))
    setSelId(null)
  }
  const preview = (b: Bot) =>
    api.sessions.create(undefined, b.id).then((s) => {
      onState(s)
      close()
    }, onError)

  return (
    <>
      <Section title="Your bots" description="Turn a bot off to hide it from the sidebar. Its chats stay and show a note.">
        {bots.length === 0 && (
          <div className="empty-box">
            <b>No bots</b>
            <span className="muted small">Add one to give it a personality, a model and the tools it may use.</span>
          </div>
        )}
        {bots.length > 0 && (
          <ul className="bot-list" aria-label="Bots">
            {bots.map((b) => (
              <li key={b.id} className={`bot-item ${sel?.id === b.id ? 'sel' : ''}`}>
                <Toggle label={`${b.name} on`} value={b.enabled} onChange={(v) => update(b.id, (x) => (x.enabled = v))} />
                <button className="bot-item-open" aria-pressed={sel?.id === b.id} onClick={() => setSelId(b.id)}>
                  <BotAvatar app={app} bot={b} size={28} />
                  <span className="bot-item-text">
                    <span>{b.name || 'Bot'}</span>
                    <span className="muted small">{b.enabled ? b.tagline || 'No tagline' : 'Turned off'}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <button className="btn" onClick={add}>
            Add bot
          </button>
        </div>
      </Section>
      {sel && <BotEditor key={sel.id} bot={sel} {...{ app, save, onState, onError }} update={(fn) => update(sel.id, fn)} onDuplicate={() => duplicate(sel)} onRemove={() => remove(sel)} onPreview={() => preview(sel)} />}
    </>
  )
}

function BotEditor({
  app,
  bot,
  update,
  onState,
  onError,
  onDuplicate,
  onRemove,
  onPreview,
}: Pick<PageProps, 'app' | 'onState' | 'onError' | 'save'> & { bot: Bot; update: (fn: (b: Bot) => void) => void; onDuplicate: () => void; onRemove: () => void; onPreview: () => void }) {
  const image = isImageAvatar(bot.avatar)
  const previewBlock = !bot.enabled ? 'Turn the bot on to preview it.' : !app.workspace ? 'Open a folder to preview it.' : ''
  const tools = app.extensions.tools.filter((t) => !BOT_ALWAYS_TOOLS.includes(t.name))
  const chosen = bot.tools === 'all' ? null : bot.tools
  // Names saved earlier that this folder doesn't have (another folder's MCP server, a pattern).
  const extraTools = chosen?.filter((n) => !tools.some((t) => t.name === n)) ?? []
  const toggleTool = (name: string, on: boolean) => update((b) => (b.tools = on ? [...(b.tools === 'all' ? [] : b.tools), name] : (b.tools === 'all' ? [] : b.tools).filter((n) => n !== name)))
  const skillNames = [...new Set([...app.skills.map((s) => s.name), ...(bot.skills ?? [])])].sort()
  const toggleSkill = (name: string, on: boolean) => update((b) => (b.skills = on ? [...(b.skills ?? []), name] : (b.skills ?? []).filter((n) => n !== name)))

  return (
    <Section title={bot.name || 'Bot'}>
      <div className="inline">
        <button className="btn" disabled={!!previewBlock} title={previewBlock || 'Start a new chat with this bot in the current folder'} onClick={onPreview}>
          Preview
        </button>
        <button className="btn ghost" onClick={onDuplicate}>
          Duplicate
        </button>
        <button className="link danger small" onClick={onRemove}>
          Remove
        </button>
        {previewBlock && <span className="muted small">{previewBlock}</span>}
      </div>
      <Row label="Name" labelFor={`bot-name-${bot.id}`}>
        <TextField id={`bot-name-${bot.id}`} value={bot.name} onChange={(v) => update((b) => (b.name = v.trim() || 'Bot'))} />
      </Row>
      <Row label="Avatar" hint={image ? 'A picture from your computer.' : 'An emoji, or a picture from your computer.'}>
        <div className="inline">
          <BotAvatar app={app} bot={bot} size={28} />
          {!image && <TextField label="Avatar emoji" value={bot.avatar} onChange={(v) => update((b) => (b.avatar = [...v.trim()].slice(0, 4).join('') || '🤖'))} />}
          <button className="btn" onClick={() => api.bots.pickAvatar(bot.id).then((s) => s && onState(s), onError)}>
            Choose picture…
          </button>
          {image && (
            <button className="link small" onClick={() => update((b) => (b.avatar = '🤖'))}>
              Use an emoji
            </button>
          )}
        </div>
      </Row>
      <Row label="Color" hint="Shown around the avatar and on the chat header.">
        <ColorField label={`${bot.name} color`} value={bot.color} onChange={(v) => update((b) => (b.color = v))} />
      </Row>
      <Row label="Tagline" hint="One line under the name." labelFor={`bot-tag-${bot.id}`}>
        <TextField id={`bot-tag-${bot.id}`} value={bot.tagline} placeholder="Terse code review" onChange={(v) => update((b) => (b.tagline = v))} />
      </Row>
      <Row label="Persona" hint="How the bot talks and what it focuses on. Added to the system prompt; it can't change the safety, permission or tool rules." wide>
        <TextField label="Persona" multiline rows={6} value={bot.persona} placeholder="You review code. Be terse. Lead with bugs and security problems." onChange={(v) => update((b) => (b.persona = v))} />
      </Row>
      <Row label="Greeting" hint="Shown as the bot's first message. The model never sees it." wide>
        <TextField label="Greeting" multiline rows={2} value={bot.greeting ?? ''} placeholder="What should we look at?" onChange={(v) => update((b) => (b.greeting = v.trim() ? v : undefined))} />
      </Row>
      <Row label="Model" hint="New chats with this bot start on it. You can still switch the model in a chat.">
        <ModelChoice app={app} value={bot.model ?? null} empty="Default model" title={`Model for ${bot.name}…`} onChange={(r) => update((b) => (b.model = r ?? undefined))} onState={onState} onError={onError} />
      </Row>
      <Row label="Thinking" hint="Replaces the default thinking level in this bot's chats. A level set for the model itself still wins.">
        <Select
          label="Thinking"
          value={bot.thinking ?? ''}
          options={[{ value: '', label: 'Default' }, ...EFFORT_LEVELS.map((l) => ({ value: l, label: EFFORT_LABELS[l] }))]}
          onChange={(v) => update((b) => (b.thinking = (v || undefined) as ReasoningEffort | undefined))}
        />
      </Row>
      <Row label="Permission mode" hint="The mode its chats start in. Changing the mode in one of its chats changes only that chat.">
        <Select
          label="Permission mode"
          value={bot.mode ?? ''}
          options={[{ value: '', label: 'Current mode' }, ...MODES.map((m) => ({ value: m.id, label: m.label }))]}
          onChange={(v) => update((b) => (b.mode = (v || undefined) as PermissionMode | undefined))}
        />
      </Row>
      <Row label="Tools" hint={chosen ? 'Only the checked tools. Memory and skill tools follow the Memory and Skills settings.' : 'Every tool the agent has, including MCP and extension tools.'} wide>
        <div className="s-stack">
          <Select
            label="Tools"
            value={chosen ? 'some' : 'all'}
            options={[
              { value: 'all', label: 'All tools' },
              { value: 'some', label: 'Only these' },
            ]}
            onChange={(v) => update((b) => (b.tools = v === 'all' ? 'all' : app.extensions.tools.filter((t) => t.readOnly && !BOT_ALWAYS_TOOLS.includes(t.name)).map((t) => t.name)))}
          />
          {chosen && (
            <div className="bot-tools" role="group" aria-label={`Tools for ${bot.name}`}>
              {tools.map((t) => (
                <label key={t.name} title={t.description}>
                  <input type="checkbox" checked={chosen.includes(t.name)} onChange={(e) => toggleTool(t.name, e.target.checked)} /> {t.name}
                </label>
              ))}
              {extraTools.map((n) => (
                <label key={n} title="Not available in this folder">
                  <input type="checkbox" checked onChange={(e) => toggleTool(n, e.target.checked)} /> {n}
                </label>
              ))}
            </div>
          )}
        </div>
      </Row>
      <Row label="Skills" hint={bot.skills ? 'Only the checked skills are listed for it.' : 'Every skill, as in other chats.'} wide>
        <div className="s-stack">
          <Select
            label="Skills"
            value={bot.skills ? 'some' : 'all'}
            options={[
              { value: 'all', label: 'All skills' },
              { value: 'some', label: 'Only these' },
            ]}
            onChange={(v) => update((b) => (b.skills = v === 'all' ? undefined : []))}
          />
          {bot.skills && (
            <div className="bot-tools" role="group" aria-label={`Skills for ${bot.name}`}>
              {skillNames.length === 0 && <span className="muted small">No skills in this folder yet.</span>}
              {skillNames.map((n) => (
                <label key={n}>
                  <input type="checkbox" checked={bot.skills!.includes(n)} onChange={(e) => toggleSkill(n, e.target.checked)} /> {n}
                </label>
              ))}
            </div>
          )}
        </div>
      </Row>
      <Row label="Memory" hint={MEMORY_HINT[bot.memory]}>
        <Select
          label="Memory"
          value={bot.memory}
          options={[
            { value: 'shared', label: 'Shared' },
            { value: 'own', label: 'Shared plus its own' },
            { value: 'off', label: 'Off' },
          ]}
          onChange={(v) => update((b) => (b.memory = v))}
        />
      </Row>
    </Section>
  )
}

/** A color picker that saves once the pointer settles, not on every step of a drag. */
function ColorField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  useEffect(() => {
    if (v === value) return
    const t = setTimeout(() => onChange(v), 300)
    return () => clearTimeout(t)
  }, [v])
  // <input type=color> only takes #rrggbb.
  const hex = /^#[0-9a-f]{6}$/i.test(v) ? v : '#9b4d6e'
  return <input type="color" className="color-input" aria-label={label} value={hex} onChange={(e) => setV(e.target.value)} />
}
