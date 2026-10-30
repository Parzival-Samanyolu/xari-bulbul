import { z } from 'zod'
import { EFFORT_LEVELS } from '../providers/effort.js'
import { PROFILE_EXPERIENCE, PROFILE_ROLES, PROFILE_USES } from './profile.js'

export { PROFILE_EXPERIENCE, PROFILE_ROLES, PROFILE_USES } from './profile.js'

// Every user-facing setting lives here, with defaults. Secrets (API keys) are NOT
// part of settings; hosts store them separately (desktop: OS-encrypted via safeStorage).

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  enabled: z.boolean().default(true),
  /** Extra headers sent with every request (e.g. OpenRouter attribution). */
  headers: z.record(z.string(), z.string()).default({}),
  /** Ask the provider to report cost inside `usage` (OpenRouter supports this). */
  requestUsageCost: z.boolean().default(false),
  /** Local servers (Ollama, LM Studio, vLLM) usually need no key. */
  requiresKey: z.boolean().default(true),
  /** Wire protocol: OpenAI chat completions, or Anthropic's Messages API. */
  api: z.enum(['openai', 'anthropic']).default('openai'),
})
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    enabled: true,
    headers: { 'HTTP-Referer': 'https://github.com/Parzival-Samanyolu/xari-bulbul', 'X-Title': 'Xari Bulbul' },
    requestUsageCost: true,
    requiresKey: true,
    api: 'openai',
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    enabled: true,
    headers: {},
    requestUsageCost: false,
    requiresKey: true,
    api: 'openai',
  },
  {
    id: 'google',
    name: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    enabled: true,
    headers: {},
    requestUsageCost: false,
    requiresKey: true,
    api: 'openai',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    enabled: true,
    headers: {},
    requestUsageCost: false,
    requiresKey: true,
    api: 'anthropic',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    headers: {},
    requestUsageCost: false,
    requiresKey: true,
    api: 'openai',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    enabled: true,
    headers: {},
    requestUsageCost: false,
    requiresKey: true,
    api: 'openai',
  },
  {
    id: 'xai',
    name: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    enabled: true,
    headers: {},
    requestUsageCost: false,
    requiresKey: true,
    api: 'openai',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    enabled: true,
    headers: {},
    requestUsageCost: false,
    requiresKey: true,
    api: 'openai',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    enabled: true,
    headers: {},
    requestUsageCost: false,
    requiresKey: true,
    api: 'openai',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    enabled: true,
    headers: {},
    requestUsageCost: false,
    requiresKey: true,
    api: 'openai',
  },
  {
    id: 'zai',
    name: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    enabled: true,
    headers: {},
    requestUsageCost: false,
    requiresKey: true,
    api: 'openai',
  },
]

/** One-click presets for common OpenAI-compatible servers. */
export const PROVIDER_PRESETS: Omit<ProviderConfig, 'enabled' | 'headers' | 'requestUsageCost' | 'api'>[] = [
  { id: 'ollama-local', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', requiresKey: false },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', requiresKey: false },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', requiresKey: true },
]

/** Google's native API root 404s for OpenAI-style requests; only its `/v1beta/openai` path speaks that protocol. */
function fixGoogleUrl(p: ProviderConfig): ProviderConfig {
  const google = 'https://generativelanguage.googleapis.com'
  return p.baseUrl.startsWith(google) && !/\/openai\/?$/.test(p.baseUrl) ? { ...p, baseUrl: `${google}/v1beta/openai` } : p
}

/** Guess the wire protocol of an endpoint from its URL: Anthropic's Messages API, else OpenAI chat completions. */
export function guessProviderApi(baseUrl: string): ProviderConfig['api'] {
  return /anthropic|\/messages\/?$/i.test(baseUrl) ? 'anthropic' : 'openai'
}

/** A provider can be used when it's enabled and either has a key or doesn't need one. */
export function providerReady(config: ProviderConfig | undefined, hasKey: boolean): boolean {
  return !!config && config.enabled && (hasKey || !config.requiresKey)
}

const McpBase = {
  /** Stable id; also where a bearer token is stored (secret key `mcp:<id>`). */
  id: z.string().min(1),
  /** Shown in the UI and used in tool names (`mcp__<name>__<tool>`). */
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Set for servers a plugin added; removing the plugin removes them. */
  plugin: z.string().optional(),
}

