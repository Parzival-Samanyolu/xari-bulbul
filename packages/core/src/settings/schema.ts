import { z } from 'zod'

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
})
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    enabled: true,
    headers: { 'HTTP-Referer': 'https://github.com/harness-agent/harness', 'X-Title': 'Xari Bulbul' },
    requestUsageCost: true,
    requiresKey: true,
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    enabled: true,
    headers: {},
    requestUsageCost: false,
    requiresKey: true,
  },
]

/** One-click presets for common OpenAI-compatible servers. */
export const PROVIDER_PRESETS: Omit<ProviderConfig, 'enabled' | 'headers' | 'requestUsageCost'>[] = [
  { id: 'ollama-local', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', requiresKey: false },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', requiresKey: false },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', requiresKey: true },
]

/** A provider can be used when it's enabled and either has a key or doesn't need one. */
export function providerReady(config: ProviderConfig | undefined, hasKey: boolean): boolean {
  return !!config && config.enabled && (hasKey || !config.requiresKey)
}

const ModelRefSchema = z.object({ providerId: z.string(), modelId: z.string() })

export const ModelOverrideSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).optional(),
  contextLength: z.number().int().positive().optional(),
})

export const SettingsSchema = z.object({
  providers: z.array(ProviderConfigSchema).default(BUILTIN_PROVIDERS),

  models: z
    .object({
      // OpenRouter's free router: picks an available free model for each request.
      default: ModelRefSchema.default({ providerId: 'openrouter', modelId: 'openrouter/free' }),
      /** Model used to summarize old turns. Empty = use the active model. */
      compaction: ModelRefSchema.nullable().default(null),
      favorites: z.array(ModelRefSchema).default([]),
      /** Most recently used models, newest first (maintained automatically). */
      recent: z.array(ModelRefSchema).default([]),
      picker: z
        .object({
          /** Hide paid models from providers that report pricing. */
          freeOnly: z.boolean().default(true),
          toolsOnly: z.boolean().default(true),
          sort: z.enum(['newest', 'name', 'context', 'price']).default('newest'),
        })
        .prefault({}),
      /** Per-model overrides keyed by `${providerId}:${modelId}`. */
      overrides: z.record(z.string(), ModelOverrideSchema).default({}),
      temperature: z.number().min(0).max(2).nullable().default(null),
      maxTokens: z.number().int().positive().nullable().default(null),
      reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).nullable().default(null),
      /** Fallback context size when a provider doesn't report one. */
      defaultContextLength: z.number().int().positive().default(128_000),
    })
    .prefault({}),

  agent: z
    .object({
      maxStepsPerTurn: z.number().int().min(1).max(500).default(50),
      customInstructions: z.string().default(''),
      /** Replace the built-in system prompt entirely (advanced). */
      systemPromptOverride: z.string().default(''),
      compactionEnabled: z.boolean().default(true),
      compactionThreshold: z.number().min(0.3).max(0.98).default(0.8),
      toolOutputMaxChars: z.number().int().min(1000).default(30_000),
      bashTimeoutSec: z.number().int().min(1).max(3600).default(120),
      /** Empty = platform default (PowerShell on Windows, $SHELL or /bin/bash elsewhere). */
      shell: z.string().default(''),
      projectInstructionFiles: z.array(z.string()).default(['AGENTS.md', 'HARNESS.md', 'CLAUDE.md']),
      requestRetries: z.number().int().min(0).max(10).default(3),
      subagents: z
        .object({
          /** Gives the agent the `task` tool. */
          enabled: z.boolean().default(true),
          /** null = the chat's own model. A cheaper or free model is a good fit for searching. */
          model: ModelRefSchema.nullable().default(null),
          maxSteps: z.number().int().min(1).max(200).default(25),
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
      theme: z.enum(['system', 'dark', 'light']).default('system'),
      fontSize: z.number().int().min(10).max(24).default(14),
      codeFontFamily: z.string().default('ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'),
      density: z.enum(['comfortable', 'compact']).default('comfortable'),
      expandToolCalls: z.boolean().default(false),
      showReasoning: z.boolean().default(true),
      sendWithEnter: z.boolean().default(true),
    })
    .prefault({}),

  app: z
    .object({
      autoUpdate: z.boolean().default(true),
      /** System notification when a chat you're not looking at finishes or needs approval. */
      notifications: z.boolean().default(true),
      lastWorkspace: z.string().nullable().default(null),
      recentWorkspaces: z.array(z.string()).default([]),
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
