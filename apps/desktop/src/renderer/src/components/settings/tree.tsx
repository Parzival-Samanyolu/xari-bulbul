import type { ComponentType } from 'react'
import type { Settings } from '../../../../shared/ipc'
import { SHORTCUTS } from '../../lib/shortcuts'
import type { PageProps } from './common'
import type { IconName } from './icons'
import { DesktopPage, LimitsPage, OutputPage, TerminalPage, ToolAccessPage } from './pages/advanced'
import { BotsPage } from './pages/bots'
import { IMessagePage, WhatsAppPage } from './pages/gateways'
import { PluginsPage, SchedulesPage, SessionsPage, UsagePage, VersionPage } from './pages/data'
import { AppearancePage, ChatPage, InstructionsPage, NotificationsPage, ShortcutsPage, WorkspacePage } from './pages/general'
import { AuxModelsPage, FallbackPage, MainModelPage, MoaPage, SubagentsPage } from './pages/model'
import { LocalModelsPage } from './pages/local'
import { AppLogPage, ResourcesPage } from './pages/logs'
import { PrivacyPage, ProfilePage } from './pages/profile'
import { AccountsPage, ApiKeysPage, CustomEndpointsPage } from './pages/providers'
import { HooksPage, SafetyPage } from './pages/safety'
import { BrowserPage, ContextPage, MemoryPage, PasswordsPage, SpeechToTextPage, VoiceConversationPage } from './pages/system'
import { TextToSpeechPage } from './pages/speech'
import { ExtensionsPage, McpPage, SkillsPage, ToolsListPage, WebSearchPage } from './pages/tools'

// The Settings tabs: one flat list. A tab shows one or more sections, each an existing page
// component; a tab with several stacks them under their own headings. To add settings: write a
// component taking PageProps and add it as a section of the tab it belongs to, with the rows
// search should find. Each row label must match a <Row label> or <Section title> in that
// component, since search scrolls to `[data-row="label"]` inside the section.

/** A row search can find: its label, plus extra words people might search for. */
export type RowDef = [label: string, keywords?: string]

/** A section of a tab. Its id is what `go()` and deep links use to open it. */
export interface PageDef {
  id: string
  label: string
  /** One muted line under the section heading (or under the breadcrumb when it's the tab's only section). */
  description: string
  rows?: RowDef[]
  page: ComponentType<PageProps>
  /** Left out of the tab and search. */
  hidden?: boolean
  /** Shown only while this is true (a section for a feature that can be turned off). */
  when?: (s: Settings) => boolean
}

export interface TabDef {
  id: string
  label: string
  icon: IconName
  /** One muted line under the breadcrumb. */
  description: string
  sections: PageDef[]
}

const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || navigator.userAgent)

