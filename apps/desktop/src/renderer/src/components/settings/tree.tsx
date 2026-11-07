import type { ComponentType } from 'react'
import { makeT, type Lang } from '@harness/core/i18n'
import { CATALOGS, searchText, type MessageKey } from '../../../../shared/i18n/catalog'
import type { Settings } from '../../../../shared/ipc'
import { SHORTCUTS } from '../../lib/shortcuts'
import type { PageProps } from './common'
import type { IconName } from './icons'
import { DesktopPage, LimitsPage, OutputPage, TerminalPage, ToolAccessPage } from './pages/advanced'
import { BotsPage } from './pages/bots'
import { IMessagePage, WhatsAppPage } from './pages/gateways'
import { PluginsPage, SchedulesPage, SessionsPage, UsagePage, VersionPage } from './pages/data'
import { AppearancePage, ChatPage, InstructionsPage, NotificationsPage, ShortcutsPage, WorkspacePage, shortcutLabel } from './pages/general'
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
// search should find. Labels are message keys (shared/i18n). Each row label must be the label of
// a <Row> or <Section title> in that component, since search scrolls to `[data-row="label"]`
// inside the section: the label in the current language, else in English, else `dataRow`.

/** A row search can find: its label, extra words people might search for, and its `data-row` when that differs from the label. */
export type RowDef = [label: MessageKey, keywords?: MessageKey, dataRow?: string]

/** A section of a tab. Its id is what `go()` and deep links use to open it. */
export interface PageDef {
  id: string
  label: MessageKey
  /** One muted line under the section heading (or under the breadcrumb when it's the tab's only section). */
  description?: MessageKey
  rows?: RowDef[]
  page: ComponentType<PageProps>
  /** Left out of the tab and search. */
  hidden?: boolean
  /** Shown only while this is true (a section for a feature that can be turned off). */
  when?: (s: Settings) => boolean
}

export interface TabDef {
  id: string
  label: MessageKey
  icon: IconName
  /** One muted line under the breadcrumb. */
  description: MessageKey
  sections: PageDef[]
}

const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || navigator.userAgent)

