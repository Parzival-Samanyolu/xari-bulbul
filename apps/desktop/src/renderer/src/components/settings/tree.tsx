import type { ComponentType } from 'react'
import { SHORTCUTS } from '../../lib/shortcuts'
import type { PageProps } from './common'
import type { IconName } from './icons'
import { DesktopPage, LimitsPage, OutputPage, TerminalPage, ToolAccessPage } from './pages/advanced'
import { PluginsPage, SchedulesPage, SessionsPage, UsagePage, VersionPage } from './pages/data'
import { AppearancePage, ChatPage, NotificationsPage, ShortcutsPage, WorkspacePage } from './pages/general'
import { AuxModelsPage, MainModelPage, SubagentsPage } from './pages/model'
import { AccountsPage, ApiKeysPage, CustomEndpointsPage } from './pages/providers'
import { SafetyPage } from './pages/safety'
import { BrowserPage, ContextPage, MemoryPage, PasswordsPage, SpeechToTextPage, VoiceConversationPage } from './pages/system'
import { ExtensionsPage, McpPage, SkillsPage, ToolsListPage, WebSearchPage } from './pages/tools'

// The Settings tree. To add a page: write a component taking PageProps, add an entry here with
// the rows search should find (each label must match a <Row label> or <Section title> on the
// page, since search scrolls to `[data-row="label"]`), and drop `hidden` once it's built.

/** A row search can find: its label, plus extra words people might search for. */
export type RowDef = [label: string, keywords?: string]

export interface PageDef {
  id: string
  label: string
  icon: IconName
  /** One muted line under the breadcrumb. */
  description: string
  rows?: RowDef[]
  page: ComponentType<PageProps>
  /** Built in a later phase: left out of the sidebar and search until then. */
  hidden?: boolean
}

export interface GroupDef {
  id: string
  label: string
  icon: IconName
  children: PageDef[]
}

export type NodeDef = PageDef | GroupDef

export const isGroup = (n: NodeDef): n is GroupDef => 'children' in n

/** A page for a feature that isn't built yet. Hidden, so never shown. */
const Later: ComponentType<PageProps> = () => null