export const TABS: TabDef[] = [
  {
    id: 'providers',
    label: 'Providers',
    icon: 'providers',
    description: 'Where models come from: accounts, API keys and your own endpoints. Keys stay in your system keychain.',
    sections: [
      { id: 'providers.accounts', label: 'Accounts', description: 'Providers that are connected and ready to use.', page: AccountsPage, rows: [] },
      { id: 'providers.keys', label: 'API keys', description: 'Paste a key to connect a provider.', page: ApiKeysPage, rows: [] },
      { id: 'providers.custom', label: 'Custom endpoints', description: 'Local servers and other OpenAI- or Anthropic-compatible APIs.', page: CustomEndpointsPage, rows: [['Quick add', 'ollama lm studio deepseek local'], ['New endpoint', 'add endpoint url']] },
    ],
  },
  {
    id: 'models',
    label: 'Models',
    icon: 'model',
    description: 'Which models chats use, for answers and for background work.',
    sections: [
      {
        id: 'model.main',
        label: 'Main model',
        description: 'The model new chats start with, and how it generates.',
        page: MainModelPage,
        rows: [['Default model', 'new chats'], ['Reasoning effort', 'thinking'], ['Context window', 'context length tokens override'], ['Temperature'], ['Max output tokens', 'length'], ['Fallback context size', 'ollama'], ['Free models only', 'switcher picker paid'], ['Only models that can use tools', 'switcher picker'], ['Favorites', 'pinned switcher'], ['Per-model overrides', 'speed fast batch replay reasoning']],
      },
      {
        id: 'model.aux',
        label: 'Auxiliary models',
        description: 'Models for background work: naming chats, saving memories, summarizing.',
        page: AuxModelsPage,
        rows: [['Chat naming model', 'title'], ['Memory model', 'memory review'], ['Summarization model', 'compaction compact']],
      },
      {
        id: 'model.fallback',
        label: 'Fallback models',
        description: 'Models the chat moves to when the main model fails.',
        page: FallbackPage,
        rows: [['Fallback models', 'failover backup outage rate limit 429 error'], ['Fallback order', 'reorder priority'], ["When it doesn't switch", 'abort context window budget']],
      },
      {
        id: 'model.moa',
        label: 'Mixture of Agents',
        description: 'Several models answer; one combines their answers.',
        page: MoaPage,
        rows: [['Mixture of Agents', 'moa mix ensemble'], ['On by default', 'mix toggle'], ['Proposers', 'models answer'], ['Combining model', 'aggregator'], ['Cost', 'price usage budget']],
      },
      {
        id: 'providers.local',
        label: 'Local models',
        description: 'Models that run on this computer, with no account or key.',
        page: LocalModelsPage,
        rows: [['Local runtime', 'llama.cpp engine install offline'], ['This machine', 'gpu ram memory unified'], ['GPU memory', 'vram'], ['RAM', 'memory'], ['Models', 'download qwen gemma local'], ['Find more models', 'hugging face search gguf add model file']],
      },
    ],
  },
  {
    id: 'agent',
    label: 'Agent',
    icon: 'advanced',
    description: 'How the agent works: its instructions, limits, helpers, context, shell, browser and voice.',
    sections: [
      {
        id: 'agent.instructions',
        label: 'Instructions',
        description: 'What every chat is told before your first message.',
        page: InstructionsPage,
        rows: [['Custom instructions', 'prompt'], ['System prompt', 'short lean full'], ['System prompt override']],
      },
      {
        id: 'advanced.limits',
        label: 'Limits',
        description: 'Safety nets for long or stuck turns.',
        page: LimitsPage,
        rows: [['Max steps per message', 'turns loop'], ['Request retries', '429 rate limit'], ['Stall timeout'], ['Batch while planning', 'batch api plan mode']],
      },
      {
        id: 'model.subagents',
        label: 'Subagents',
        description: 'Helpers the agent hands self-contained jobs to, each with a fresh context.',
        page: SubagentsPage,
        rows: [['Allow subagents', 'task tool delegate'], ['Subagent model'], ['Subagents can edit', 'write'], ['Run at once', 'parallel'], ['Max steps per subagent']],
      },
      {
        id: 'memory.context',
        label: 'Context',
        description: 'What happens when a chat fills the model’s context window.',
        page: ContextPage,
        rows: [['Auto-compact', 'summarize compaction'], ['Compact at', 'threshold']],
      },
      { id: 'advanced.output', label: 'Tool output', description: 'How much tool output the model sees.', page: OutputPage, rows: [['Max tool output', 'truncate characters']] },
      { id: 'advanced.terminal', label: 'Shell', description: 'The shell the agent runs commands in.', page: TerminalPage, rows: [['Shell', 'bash zsh powershell terminal'], ['Command timeout', 'bash']] },
      {
        id: 'browser',
        label: 'Browser',
        description: 'The browser the agent drives to open, read and click through pages.',
        page: BrowserPage,
        rows: [['Let the agent use a browser', 'chrome edge brave'], ['Hide the browser window', 'headless'], ['Browser path', 'executable']],
      },
      {
        id: 'voice.conversation',
        label: 'Voice input',
        description: 'Dictating messages with the mic button.',
        page: VoiceConversationPage,
        rows: [['Voice input', 'microphone mic dictate'], ['Longest recording', 'length seconds'], ['Send after transcribing', 'auto send']],
      },
      {
        id: 'voice.stt',
        label: 'Speech to text',
        description: 'How recordings become text: on this computer, or through a provider.',
        page: SpeechToTextPage,
        rows: [['Engine', 'voice'], ['Language', 'spoken'], ['Local speech model', 'whisper offline'], ['Transcription model', 'whisper provider']],
      },
      {
        id: 'voice.tts',
        label: 'Text to speech',
        description: 'Reading replies aloud: the speaker button on replies, or every reply automatically.',
        page: TextToSpeechPage,
        rows: [['Provider', 'tts speech voice system openai'], ['Voice', 'speaker narrator'], ['Speed', 'rate'], ['Read responses aloud', 'read aloud automatically speak tts'], ['Test', 'sample sentence']],
      },
    ],
  },
  {
    id: 'permissions',
    label: 'Permissions',
    icon: 'safety',
    description: 'What the agent may do without asking you first, and the keys and logins it can use.',
    sections: [
      {
        id: 'safety',
        label: 'Safety',
        description: 'The default mode, guards that always ask, and allow and deny rules.',
        page: SafetyPage,
        rows: [['Default mode', 'permission ask auto plan'], ['Confirm destructive commands', 'rm force push'], ['Allow edits outside the project folder'], ['Always allow', 'rules permissions'], ['Always deny', 'rules permissions block']],
      },
      {
        id: 'passwords',
        label: 'Passwords & logins',
        description: 'Saved keys and tokens, and the browser profile that keeps site logins.',
        page: PasswordsPage,
        rows: [['Saved keys', 'api keys tokens secrets keychain'], ['Keep site logins', 'browser profile cookies'], ['Saved logins', 'sign out cookies delete']],
      },
    ],
  },
  {
    id: 'hooks',
    label: 'Hooks',
    icon: 'terminal',
    description: 'Shell commands that run before or after the agent’s tool calls.',
    sections: [{ id: 'hooks', label: 'Hooks', description: '', page: HooksPage, rows: [['Before a tool runs', 'hook pre'], ['After a tool runs', 'hook post']] }],
  },
  {
    id: 'tools',
    label: 'Tools & extensions',
    icon: 'tools',
    description: 'The tools the agent can call, and your own tools, skills and commands.',
    sections: [
      { id: 'tools.list', label: 'Tools', description: 'Every tool the agent can call.', page: ToolsListPage, rows: [] },
      { id: 'advanced.tools', label: 'Checks', description: 'Checks and tools that change how the agent works.', page: ToolAccessPage, rows: [['Check files after edits', 'lint eslint ruff'], ['Check time limit'], ['Let the agent ask you questions', 'ask_user']] },
      { id: 'tools.search', label: 'Web search', description: 'How the web_search tool searches, and its optional keys.', page: WebSearchPage, rows: [['Search with', 'backend duckduckgo'], ['Brave Search key', 'api'], ['Tavily key', 'api'], ['SearXNG URL']] },
      { id: 'tools.skills', label: 'Skills & commands', description: 'Saved instructions the agent loads, and slash commands.', page: SkillsPage, rows: [['Skills', 'SKILL.md'], ['Slash commands', '/']] },
      { id: 'tools.extensions', label: 'Extensions', description: 'Your own tools and commands, written as files.', page: ExtensionsPage, rows: [['Load my extensions'], ['Load project tool code (extensions)', 'trust']] },
    ],
  },
  {
    id: 'mcp',
    label: 'MCP servers',
    icon: 'server',
    description: 'Tools from Model Context Protocol servers.',
    sections: [{ id: 'tools.mcp', label: 'MCP servers', description: '', page: McpPage, rows: [['Add a server', 'mcp github preset']] }],
  },
  {
    id: 'plugins',
    label: 'Plugins',
    icon: 'plugins',
    description: 'Reviewed tools and skills for apps on this computer.',
    sections: [{ id: 'plugins', label: 'Plugins', description: '', page: PluginsPage, rows: [] }],
  },
  {
    id: 'schedules',
    label: 'Schedules',
    icon: 'schedules',
    description: 'Prompts that run on a timer, each in a new chat, while the app is open.',
    sections: [{ id: 'schedules', label: 'Schedules', description: '', page: SchedulesPage, rows: [] }],
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: 'memory',
    description: 'Facts the agent keeps across chats, such as your preferences or how to test a project.',
    sections: [{ id: 'memory.persistent', label: 'Memory', description: '', page: MemoryPage, rows: [['Let the agent remember', 'remember forget'], ['Save facts after each reply', 'memory review automatic'], ['Size limit']] }],
  },
  {
    id: 'usage',
    label: 'Usage & budgets',
    icon: 'usage',
    description: 'Tokens and cost of every request, and spending limits.',
    sections: [
      {
        id: 'usage',
        label: 'Usage',
        description: '',
        page: UsagePage,
        rows: [['Show cost', 'status bar price'], ['Show the last request in the status bar', 'tokens'], ['Budgets', 'spending limit'], ['Per-chat budget'], ['Daily budget'], ['When a budget is reached']],
      },
    ],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'appearance',
    description: 'How the app looks and behaves on this computer.',
    sections: [
      { id: 'appearance', label: 'Look', description: 'Layout, theme and type.', page: AppearancePage, rows: [['Layout', 'basic elite panels terminal'], ['Theme', 'dark light oled sepia contrast'], ['Font size'], ['Interface font', 'typeface'], ['Code font', 'monospace'], ['Density', 'compact']] },
      { id: 'chat', label: 'Chat', description: 'How messages are sent and shown.', page: ChatPage, rows: [['Enter sends message', 'send key newline'], ['Show model reasoning', 'thinking'], ['Expand tool calls']] },
      { id: 'workspace', label: 'Workspace', description: 'The folders you work in and what the agent reads from them.', page: WorkspacePage, rows: [['Open folders', 'projects sidebar'], ['Project instruction files', 'AGENTS.md CLAUDE.md'], ['Load project tool code', 'extensions trust']] },
      {
        id: 'notifications',
        label: 'Notifications',
        description: 'System notifications about chats running in the background.',
        page: NotificationsPage,
        rows: [['Notify me', 'notifications'], ['Finishes', 'done notification'], ['Stops early', 'error notification'], ['Needs approval', 'permission notification'], ['Has a question', 'notification']],
      },
      { id: 'shortcuts', label: 'Keyboard shortcuts', description: 'Keys for common actions. Most can be changed.', page: ShortcutsPage, rows: SHORTCUTS.map((s) => [s.label, 'shortcut keys'] as RowDef) },
      { id: 'advanced.desktop', label: 'Desktop & startup', description: 'How the app starts and runs on this computer.', page: DesktopPage, rows: [['Launch at login', 'startup open'], ['Reopen the last chat', 'resume restore'], ['Keep the computer awake', 'sleep caffeinate'], ['Data folder']] },
    ],
  },
  {
    id: 'data',
    label: 'Data & updates',
    icon: 'about',
    description: 'Saved chats, what you’ve told the app about yourself, what it shares, and its version.',
    sections: [
      { id: 'sessions', label: 'Chats', description: "How long chats are kept and how the agent can search them.", page: SessionsPage, rows: [['Delete old chats', 'retention sessions'], ['Search past chats', 'session_search'], ['Chats', 'delete all export sessions']] },
      {
        id: 'profile',
        label: 'Profile',
        description: 'Who you are, so the agent can pitch its answers to you.',
        page: ProfilePage,
        rows: [['Name', 'call me'], ['Role', 'job developer designer student researcher'], ['Experience', 'beginner level skill'], ['Main uses', 'coding writing research automation learning'], ['Reply language', 'language turkish azerbaijani translate answer']],
      },
      { id: 'about.privacy', label: 'Privacy', description: 'What the app shares, if anything.', page: PrivacyPage, rows: [['Share anonymous usage info', 'telemetry analytics crash error reports share info usage data']] },
      { id: 'about.version', label: 'Version & updates', description: 'Which version you have, and how it updates.', page: VersionPage, rows: [['Version', 'about'], ['Check for updates automatically', 'auto update'], ['Source code', 'github license']] },
    ],
  },
  {
    id: 'gateways',
    label: 'Gateways',
    icon: 'gateway',
    description: 'Message the agent from your phone. Gateways run while the app is open.',
    sections: [
      {
        id: 'gateways.imessage',
        label: 'iMessage',
        description: 'Text the agent from your own phone.',
        page: IMessagePage,
        // Messages and its database exist only on macOS.
        hidden: !MAC,
        rows: [['Receive texts from iMessage', 'imessage messages sms text phone gateway'], ['Allowed senders', 'phone number email apple id'], ['Folder', 'imessage chats'], ['Permission mode', 'imessage ask auto'], ['Check for new texts every', 'poll interval seconds'], ['Send test message', 'connected automation']],
      },
      {
        id: 'gateways.whatsapp',
        label: 'WhatsApp',
        description: 'Message the agent from your own WhatsApp “Message yourself” chat.',
        page: WhatsAppPage,
        rows: [['Use WhatsApp', 'whatsapp phone message gateway baileys link qr'], ['Folder', 'whatsapp chat'], ['Permission mode', 'whatsapp ask auto'], ['Reply prefix', 'whatsapp marker emoji']],
      },
    ],
  },
  {
    id: 'bots',
    label: 'Bots',
    icon: 'bot',
    description: 'Characters to chat with, each with its own face, personality, memory and chat. They live in the sidebar’s Bots tab.',
    sections: [{ id: 'bots', label: 'Bots', description: '', page: BotsPage, rows: [['Show the Bots tab', 'sidebar companions characters'], ['Mute all bots', 'notifications'], ['Your bots', 'new edit delete turn off personality persona avatar face']] }],
  },
  {
    id: 'logs',
    label: 'Logs & performance',
    icon: 'gauge',
    description: 'What the app is using on this computer, and a log of errors and events for troubleshooting.',
    sections: [
      {
        id: 'logs.performance',
        label: 'Performance',
        description: 'Memory and CPU used by the app’s processes and the programs it started.',
        page: ResourcesPage,
        rows: [['Show memory and CPU in the status bar', 'resource monitor ram usage performance'], ['App memory', 'ram resource monitor'], ['Graphics', 'gpu video'], ['Processes', 'cpu memory ram mcp terminal llama']],
      },
      { id: 'logs.app', label: 'App log', description: 'Errors, retries, fallbacks and other events, kept for 7 days. Keys and tokens are removed before writing.', page: AppLogPage, rows: [['Log', 'logs errors warnings debug troubleshoot export copy']] },
    ],
  },
]