export const TABS: TabDef[] = [
  {
    id: 'providers',
    label: 'settings.tab.providers',
    icon: 'providers',
    description: 'settings.tab.providers.desc',
    sections: [
      { id: 'providers.accounts', label: 'settings.section.providers.accounts', description: 'settings.section.providers.accounts.desc', page: AccountsPage, rows: [] },
      { id: 'providers.keys', label: 'settings.section.providers.keys', description: 'settings.section.providers.keys.desc', page: ApiKeysPage, rows: [] },
      {
        id: 'providers.custom',
        label: 'settings.section.providers.custom',
        description: 'settings.section.providers.custom.desc',
        page: CustomEndpointsPage,
        rows: [
          ['settings.providers.quickAdd', 'settings.kw.quickAdd'],
          ['settings.providers.newEndpoint', 'settings.kw.newEndpoint'],
        ],
      },
    ],
  },
  {
    id: 'models',
    label: 'settings.tab.models',
    icon: 'model',
    description: 'settings.tab.models.desc',
    sections: [
      {
        id: 'model.main',
        label: 'settings.section.model.main',
        description: 'settings.section.model.main.desc',
        page: MainModelPage,
        rows: [
          ['settings.model.defaultModel', 'settings.kw.defaultModel'],
          ['settings.model.reasoningEffort', 'settings.kw.reasoningEffort'],
          ['settings.model.contextWindow', 'settings.kw.contextWindow'],
          ['settings.model.temperature'],
          ['settings.model.maxOutputTokens', 'settings.kw.maxOutputTokens'],
          ['settings.model.fallbackContext', 'settings.kw.fallbackContext'],
          ['settings.model.freeOnly', 'settings.kw.freeOnly'],
          ['settings.model.toolsOnly', 'settings.kw.switcher'],
          ['settings.model.favorites', 'settings.kw.favorites'],
          ['settings.model.overrides', 'settings.kw.overrides'],
        ],
      },
      {
        id: 'model.aux',
        label: 'settings.section.model.aux',
        description: 'settings.section.model.aux.desc',
        page: AuxModelsPage,
        rows: [
          ['settings.model.titleModel', 'settings.kw.titleModel'],
          ['settings.model.memoryModel', 'settings.kw.memoryModel'],
          ['settings.model.summaryModel', 'settings.kw.summaryModel'],
        ],
      },
      {
        id: 'model.fallback',
        label: 'settings.section.model.fallback',
        description: 'settings.section.model.fallback.desc',
        page: FallbackPage,
        rows: [
          ['settings.fallback.models', 'settings.kw.fallbackModels'],
          ['settings.fallback.order', 'settings.kw.fallbackOrder'],
          ['settings.fallback.noSwitch', 'settings.kw.noSwitch'],
        ],
      },
      {
        id: 'model.moa',
        label: 'settings.section.model.moa',
        description: 'settings.section.model.moa.desc',
        page: MoaPage,
        rows: [
          ['settings.moa.title', 'settings.kw.moa'],
          ['settings.moa.onByDefault', 'settings.kw.moaDefault'],
          ['settings.moa.proposers', 'settings.kw.proposers'],
          ['settings.moa.aggregator', 'settings.kw.aggregator'],
          ['settings.moa.cost', 'settings.kw.moaCost'],
        ],
      },
      {
        id: 'providers.local',
        label: 'settings.section.providers.local',
        description: 'settings.section.providers.local.desc',
        page: LocalModelsPage,
        rows: [
          ['settings.local.runtime', 'settings.kw.runtime'],
          ['settings.local.machine', 'settings.kw.machine'],
          ['settings.local.gpuMemory', 'settings.kw.gpuMemory'],
          ['settings.local.ram', 'settings.kw.ram'],
          ['settings.local.models', 'settings.kw.localModels'],
          ['settings.local.findMore', 'settings.kw.findMore'],
        ],
      },
    ],
  },
  {
    id: 'agent',
    label: 'settings.tab.agent',
    icon: 'advanced',
    description: 'settings.tab.agent.desc',
    sections: [
      {
        id: 'agent.instructions',
        label: 'settings.section.agent.instructions',
        description: 'settings.section.agent.instructions.desc',
        page: InstructionsPage,
        rows: [['settings.instructions.custom', 'settings.kw.customInstructions'], ['settings.instructions.systemPrompt', 'settings.kw.systemPrompt'], ['settings.instructions.override']],
      },
      {
        id: 'advanced.limits',
        label: 'settings.section.advanced.limits',
        description: 'settings.section.advanced.limits.desc',
        page: LimitsPage,
        rows: [['settings.advanced.maxSteps', 'settings.kw.maxSteps'], ['settings.advanced.retries', 'settings.kw.retries'], ['settings.advanced.stallTimeout'], ['settings.advanced.batchPlanning', 'settings.kw.batchPlan']],
      },
      {
        id: 'model.subagents',
        label: 'settings.section.model.subagents',
        description: 'settings.section.model.subagents.desc',
        page: SubagentsPage,
        rows: [
          ['settings.subagents.allow', 'settings.kw.subagentsAllow'],
          ['settings.subagents.model'],
          ['settings.subagents.canEdit', 'settings.kw.subagentsEdit'],
          ['settings.subagents.parallel', 'settings.kw.subagentsParallel'],
          ['settings.subagents.maxSteps'],
        ],
      },
      {
        id: 'memory.context',
        label: 'settings.section.memory.context',
        description: 'settings.section.memory.context.desc',
        page: ContextPage,
        rows: [['settings.system.autoCompact', 'settings.kw.autoCompact'], ['settings.system.compactAt', 'settings.kw.compactAt']],
      },
      { id: 'advanced.output', label: 'settings.section.advanced.output', description: 'settings.section.advanced.output.desc', page: OutputPage, rows: [['settings.advanced.maxToolOutput', 'settings.kw.toolOutput']] },
      {
        id: 'advanced.terminal',
        label: 'settings.section.advanced.terminal',
        description: 'settings.section.advanced.terminal.desc',
        page: TerminalPage,
        rows: [['settings.advanced.shell', 'settings.kw.shell'], ['settings.advanced.commandTimeout', 'settings.kw.commandTimeout']],
      },
      {
        id: 'browser',
        label: 'settings.section.browser',
        description: 'settings.section.browser.desc',
        page: BrowserPage,
        rows: [['settings.system.useBrowser', 'settings.kw.browserUse'], ['settings.system.hideBrowser', 'settings.kw.browserHide'], ['settings.system.browserPath', 'settings.kw.browserPath']],
      },
      {
        id: 'voice.conversation',
        label: 'settings.section.voice.conversation',
        description: 'settings.section.voice.conversation.desc',
        page: VoiceConversationPage,
        rows: [['settings.system.voiceInput', 'settings.kw.voiceInput'], ['settings.system.longestRecording', 'settings.kw.longest'], ['settings.system.autoSend', 'settings.kw.autoSend']],
      },
      {
        id: 'voice.stt',
        label: 'settings.section.voice.stt',
        description: 'settings.section.voice.stt.desc',
        page: SpeechToTextPage,
        rows: [['settings.system.engine', 'settings.kw.sttEngine'], ['settings.system.language', 'settings.kw.sttLanguage'], ['settings.system.localSpeechModel', 'settings.kw.sttLocal'], ['settings.system.transcriptionModel', 'settings.kw.sttModel']],
      },
      {
        id: 'voice.tts',
        label: 'settings.section.voice.tts',
        description: 'settings.section.voice.tts.desc',
        page: TextToSpeechPage,
        rows: [
          ['settings.tts.provider', 'settings.kw.ttsProvider'],
          ['settings.tts.voice', 'settings.kw.ttsVoice'],
          ['settings.tts.speed', 'settings.kw.ttsSpeed'],
          ['settings.tts.readAloud', 'settings.kw.readAloud'],
          ['settings.tts.test', 'settings.kw.ttsTest'],
        ],
      },
    ],
  },
  {
    id: 'permissions',
    label: 'settings.tab.permissions',
    icon: 'safety',
    description: 'settings.tab.permissions.desc',
    sections: [
      {
        id: 'safety',
        label: 'settings.section.safety',
        description: 'settings.section.safety.desc',
        page: SafetyPage,
        rows: [
          ['settings.safety.defaultMode', 'settings.kw.safetyMode'],
          ['settings.safety.confirmDestructive', 'settings.kw.destructive'],
          ['settings.safety.allowOutside'],
          ['settings.safety.alwaysAllow', 'settings.kw.rules'],
          ['settings.safety.alwaysDeny', 'settings.kw.denyRules'],
        ],
      },
      {
        id: 'passwords',
        label: 'settings.section.passwords',
        description: 'settings.section.passwords.desc',
        page: PasswordsPage,
        rows: [['settings.system.savedKeys', 'settings.kw.savedKeys'], ['settings.system.keepLogins', 'settings.kw.keepLogins'], ['settings.system.savedLogins', 'settings.kw.savedLogins']],
      },
    ],
  },
  {
    id: 'hooks',
    label: 'settings.tab.hooks',
    icon: 'terminal',
    description: 'settings.tab.hooks.desc',
    sections: [{ id: 'hooks', label: 'settings.section.hooks', page: HooksPage, rows: [['settings.safety.beforeTool', 'settings.kw.hookBefore'], ['settings.safety.afterTool', 'settings.kw.hookAfter']] }],
  },
  {
    id: 'tools',
    label: 'settings.tab.tools',
    icon: 'tools',
    description: 'settings.tab.tools.desc',
    sections: [
      { id: 'tools.list', label: 'settings.section.tools.list', description: 'settings.section.tools.list.desc', page: ToolsListPage, rows: [] },
      {
        id: 'advanced.tools',
        label: 'settings.section.advanced.tools',
        description: 'settings.section.advanced.tools.desc',
        page: ToolAccessPage,
        rows: [['settings.advanced.checkAfterEdit', 'settings.kw.lint'], ['settings.advanced.checkTimeLimit'], ['settings.advanced.askUser', 'settings.kw.askUser']],
      },
      {
        id: 'tools.search',
        label: 'settings.section.tools.search',
        description: 'settings.section.tools.search.desc',
        page: WebSearchPage,
        rows: [['settings.tools.searchWith', 'settings.kw.searchWith'], ['settings.tools.braveKey', 'settings.kw.searchKey'], ['settings.tools.tavilyKey', 'settings.kw.searchKey'], ['settings.tools.searxngUrl']],
      },
      { id: 'tools.skills', label: 'settings.section.tools.skills', description: 'settings.section.tools.skills.desc', page: SkillsPage, rows: [['settings.tools.skills', 'settings.kw.skills'], ['settings.tools.slashCommands', 'settings.kw.slash']] },
      {
        id: 'tools.extensions',
        label: 'settings.section.tools.extensions',
        description: 'settings.section.tools.extensions.desc',
        page: ExtensionsPage,
        rows: [['settings.tools.loadMine'], ['settings.tools.loadProject', 'settings.kw.trust', 'Load project tool code (extensions)']],
      },
    ],
  },
  {
    id: 'mcp',
    label: 'settings.tab.mcp',
    icon: 'server',
    description: 'settings.tab.mcp.desc',
    sections: [{ id: 'tools.mcp', label: 'settings.section.tools.mcp', page: McpPage, rows: [['settings.tools.addServer', 'settings.kw.mcpAdd']] }],
  },
  {
    id: 'plugins',
    label: 'settings.tab.plugins',
    icon: 'plugins',
    description: 'settings.tab.plugins.desc',
    sections: [{ id: 'plugins', label: 'settings.section.plugins', page: PluginsPage, rows: [] }],
  },
  {
    id: 'schedules',
    label: 'settings.tab.schedules',
    icon: 'schedules',
    description: 'settings.tab.schedules.desc',
    sections: [{ id: 'schedules', label: 'settings.section.schedules', page: SchedulesPage, rows: [] }],
  },
  {
    id: 'memory',
    label: 'settings.tab.memory',
    icon: 'memory',
    description: 'settings.tab.memory.desc',
    sections: [
      {
        id: 'memory.persistent',
        label: 'settings.section.memory.persistent',
        page: MemoryPage,
        rows: [['settings.system.remember', 'settings.kw.remember'], ['settings.system.autoReview', 'settings.kw.memoryReview'], ['settings.system.sizeLimit']],
      },
    ],
  },
  {
    id: 'usage',
    label: 'settings.tab.usage',
    icon: 'usage',
    description: 'settings.tab.usage.desc',
    sections: [
      {
        id: 'usage',
        label: 'settings.section.usage',
        page: UsagePage,
        rows: [
          ['settings.data.showCost', 'settings.kw.showCost'],
          ['settings.data.showLastRequest', 'settings.kw.lastRequest'],
          ['settings.data.budgets', 'settings.kw.budgets'],
          ['settings.data.chatBudget'],
          ['settings.data.dailyBudget'],
          ['settings.data.budgetReached'],
        ],
      },
    ],
  },
  {
    id: 'appearance',
    label: 'settings.tab.appearance',
    icon: 'appearance',
    description: 'settings.tab.appearance.desc',
    sections: [
      {
        id: 'appearance',
        label: 'settings.section.appearance',
        description: 'settings.section.appearance.desc',
        page: AppearancePage,
        rows: [
          ['settings.general.layout', 'settings.kw.layout'],
          ['settings.general.language', 'settings.kw.language'],
          ['settings.general.theme', 'settings.kw.theme'],
          ['settings.general.fontSize'],
          ['settings.general.uiFont', 'settings.kw.uiFont'],
          ['settings.general.codeFont', 'settings.kw.codeFont'],
          ['settings.general.density', 'settings.kw.density'],
        ],
      },
      {
        id: 'chat',
        label: 'settings.section.chat',
        description: 'settings.section.chat.desc',
        page: ChatPage,
        rows: [['settings.chat.enterSends', 'settings.kw.enterSends'], ['settings.chat.showReasoning', 'settings.kw.showReasoning'], ['settings.chat.expandTools']],
      },
      {
        id: 'workspace',
        label: 'settings.section.workspace',
        description: 'settings.section.workspace.desc',
        page: WorkspacePage,
        rows: [
          ['settings.workspace.openFolders', 'settings.kw.openFolders'],
          ['settings.workspace.instructionFiles', 'settings.kw.instructionFiles'],
          ['settings.workspace.loadProjectCode', 'settings.kw.projectCode'],
        ],
      },
      {
        id: 'notifications',
        label: 'settings.section.notifications',
        description: 'settings.section.notifications.desc',
        page: NotificationsPage,
        rows: [
          ['settings.notify.notifyMe', 'settings.kw.notify'],
          ['settings.notify.finishes', 'settings.kw.notifyDone'],
          ['settings.notify.stopsEarly', 'settings.kw.notifyError'],
          ['settings.notify.needsApproval', 'settings.kw.notifyApproval'],
          ['settings.notify.hasQuestion', 'settings.kw.notify'],
        ],
      },
      { id: 'shortcuts', label: 'settings.section.shortcuts', description: 'settings.section.shortcuts.desc', page: ShortcutsPage, rows: SHORTCUTS.map((s): RowDef => [shortcutLabel(s.id), 'settings.kw.shortcuts']) },
      {
        id: 'advanced.desktop',
        label: 'settings.section.advanced.desktop',
        description: 'settings.section.advanced.desktop.desc',
        page: DesktopPage,
        rows: [['settings.advanced.launchAtLogin', 'settings.kw.login'], ['settings.advanced.reopenLastChat', 'settings.kw.reopen'], ['settings.advanced.keepAwake', 'settings.kw.awake'], ['settings.advanced.dataFolder']],
      },
    ],
  },
  {
    id: 'data',
    label: 'settings.tab.data',
    icon: 'about',
    description: 'settings.tab.data.desc',
    sections: [
      {
        id: 'sessions',
        label: 'settings.section.sessions',
        description: 'settings.section.sessions.desc',
        page: SessionsPage,
        rows: [['settings.data.deleteOldChats', 'settings.kw.retention'], ['settings.data.searchPastChats', 'settings.kw.sessionSearch'], ['settings.data.storedChats', 'settings.kw.chats'], ['settings.data.chats', 'settings.kw.chats']],
      },
      {
        id: 'profile',
        label: 'settings.section.profile',
        description: 'settings.section.profile.desc',
        page: ProfilePage,
        rows: [
          ['settings.profile.name', 'settings.kw.profileName'],
          ['settings.profile.role', 'settings.kw.role'],
          ['settings.profile.experience', 'settings.kw.experience'],
          ['settings.profile.uses', 'settings.kw.uses'],
          ['settings.profile.replyLanguage', 'settings.kw.replyLanguage'],
        ],
      },
      { id: 'about.privacy', label: 'settings.section.about.privacy', description: 'settings.section.about.privacy.desc', page: PrivacyPage, rows: [['settings.privacy.share', 'settings.kw.share']] },
      {
        id: 'about.version',
        label: 'settings.section.about.version',
        description: 'settings.section.about.version.desc',
        page: VersionPage,
        rows: [['settings.data.version', 'settings.kw.version'], ['settings.data.autoUpdate', 'settings.kw.autoUpdate'], ['settings.data.sourceCode', 'settings.kw.source']],
      },
    ],
  },
  {
    id: 'gateways',
    label: 'settings.tab.gateways',
    icon: 'gateway',
    description: 'settings.tab.gateways.desc',
    sections: [
      {
        id: 'gateways.imessage',
        label: 'settings.section.gateways.imessage',
        description: 'settings.section.gateways.imessage.desc',
        page: IMessagePage,
        // Messages and its database exist only on macOS.
        hidden: !MAC,
        rows: [
          ['settings.gateways.imReceive', 'settings.kw.imessage'],
          ['settings.gateways.allowedSenders', 'settings.kw.senders'],
          ['settings.gateways.folder', 'settings.kw.imessageFolder'],
          ['settings.gateways.permissionMode', 'settings.kw.imessageMode'],
          ['settings.gateways.pollEvery', 'settings.kw.poll'],
          ['settings.gateways.sendTest', 'settings.kw.imessageTest'],
        ],
      },
      {
        id: 'gateways.whatsapp',
        label: 'settings.section.gateways.whatsapp',
        description: 'settings.section.gateways.whatsapp.desc',
        page: WhatsAppPage,
        rows: [
          ['settings.gateways.useWhatsApp', 'settings.kw.whatsapp'],
          ['settings.gateways.folder', 'settings.kw.whatsappFolder'],
          ['settings.gateways.permissionMode', 'settings.kw.whatsappMode'],
          ['settings.gateways.replyPrefix', 'settings.kw.prefix'],
        ],
      },
    ],
  },
  {
    id: 'bots',
    label: 'settings.tab.bots',
    icon: 'bot',
    description: 'settings.tab.bots.desc',
    sections: [
      {
        id: 'bots',
        label: 'settings.section.bots',
        page: BotsPage,
        rows: [['settings.bots.showTab', 'settings.kw.botsTab'], ['settings.bots.mute', 'settings.kw.botsMute'], ['settings.bots.yourBots', 'settings.kw.yourBots']],
      },
    ],
  },
  {
    id: 'logs',
    label: 'settings.tab.logs',
    icon: 'gauge',
    description: 'settings.tab.logs.desc',
    sections: [
      {
        id: 'logs.performance',
        label: 'settings.section.logs.performance',
        description: 'settings.section.logs.performance.desc',
        page: ResourcesPage,
        rows: [
          ['settings.logs.showResources', 'settings.kw.resourceStatus'],
          ['settings.logs.appMemory', 'settings.kw.appMemory'],
          ['settings.logs.graphics', 'settings.kw.graphics'],
          ['settings.logs.processes', 'settings.kw.processes'],
        ],
      },
      { id: 'logs.app', label: 'settings.section.logs.app', description: 'settings.section.logs.app.desc', page: AppLogPage, rows: [['settings.row.log.log', 'settings.kw.log']] },
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
  /** `data-row` values of the row to scroll to, tried in order; empty for the section or tab itself. */
  rows: string[]
  label: string
  /** Where it lives, e.g. "Models › Main model". */
  where: string
}

interface IndexItem extends SearchHit {
  hay: string
}

/** Lowercase without accents, so "sifre" finds "Şifrə" and "ежик" finds "ёжик". Turkish İ, I and ı all become i; Azerbaijani ə becomes e. */
export const fold = (s: string) =>
  s
    .replace(/[İIı]/g, 'i')
    .replace(/[əƏ]/g, 'e')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')

const indexes = new Map<Lang, IndexItem[]>()

/** The search index in one language. Each entry also matches its English words (`searchText`). */
function indexFor(lang: Lang): IndexItem[] {
  const cached = indexes.get(lang)
  if (cached) return cached
  const t = makeT<MessageKey>(lang, CATALOGS)
  const en = makeT<MessageKey>('en', CATALOGS)
  const hay = (keys: (MessageKey | undefined)[]) => fold(searchText(keys.filter((k): k is MessageKey => !!k), lang))
  const index = VISIBLE.flatMap((tab): IndexItem[] => {
    const own: IndexItem = { tabId: tab.id, sectionId: '', rows: [], label: t(tab.label), where: t('settings.title'), hay: hay([tab.label, tab.description]) }
    const many = tab.sections.length > 1
    return [
      own,
      ...tab.sections.flatMap((p) => {
        const where = many ? `${t(tab.label)} › ${t(p.label)}` : t(tab.label)
        const head: IndexItem[] = many ? [{ tabId: tab.id, sectionId: p.id, rows: [], label: t(p.label), where: t(tab.label), hay: hay([p.label, tab.label, p.description]) }] : []
        const rows = (p.rows ?? []).map(
          ([label, kw, dataRow]): IndexItem => ({
            tabId: tab.id,
            sectionId: p.id,
            rows: [...new Set([t(label), en(label), ...(dataRow ? [dataRow] : [])])],
            label: t(label),
            where,
            hay: hay([label, kw, p.label, tab.label]),
          }),
        )
        return [...head, ...rows]
      }),
    ]
  })
  indexes.set(lang, index)
  return index
}

/** Every term must appear, in `lang` or in English; labels that start with the query rank first, then label matches. Sections `s` turns off are left out. */
export function searchSettings(query: string, lang: Lang, limit = 12, s?: Settings): SearchHit[] {
  const q = fold(query.trim())
  const terms = q.split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const score = (i: IndexItem) => {
    const label = fold(i.label)
    return (label.startsWith(q) ? 0 : label.includes(q) ? 1 : terms.every((t) => label.includes(t)) ? 2 : 3) + (i.rows.length ? 0 : -0.5)
  }
  return indexFor(lang)
    .filter((i) => terms.every((t) => i.hay.includes(t)) && (!s || pageShown(i.sectionId || i.tabId, s)))
    .map((i) => ({ i, s: score(i) }))
    .sort((a, b) => a.s - b.s)
    .slice(0, limit)
    .map(({ i: { hay: _, ...hit } }) => hit)
}