export const TREE: NodeDef[] = [
  {
    id: 'model',
    label: 'Model',
    icon: 'model',
    children: [
      {
        id: 'model.main',
        label: 'Main model',
        icon: 'star',
        description: 'The model new chats start with, and how it generates.',
        page: MainModelPage,
        rows: [['Default model', 'new chats'], ['Reasoning effort', 'thinking'], ['Context window', 'context length tokens override'], ['Temperature'], ['Max output tokens', 'length'], ['Fallback context size', 'ollama'], ['Free models only', 'switcher picker paid'], ['Only models that can use tools', 'switcher picker'], ['Favorites', 'pinned switcher'], ['Per-model overrides', 'speed fast batch replay reasoning']],
      },
      { id: 'model.fallback', label: 'Fallback models', icon: 'reset', description: 'Models the chat moves to when the main model fails.', page: Later, hidden: true },
      {
        id: 'model.aux',
        label: 'Auxiliary models',
        icon: 'sparkle',
        description: 'Models for background work: naming chats, saving memories, summarizing.',
        page: AuxModelsPage,
        rows: [['Chat naming model', 'title'], ['Memory model', 'memory review'], ['Summarization model', 'compaction compact']],
      },
      {
        id: 'model.subagents',
        label: 'Subagents',
        icon: 'subagents',
        description: 'Helpers the agent hands self-contained jobs to, each with a fresh context.',
        page: SubagentsPage,
        rows: [['Allow subagents', 'task tool delegate'], ['Subagent model'], ['Subagents can edit', 'write'], ['Run at once', 'parallel'], ['Max steps per subagent']],
      },
      { id: 'model.moa', label: 'Mixture of Agents', icon: 'subagents', description: 'Several models answer; one combines their answers.', page: Later, hidden: true },
    ],
  },
  {
    id: 'chat',
    label: 'Chat',
    icon: 'chat',
    description: 'How messages are sent and shown, and the instructions every chat gets.',
    page: ChatPage,
    rows: [['Enter sends message', 'send key newline'], ['Show model reasoning', 'thinking'], ['Expand tool calls'], ['Custom instructions', 'prompt'], ['System prompt', 'short lean full'], ['System prompt override']],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'appearance',
    description: 'Layout, theme and type.',
    page: AppearancePage,
    rows: [['Layout', 'basic elite panels terminal'], ['Theme', 'dark light oled sepia contrast'], ['Font size'], ['Interface font', 'typeface'], ['Code font', 'monospace'], ['Density', 'compact']],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    icon: 'workspace',
    description: 'The folders you work in and what the agent reads from them.',
    page: WorkspacePage,
    rows: [['Open folders', 'projects sidebar'], ['Project instruction files', 'AGENTS.md CLAUDE.md'], ['Load project tool code', 'extensions trust']],
  },
  {
    id: 'safety',
    label: 'Safety',
    icon: 'safety',
    description: 'What the agent may do without asking you first.',
    page: SafetyPage,
    rows: [['Default mode', 'permission ask auto plan'], ['Confirm destructive commands', 'rm force push'], ['Allow edits outside the project folder'], ['Always allow', 'rules permissions'], ['Always deny', 'rules permissions block'], ['Hooks', 'pre post tool command'], ['Before a tool runs', 'hook'], ['After a tool runs', 'hook']],
  },
  {
    id: 'browser',
    label: 'Browser',
    icon: 'browser',
    description: 'The browser the agent drives to open, read and click through pages.',
    page: BrowserPage,
    rows: [['Let the agent use a browser', 'chrome edge brave'], ['Hide the browser window', 'headless'], ['Browser path', 'executable']],
  },
  {
    id: 'passwords',
    label: 'Passwords & Logins',
    icon: 'key',
    description: 'Saved keys and tokens, and the browser profile that keeps site logins.',
    page: PasswordsPage,
    rows: [['Saved keys', 'api keys tokens secrets keychain'], ['Keep site logins', 'browser profile cookies'], ['Saved logins', 'sign out cookies delete']],
  },
  {
    id: 'memory',
    label: 'Memory & Context',
    icon: 'memory',
    children: [
      {
        id: 'memory.persistent',
        label: 'Persistent memory',
        icon: 'bookmark',
        description: 'Facts the agent keeps across chats, such as your preferences or how to test a project.',
        page: MemoryPage,
        rows: [['Let the agent remember', 'remember forget'], ['Save facts after each reply', 'memory review automatic'], ['Size limit']],
      },
      {
        id: 'memory.context',
        label: 'Context & compression',
        icon: 'compress',
        description: 'What happens when a chat fills the model’s context window.',
        page: ContextPage,
        rows: [['Auto-compact', 'summarize compaction'], ['Compact at', 'threshold']],
      },
    ],
  },
  {
    id: 'voice',
    label: 'Voice',
    icon: 'voice',
    children: [
      {
        id: 'voice.conversation',
        label: 'Voice conversation',
        icon: 'wave',
        description: 'Dictating messages with the mic button.',
        page: VoiceConversationPage,
        rows: [['Voice input', 'microphone mic dictate'], ['Longest recording', 'length seconds'], ['Send after transcribing', 'auto send']],
      },
      {
        id: 'voice.stt',
        label: 'Speech to text',
        icon: 'text',
        description: 'How recordings become text: on this computer, or through a provider.',
        page: SpeechToTextPage,
        rows: [['Engine', 'voice'], ['Language', 'spoken'], ['Local speech model', 'whisper offline'], ['Transcription model', 'whisper provider']],
      },
      { id: 'voice.tts', label: 'Text to speech', icon: 'voice', description: 'Reading replies aloud.', page: Later, hidden: true },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    icon: 'advanced',
    children: [
      {
        id: 'advanced.desktop',
        label: 'Desktop & startup',
        icon: 'monitor',
        description: 'How the app starts and runs on this computer.',
        page: DesktopPage,
        rows: [['Launch at login', 'startup open'], ['Reopen the last chat', 'resume restore'], ['Keep the computer awake', 'sleep caffeinate'], ['Data folder']],
      },
      {
        id: 'advanced.limits',
        label: 'Agent limits',
        icon: 'gauge',
        description: 'Safety nets for long or stuck turns.',
        page: LimitsPage,
        rows: [['Max steps per message', 'turns loop'], ['Request retries', '429 rate limit'], ['Stall timeout'], ['Batch while planning', 'batch api plan mode']],
      },
      {
        id: 'advanced.tools',
        label: 'Tool access',
        icon: 'toggles',
        description: 'Checks and tools that change how the agent works.',
        page: ToolAccessPage,
        rows: [['Check files after edits', 'lint eslint ruff'], ['Check time limit'], ['Let the agent ask you questions', 'ask_user']],
      },
      {
        id: 'advanced.terminal',
        label: 'Terminal backend',
        icon: 'terminal',
        description: 'The shell the agent runs commands in.',
        page: TerminalPage,
        rows: [['Shell', 'bash zsh powershell'], ['Command timeout', 'bash']],
      },
      {
        id: 'advanced.output',
        label: 'Output limits',
        icon: 'output',
        description: 'How much tool output the model sees.',
        page: OutputPage,
        rows: [['Max tool output', 'truncate characters']],
      },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: 'bell',
    description: 'System notifications about chats running in the background.',
    page: NotificationsPage,
    rows: [['Notify me', 'notifications'], ['Finishes', 'done notification'], ['Stops early', 'error notification'], ['Needs approval', 'permission notification'], ['Has a question', 'notification']],
  },
  {
    id: 'usage',
    label: 'Usage',
    icon: 'usage',
    description: 'Tokens and cost of every request, and spending limits.',
    page: UsagePage,
    rows: [['Show cost', 'status bar price'], ['Show the last request in the status bar', 'tokens'], ['Budgets', 'spending limit'], ['Per-chat budget'], ['Daily budget'], ['When a budget is reached']],
  },
  {
    id: 'providers',
    label: 'Providers',
    icon: 'providers',
    children: [
      { id: 'providers.accounts', label: 'Accounts', icon: 'accounts', description: 'Providers that are connected and ready to use.', page: AccountsPage, rows: [] },
      { id: 'providers.keys', label: 'API keys', icon: 'key', description: 'Paste a key to connect a provider. Keys stay in your system keychain.', page: ApiKeysPage, rows: [] },
      { id: 'providers.custom', label: 'Custom endpoints', icon: 'link', description: 'Local servers and other OpenAI- or Anthropic-compatible APIs.', page: CustomEndpointsPage, rows: [['Quick add', 'ollama lm studio deepseek local'], ['New endpoint', 'add endpoint url']] },
      { id: 'providers.local', label: 'Local models', icon: 'monitor', description: 'Models that run on this computer.', page: Later, hidden: true },
    ],
  },
  { id: 'gateways', label: 'Gateways', icon: 'gateway', description: 'Reach the agent from other apps.', page: Later, hidden: true },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    icon: 'keyboard',
    description: 'Keys for common actions. Most can be changed.',
    page: ShortcutsPage,
    rows: SHORTCUTS.map((s) => [s.label, 'shortcut keys'] as RowDef),
  },
  {
    id: 'tools',
    label: 'Tools & Keys',
    icon: 'tools',
    children: [
      { id: 'tools.list', label: 'Tools', icon: 'tools', description: 'Every tool the agent can call.', page: ToolsListPage, rows: [] },
      { id: 'tools.search', label: 'Web search', icon: 'search', description: 'How the web_search tool searches, and its optional keys.', page: WebSearchPage, rows: [['Search with', 'backend duckduckgo'], ['Brave Search key', 'api'], ['Tavily key', 'api'], ['SearXNG URL']] },
      { id: 'tools.mcp', label: 'MCP servers', icon: 'server', description: 'Tools from Model Context Protocol servers.', page: McpPage, rows: [['Add a server', 'mcp github preset']] },
      { id: 'tools.skills', label: 'Skills & commands', icon: 'book', description: 'Saved instructions the agent loads, and slash commands.', page: SkillsPage, rows: [['Skills', 'SKILL.md'], ['Slash commands', '/']] },
      { id: 'tools.extensions', label: 'Extensions', icon: 'box', description: 'Your own tools and commands, written as files.', page: ExtensionsPage, rows: [['Load my extensions'], ['Load project tool code (extensions)', 'trust']] },
    ],
  },
  { id: 'schedules', label: 'Schedules', icon: 'schedules', description: 'Prompts that run on a timer, each in a new chat, while the app is open.', page: SchedulesPage, rows: [] },
  {
    id: 'sessions',
    label: 'Sessions',
    icon: 'sessions',
    description: "Saved chats: how long they're kept and how the agent can search them.",
    page: SessionsPage,
    rows: [['Delete old chats', 'retention'], ['Search past chats', 'session_search'], ['Chats', 'delete all export']],
  },
  { id: 'plugins', label: 'Plugins', icon: 'plugins', description: 'Reviewed tools and skills for apps on this computer.', page: PluginsPage, rows: [] },
  {
    id: 'about',
    label: 'About',
    icon: 'about',
    children: [
      { id: 'about.version', label: 'Version & updates', icon: 'tag', description: 'Which version you have, and how it updates.', page: VersionPage, rows: [['Version'], ['Check for updates automatically', 'auto update'], ['Source code', 'github license']] },
      { id: 'about.privacy', label: 'Privacy', icon: 'safety', description: 'What the app shares, if anything.', page: Later, hidden: true },
    ],
  },
]

/** The tree without pages that aren't built yet (and groups left empty by that). */
export const VISIBLE: NodeDef[] = TREE.flatMap((n): NodeDef[] => {
  if (!isGroup(n)) return n.hidden ? [] : [n]
  const children = n.children.filter((c) => !c.hidden)
  return children.length ? [{ ...n, children }] : []
})

export interface PageEntry {
  page: PageDef
  group: GroupDef | null
}

export const PAGES: PageEntry[] = VISIBLE.flatMap((n): PageEntry[] => (isGroup(n) ? n.children.map((page) => ({ page, group: n })) : [{ page: n, group: null }]))

export const DEFAULT_PAGE = 'providers.keys'

/** Old tab ids (from links before the overhaul) and group ids → a page. */
const ALIASES: Record<string, string> = {
  providers: 'providers.keys',
  models: 'model.main',
  agent: 'advanced.limits',
  permissions: 'safety',
  hooks: 'safety',
  tools: 'tools.list',
  mcp: 'tools.mcp',
  memory: 'memory.persistent',
  data: 'about.version',
  voice: 'voice.stt',
}

export function resolvePage(id: string | undefined): string {
  if (!id) return DEFAULT_PAGE
  if (PAGES.some((p) => p.page.id === id)) return id
  const alias = ALIASES[id]
  if (alias && PAGES.some((p) => p.page.id === alias)) return alias
  const group = VISIBLE.find((n) => n.id === id)
  if (group && isGroup(group)) return group.children[0].id
  return DEFAULT_PAGE
}

export function pageEntry(id: string): PageEntry {
  return PAGES.find((p) => p.page.id === id) ?? PAGES.find((p) => p.page.id === DEFAULT_PAGE)!
}

export interface SearchHit {
  pageId: string
  /** The row to scroll to; empty for the page itself. */
  row: string
  label: string
  /** Where it lives, e.g. "Model › Main model". */
  where: string
}

interface IndexItem extends SearchHit {
  hay: string
}

const INDEX: IndexItem[] = PAGES.flatMap(({ page, group }) => {
  const where = group ? `${group.label} › ${page.label}` : page.label
  const own: IndexItem = { pageId: page.id, row: '', label: page.label, where: group?.label ?? 'Settings', hay: `${page.label} ${group?.label ?? ''} ${page.description}`.toLowerCase() }
  return [own, ...(page.rows ?? []).map(([label, kw]) => ({ pageId: page.id, row: label, label: label.replace(/ \(extensions\)$/, ''), where, hay: `${label} ${kw ?? ''} ${page.label} ${group?.label ?? ''}`.toLowerCase() }))]
})

/** Every term must appear; labels that start with the query rank first, then label matches. */
export function searchSettings(query: string, limit = 12): SearchHit[] {
  const q = query.trim().toLowerCase()
  const terms = q.split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const score = (i: IndexItem) => {
    const label = i.label.toLowerCase()
    return (label.startsWith(q) ? 0 : label.includes(q) ? 1 : terms.every((t) => label.includes(t)) ? 2 : 3) + (i.row ? 0 : -0.5)
  }
  return INDEX.filter((i) => terms.every((t) => i.hay.includes(t)))
    .map((i) => ({ i, s: score(i) }))
    .sort((a, b) => a.s - b.s)
    .slice(0, limit)
    .map(({ i: { hay: _, ...hit } }) => hit)
}