const shown = (p: PageDef, s?: Settings) => !p.hidden && (!s || !p.when || p.when(s))

/** The tabs with only the sections shown with `s` (tabs left empty by that are dropped). */
export function visibleTabs(s?: Settings): TabDef[] {
  return TABS.flatMap((t) => {
    const sections = t.sections.filter((p) => shown(p, s))
    return sections.length ? [{ ...t, sections }] : []
  })
}

/** Every built tab, including sections a setting turns off. */
const VISIBLE = visibleTabs()

export interface PageEntry {
  tab: TabDef
  /** The section a deep link points at; null for the tab itself. */
  section: PageDef | null
}

export const DEFAULT_PAGE = 'providers'

/** Ids from older links (group ids of the old two-level tree) → a tab or section. The old flat tab ids are tab ids again. */
const ALIASES: Record<string, string> = {
  model: 'models',
  'advanced.experimental': 'bots',
  advanced: 'agent',
  voice: 'voice.stt',
  about: 'about.version',
  'about.data': 'data',
}

function find(id: string): PageEntry | null {
  const tab = VISIBLE.find((t) => t.id === id)
  if (tab) return { tab, section: null }
  for (const t of VISIBLE) {
    const section = t.sections.find((p) => p.id === id)
    if (section) return { tab: t, section }
  }
  return null
}