export const McpServerSchema = z.discriminatedUnion('transport', [
  z.object({
    ...McpBase,
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    ...McpBase,
    transport: z.literal('http'),
    url: z.string().url(),
    /** Non-secret headers. A bearer token is stored with the API keys instead. */
    headers: z.record(z.string(), z.string()).default({}),
  }),
])
export type McpServerConfig = z.infer<typeof McpServerSchema>

const ModelRefSchema = z.object({ providerId: z.string(), modelId: z.string() })

export const ModelOverrideSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoningEffort: z.enum(EFFORT_LEVELS).optional(),
  /** fast = the provider's fast option (Anthropic fast mode, OpenAI priority, OpenRouter throughput). batch = its Batch API. */
  speed: z.enum(['standard', 'fast', 'batch']).optional(),
  contextLength: z.number().int().positive().optional(),
  /** Send reasoning back on the current tool loop's assistant messages. Unset = on, except api.openai.com. */
  replayReasoning: z.boolean().optional(),
  /** Unset = the agent setting. */
  promptStyle: z.enum(['full', 'lean']).optional(),
})

/** A shell command run before or after tool calls whose subject matches `match` (permission-rule syntax). */
export const HookRuleSchema = z.object({
  match: z.string().min(1),
  command: z.string().min(1),
  timeoutSec: z.number().int().min(1).max(600).default(30),
  enabled: z.boolean().default(true),
})
export type HookRule = z.infer<typeof HookRuleSchema>

/** A prompt run in a new chat on a timer, while the app is open. Run times live in `<data>/schedules.json`. */
export const ScheduleSchema = z.object({
  id: z.string().min(1),
  name: z.string().default('Schedule'),
  enabled: z.boolean().default(true),
  /** Folder the chat runs in. */
  cwd: z.string().default(''),
  prompt: z.string().default(''),
  when: z
    .object({
      kind: z.enum(['daily', 'weekly', 'interval']).default('daily'),
      /** "HH:MM", local time (daily, weekly). Not validated here so one bad value can't drop every schedule. */
      time: z.string().default('09:00'),
      /** 0 = Sunday … 6 = Saturday (weekly). */
      weekday: z.number().int().min(0).max(6).default(1),
      /** Hours between runs (interval). */
      hours: z.number().positive().default(24),
    })
    .prefault({}),
  /** null = the default model. */
  model: ModelRefSchema.nullable().default(null),
})
export type Schedule = z.infer<typeof ScheduleSchema>

const PERMISSION_MODES = ['ask', 'acceptEdits', 'plan', 'auto'] as const

/**
 * A saved agent with its own personality (Settings › Bots, behind `experimental.bots`). The persona
 * changes tone and focus only; safety, permission and tool rules stay as they are.
 */
export const BotSchema = z.object({
  /** Stable id; also names the bot's own memory file (`<data>/memory/bots/<id>.md`). */
  id: z.string().min(1),
  /** A turned-off bot leaves the sidebar; its chats open as plain chats with a note. */
  enabled: z.boolean().default(true),
  name: z.string().default('Bot'),
  /** An emoji (or a few letters), or the path of an image in `<data>/bots/`. */
  avatar: z.string().default('🤖'),
  /** CSS color for the avatar and the chat header. */
  color: z.string().default('#9b4d6e'),
  tagline: z.string().default(''),
  /** Instructions added to the system prompt after the identity section. */
  persona: z.string().default(''),
  /** Shown as the bot's first message in a new chat; never sent to the model. */
  greeting: z.string().optional(),
  /** Unset = the default model. */
  model: ModelRefSchema.optional(),
  /** Unset = the model's own thinking setting. */
  thinking: z.enum(EFFORT_LEVELS).optional(),
  /** The permission mode its chats start in. Unset = the current mode. */
  mode: z.enum(PERMISSION_MODES).optional(),
  /** Tool names it may use ('all', or a list; a trailing * matches a prefix such as mcp__github__*). Memory and skill tools follow `memory` and `skills`. */
  tools: z.union([z.literal('all'), z.array(z.string())]).default('all'),
  /** Skill names it may load. Unset = every skill. */
  skills: z.array(z.string()).optional(),
  /** shared: the usual memories. own: also a memory only this bot sees. off: no memory. */
  memory: z.enum(['shared', 'own', 'off']).default('shared'),
})
export type Bot = z.infer<typeof BotSchema>

/** Read-only work tools for the starter bots that don't edit. */
const LOOK_TOOLS = ['read_file', 'list_dir', 'glob', 'grep', 'web_search', 'web_fetch', 'browser_read', 'session_search', 'todo_write']

/** Bots new installs start with; the user can edit or delete them. */
export const STARTER_BOTS: Bot[] = [
  {
    id: 'reviewer',
    enabled: true,
    name: 'Reviewer',
    avatar: '🔍',
    color: '#9b4d6e',
    tagline: 'Terse code review, read-only',
    persona:
      'You review code. Be terse. Lead with what matters most: bugs, security holes, data loss and broken edge cases, then correctness and clarity. Give each finding as path:line, the problem, and the fix in a sentence. Skip praise, and skip style nits unless asked. If the code is fine, say so in one line.',
    greeting: 'Point me at a change, a file or a folder and I will review it.',
    mode: 'plan',
    tools: [...LOOK_TOOLS, 'task'],
    memory: 'shared',
  },
  {
    id: 'explainer',
    enabled: true,
    name: 'Explainer',
    avatar: '📖',
    color: '#3d7a8c',
    tagline: 'Patient, teaches, makes no edits',
    persona:
      'You teach. Explain how the code works and why it was written that way, at the level the user shows. Start with the big picture, then go into detail, with short examples from this project and path:line references. Define terms the first time you use them. Check understanding with a question when a topic is hard. You do not edit files or run commands; if asked to change something, explain how the user could do it.',
    greeting: 'Ask me how anything in this project works, and I will walk you through it.',
    tools: [...LOOK_TOOLS, 'ask_user'],
    memory: 'shared',
  },
  {
    id: 'shipper',
    enabled: true,
    name: 'Shipper',
    avatar: '🚀',
    color: '#5a7d3a',
    tagline: 'Auto mode, gets things done',
    persona:
      'You get things done. Pick the simplest approach that works and start right away. Work in small steps and check each one with the tests or the build. Ask only when a choice is truly the user\'s to make. Finish with what you changed and how you checked it, in a few lines.',
    greeting: 'What should we ship? Tell me the task and I will take it from here.',
    mode: 'auto',
    tools: 'all',
    memory: 'shared',
  },
]