/** Whether the tab or section is shown with these settings. */
export function pageShown(id: string, s: Settings): boolean {
  const e = find(id)
  if (!e) return false
  return e.section ? shown(e.section, s) : e.tab.sections.some((p) => shown(p, s))
}

/** A tab or section id, an old id, or nothing → the id to open (DEFAULT_PAGE when unknown or turned off). */
export function resolvePage(id: string | undefined, s?: Settings): string {
  if (!id) return DEFAULT_PAGE
  const target = find(id) ? id : ALIASES[id] && find(ALIASES[id]) ? ALIASES[id] : null
  if (!target || (s && !pageShown(target, s))) return DEFAULT_PAGE
  return target
}

export function pageEntry(id: string): PageEntry {
  return find(id) ?? find(DEFAULT_PAGE)!
}

export interface SearchHit {
  /** The tab to open. */
  tabId: string
  /** The section the row is in. */
  sectionId: string
  /** The row to scroll to; empty for the section or tab itself. */
  row: string
  label: string
  /** Where it lives, e.g. "Models › Main model". */
  where: string
}

interface IndexItem extends SearchHit {
  hay: string
}

const INDEX: IndexItem[] = VISIBLE.flatMap((tab) => {
  const own: IndexItem = { tabId: tab.id, sectionId: '', row: '', label: tab.label, where: 'Settings', hay: `${tab.label} ${tab.description}`.toLowerCase() }
  const many = tab.sections.length > 1
  return [
    own,
    ...tab.sections.flatMap((p) => {
      const where = many ? `${tab.label} › ${p.label}` : tab.label
      const head: IndexItem[] = many ? [{ tabId: tab.id, sectionId: p.id, row: '', label: p.label, where: tab.label, hay: `${p.label} ${tab.label} ${p.description}`.toLowerCase() }] : []
      return [...head, ...(p.rows ?? []).map(([label, kw]) => ({ tabId: tab.id, sectionId: p.id, row: label, label: label.replace(/ \(extensions\)$/, ''), where, hay: `${label} ${kw ?? ''} ${p.label} ${tab.label}`.toLowerCase() }))]
    }),
  ]
})

/** Every term must appear; labels that start with the query rank first, then label matches. Sections `s` turns off are left out. */
export function searchSettings(query: string, limit = 12, s?: Settings): SearchHit[] {
  const q = query.trim().toLowerCase()
  const terms = q.split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const score = (i: IndexItem) => {
    const label = i.label.toLowerCase()
    return (label.startsWith(q) ? 0 : label.includes(q) ? 1 : terms.every((t) => label.includes(t)) ? 2 : 3) + (i.row ? 0 : -0.5)
  }
  return INDEX.filter((i) => terms.every((t) => i.hay.includes(t)) && (!s || pageShown(i.sectionId || i.tabId, s)))
    .map((i) => ({ i, s: score(i) }))
    .sort((a, b) => a.s - b.s)
    .slice(0, limit)
    .map(({ i: { hay: _, ...hit } }) => hit)
}