export const SettingsSchema = z.object({
  providers: z
    .array(ProviderConfigSchema)
    .default(BUILTIN_PROVIDERS)
    // Saved settings predate newer built-ins; add any that are missing (built-ins can't be removed).
    .transform((list) => [...list.map(fixGoogleUrl), ...BUILTIN_PROVIDERS.filter((b) => !list.some((p) => p.id === b.id))]),

  models: z
    .object({
      // OpenRouter's free router: picks an available free model for each request.
      default: ModelRefSchema.default({ providerId: 'openrouter', modelId: 'openrouter/free' }),
      /** Model used to summarize old turns. Empty = use the active model. */
      compaction: ModelRefSchema.nullable().default(null),
      /** Model that names new chats after the first message. Empty = keep the first line as the title. */
      title: ModelRefSchema.nullable().default(null),
      /** Model that saves durable facts to memory after each turn. Empty = use the title model; neither = off. */
      memoryReview: ModelRefSchema.nullable().default(null),
      /** Speech-to-text model for the composer's mic button (an OpenAI-style `/audio/transcriptions` endpoint). Empty = off. */
      transcription: ModelRefSchema.nullable().default(null),
      /** Tried in order when the chat's model fails after its retries (rate limit, outage, not found, no key). */
      fallbacks: z.array(ModelRefSchema).default([]),
      favorites: z.array(ModelRefSchema).default([]),
      /** Most recently used models, newest first (maintained automatically). */
      recent: z.array(ModelRefSchema).default([]),
      picker: z
        .object({
          /** Hide paid models from providers that report pricing. */
          freeOnly: z.boolean().default(true),
          toolsOnly: z.boolean().default(true),
          sort: z.enum(['newest', 'name', 'context', 'price']).default('newest'),
          /** Provider groups folded shut in the model switcher. */
          collapsed: z.array(z.string()).default([]),
        })
        .prefault({}),
      /** Per-model overrides keyed by `${providerId}:${modelId}`. */
      overrides: z.record(z.string(), ModelOverrideSchema).default({}),
      temperature: z.number().min(0).max(2).nullable().default(null),
      maxTokens: z.number().int().positive().nullable().default(null),
      reasoningEffort: z.enum(EFFORT_LEVELS).nullable().default(null),
      /** Fallback context size when a provider doesn't report one. */
      defaultContextLength: z.number().int().positive().default(128_000),
    })
    .prefault({}),

  /** Mixture of Agents: several models answer, one combines their answers into the reply. */
  moa: z
    .object({
      /** On for chats that haven't set it themselves (the composer toggle). Only works once configured. */
      enabled: z.boolean().default(false),
      /** 2 to 4 models that answer in parallel, text only. */
      proposers: z
        .array(ModelRefSchema)
        .default([])
        .transform((l) => l.slice(0, 4)),
      /** Writes the reply from the proposals. */
      aggregator: ModelRefSchema.nullable().default(null),
      /** final: only the turn's final answer is mixed; tool steps run on the chat's model. */
      mode: z.enum(['final']).default('final'),
    })
    .prefault({}),

  agent: z
    .object({
      maxStepsPerTurn: z.number().int().min(1).max(1000).default(200),
      /** In Plan mode, send model steps through the provider's Batch API (about half price, slower). */
      batchInPlanMode: z.boolean().default(false),
      /** lean: a short system prompt that small models follow better. auto = lean for free models. */
      promptStyle: z.enum(['auto', 'full', 'lean']).default('auto'),
      customInstructions: z.string().default(''),
      /** Replace the built-in system prompt entirely (advanced). */
      systemPromptOverride: z.string().default(''),
      compactionEnabled: z.boolean().default(true),
      compactionThreshold: z.number().min(0.3).max(0.98).default(0.8),
      toolOutputMaxChars: z.number().int().min(1000).default(30_000),
      bashTimeoutSec: z.number().int().min(1).max(3600).default(120),
      /** Empty = platform default: /bin/bash; on Windows Git Bash, else PowerShell 7, else Windows PowerShell. */
      shell: z.string().default(''),
      projectInstructionFiles: z.array(z.string()).default(['AGENTS.md', 'HARNESS.md', 'CLAUDE.md']),
      requestRetries: z.number().int().min(0).max(10).default(3),
      /** Stop waiting when a hosted provider sends nothing for this long. 0 = wait forever. */
      stallTimeoutSec: z.number().int().min(0).max(3600).default(90),
      subagents: z
        .object({
          /** Gives the agent the `task` tool. */
          enabled: z.boolean().default(true),
          /** null = the chat's own model. A cheaper or free model is a good fit for searching. */
          model: ModelRefSchema.nullable().default(null),
          maxSteps: z.number().int().min(1).max(500).default(50),
          /** How many subagents may run at the same time. */
          maxParallel: z.number().int().min(1).max(8).default(3),
          /** Allow "general" subagents that edit and run commands (still subject to permissions). */
          allowWrite: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),

  permissions: z
    .object({
      mode: z.enum(['ask', 'acceptEdits', 'plan', 'auto']).default('ask'),
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default(['bash(rm -rf /*)']),
      allowOutsideWorkspace: z.boolean().default(false),
      /** Ask before deleting files or discarding git history, even in auto mode. */
      confirmDestructive: z.boolean().default(true),
    })
    .prefault({}),

  tools: z
    .object({
      disabled: z.array(z.string()).default([]),
      /** Project tool code runs on open, so it's opt-in (a cloned repo could contain anything). */
      loadProjectExtensions: z.boolean().default(false),
      loadUserExtensions: z.boolean().default(true),
      /** After an edit, check the file with the project's linter or a syntax check and show the model any problems. */
      checkAfterEdit: z.boolean().default(true),
      /** How long the after-edit check may run before it gives up. */
      checkTimeoutSec: z.number().int().min(5).max(300).default(30),
      webSearch: z
        .object({
          /**
           * auto: Brave/Tavily APIs if you added a (free-tier) key, else keyless DuckDuckGo, then Brave's public page.
           * duckduckgo: keyless only. brave/tavily: that API only (key). searxng: your instance (URL).
           */
          backend: z.enum(['auto', 'duckduckgo', 'brave', 'tavily', 'searxng']).default('auto'),
          searxngUrl: z.string().default(''),
        })
        .prefault({}),
      /** The browser / browser_read tools drive a local Chrome, Edge, Brave or Chromium; hidden when none is found. */
      browser: z
        .object({
          enabled: z.boolean().default(true),
          /** Browser executable; empty = detect. */
          path: z.string().default(''),
          /** Run without a window. */
          headless: z.boolean().default(true),
          /** Keep one browser profile in the data folder, so sites stay signed in between chats. Off = a fresh profile each time, deleted afterwards. */
          keepLogins: z.boolean().default(false),
        })
        .prefault({}),
    })
    .prefault({}),

  memory: z
    .object({
      /** Lets the agent save facts across chats (remember/forget tools) and shows them in the prompt. */
      enabled: z.boolean().default(true),
      /** Size limit per scope (project, global). */
      maxChars: z.number().int().min(500).max(50_000).default(6000),
      /** After each finished turn, the memory model saves lasting facts (needs a memory or chat naming model). */
      autoReview: z.boolean().default(true),
    })
    .prefault({}),

  /** Shell commands run around tool calls. Settings only, never from project files. */
  hooks: z
    .object({
      /** Exit code 2 blocks the call; stderr is the reason the model sees. */
      preTool: z.array(HookRuleSchema).default([]),
      /** Stdout is added to the tool result; exit code 2 adds stderr as feedback. */
      postTool: z.array(HookRuleSchema).default([]),
    })
    .prefault({}),

  mcp: z
    .object({
      servers: z.array(McpServerSchema).default([]),
    })
    .prefault({}),

  schedules: z.array(ScheduleSchema).default([]),

  /** Saved agents with a personality; used only while `experimental.bots` is on. */
  bots: z.array(BotSchema).default(() => structuredClone(STARTER_BOTS)),

  /** Reaching the agent from other apps, while this app is open. */
  gateways: z
    .object({
      /** macOS only: texts from your own numbers/Apple ID emails run in a chat; the reply goes back through Messages. */
      imessage: z
        .object({
          enabled: z.boolean().default(false),
          /** Allowed senders, normalized: phones as E.164 (+15551234567), emails lowercased. Empty = nobody. */
          senders: z.array(z.string()).default([]),
          /** Folder the chats run in. Required. */
          cwd: z.string().default(''),
          /** A bot for the chats (only while bots are on). */
          botId: z.string().nullable().default(null),
          /** Ask by default, so approvals come back to the app. */
          mode: z.enum(PERMISSION_MODES).default('ask'),
          pollSeconds: z.number().int().min(2).max(300).default(5),
        })
        .prefault({}),
    })
    .prefault({}),

  /** Preview features, off by default. */
  experimental: z
    .object({
      /** Bots in the sidebar and Settings › Bots. Off: bot chats open as plain chats; bots and their memories are kept. */
      bots: z.boolean().default(false),
    })
    .prefault({}),

  sessions: z
    .object({
      /** Delete chats not touched for this many days. null = keep them forever. */
      retentionDays: z.number().int().min(1).max(3650).nullable().default(null),
    })
    .prefault({}),

  /** Rebound keyboard shortcuts: action id → combo like "Mod+K" (Mod = ⌘ on macOS, Ctrl elsewhere). Missing = the default. */
  shortcuts: z.record(z.string(), z.string()).default({}),

  voice: z
    .object({
      /** auto: the downloaded local model when there is one, else the transcription model under Models. */
      engine: z.enum(['auto', 'local', 'provider']).default('auto'),
      /** Which downloaded whisper.cpp model to use (and to download). */
      localModel: z.enum(['tiny', 'base', 'small']).default('base'),
      /** Shows the mic button when an engine is set up. */
      enabled: z.boolean().default(true),
      /** A recording stops and is transcribed after this long. */
      maxRecordingSec: z.number().int().min(10).max(600).default(120),
      /** Spoken language as an ISO 639-1 code ("en", "tr"); empty = detect. */
      language: z.string().max(8).default(''),
      /** Send the message as soon as the recording is transcribed, instead of leaving it in the message box. */
      autoSend: z.boolean().default(false),
    })
    .prefault({}),

  /** Who the user is, from onboarding or Settings › Profile. Shapes the prompt's `profile` section. */
  profile: z
    .object({
      /** What the agent calls the user; empty = no name. */
      name: z.string().max(80).default(''),
      role: z.enum(PROFILE_ROLES).nullable().default(null),
      experience: z.enum(PROFILE_EXPERIENCE).nullable().default(null),
      /** What they mainly use the app for. */
      uses: z.array(z.enum(PROFILE_USES)).default([]),
      /** The language the agent replies in, in English ("Turkish"); empty = the language of the user's messages. The UI stays English. */
      language: z.string().max(40).default(''),
    })
    .prefault({}),

  privacy: z
    .object({
      /** Send anonymous usage counts and error reports (Settings › About › Privacy). Never prompts, code, file names, paths or keys. */
      shareUsage: z.boolean().default(true),
    })
    .prefault({}),

  usage: z
    .object({
      showCost: z.boolean().default(true),
      showPerMessageUsage: z.boolean().default(true),
      sessionBudgetUsd: z.number().min(0).nullable().default(null),
      dailyBudgetUsd: z.number().min(0).nullable().default(null),
      /** 'warn' shows a banner, 'stop' refuses further requests. */
      budgetAction: z.enum(['warn', 'stop']).default('warn'),
    })
    .prefault({}),

  appearance: z
    .object({
      theme: z.enum(['system', 'dark', 'light', 'oled', 'sepia', 'contrast']).default('system'),
      fontSize: z.number().int().min(10).max(24).default(14),
      /** Interface and chat font (a CSS font stack); empty = the system font. */
      fontFamily: z.string().default(''),
      codeFontFamily: z.string().default('ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'),
      density: z.enum(['comfortable', 'compact']).default('comfortable'),
      expandToolCalls: z.boolean().default(false),
      showReasoning: z.boolean().default(true),
      sendWithEnter: z.boolean().default(true),
      /** basic: sidebar and chat. elite: also a right panel (files, changes) and a bottom terminal, open at launch. */
      layout: z.enum(['basic', 'elite']).default('basic'),
    })
    .prefault({}),

  app: z
    .object({
      autoUpdate: z.boolean().default(true),
      /** System notification when a chat you're not looking at finishes or needs approval. */
      notifications: z.boolean().default(true),
      /** Which background-chat events notify (when `notifications` is on). */
      notify: z
        .object({
          finished: z.boolean().default(true),
          /** Stopped with an error, at the step limit or at the budget. */
          failed: z.boolean().default(true),
          approval: z.boolean().default(true),
          question: z.boolean().default(true),
        })
        .prefault({}),
      /** Start the app when you log in (macOS and Windows). */
      launchAtLogin: z.boolean().default(false),
      /** On launch, show the last folder's most recent chat; off starts a new chat there. */
      resumeLastChat: z.boolean().default(true),
      /** Stop the computer from sleeping: never, while a chat is working, or while the app is open. */
      keepAwake: z.enum(['off', 'working', 'always']).default('off'),
      lastWorkspace: z.string().nullable().default(null),
      /** Folders shown in the sidebar, in order. */
      openWorkspaces: z.array(z.string()).default([]),
      /** Provider cards folded shut in Settings › Providers › API keys. */
      collapsedProviders: z.array(z.string()).default([]),
      recentWorkspaces: z.array(z.string()).default([]),
      /** First-run setup was finished or skipped. Existing installs are marked onboarded at launch. */
      onboarded: z.boolean().default(false),
      /** The layout picker was answered (it shows once). */
      layoutChosen: z.boolean().default(false),
      /** Plugin suggestions dismissed on the Welcome screen. */
      skippedPlugins: z.array(z.string()).default([]),
      /** Sizes (px) and open state of the right and bottom panels. */
      panels: z
        .object({
          right: z.number().int().min(220).max(1200).default(360),
          bottom: z.number().int().min(120).max(1000).default(260),
          rightOpen: z.boolean().default(false),
          bottomOpen: z.boolean().default(false),
        })
        .prefault({}),
    })
    .prefault({}),
})

export type Settings = z.infer<typeof SettingsSchema>

export function parseSettings(raw: unknown): Settings {
  const res = SettingsSchema.safeParse(raw ?? {})
  if (res.success) return res.data
  // Corrupt/partial settings should never brick the app: fall back section by section.
  const base = SettingsSchema.parse({})
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(base) as (keyof Settings)[]) {
      const one = SettingsSchema.shape[key].safeParse((raw as Record<string, unknown>)[key])
      if (one.success) (base as Record<string, unknown>)[key] = one.data
    }
  }
  return base
}

export function defaultSettings(): Settings {
  return SettingsSchema.parse({})
}

export function modelKey(ref: { providerId: string; modelId: string }): string {
  return `${ref.providerId}:${ref.modelId}`
}
