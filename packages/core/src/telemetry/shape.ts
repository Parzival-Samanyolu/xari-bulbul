import { BUILTIN_PROVIDERS, PROVIDER_PRESETS, type ProviderConfig, type Settings } from '../settings/schema.js'
import { PROFILE_EXPERIENCE, PROFILE_ROLES } from '../settings/profile.js'
import { CURATED_MODELS } from '../local/models.js'
import { LOCAL_PROVIDER_ID } from '../local/server.js'
import type { ModelRef } from '../types.js'
import type { TelemetryProps } from './client.js'

// What share info may say about models, providers and the user's setup. Names the user gives
// things (custom providers, endpoints, bots, MCP servers, schedules) and anything that could be a
// path, URL or key never leave: custom providers are 'custom', and the setup is counts and on/off.

const CUSTOM = 'custom'

/** Hosted providers and presets whose ids and model ids are public. */
const KNOWN_URLS = new Map<string, string>([
  ...BUILTIN_PROVIDERS.map((p) => [p.id, p.baseUrl] as const),
  ...PROVIDER_PRESETS.filter((p) => p.requiresKey).map((p) => [p.id, p.baseUrl] as const),
])
/** Local servers: the id is a preset's, but model names are whatever the user called them. */
const LOCAL_SERVERS = new Set(PROVIDER_PRESETS.filter((p) => !p.requiresKey).map((p) => p.id))

const trimUrl = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase()
/** Fine-tuned or tuned models carry an organisation or the user's own name. */
const PRIVATE_MODEL = /(^|[/:])ft[:-]|tunedModels\/|^accounts\//i
const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,128}$/

/**
 * The provider id share info sends: a built-in's id while it points at its own URL, `local` for the
 * app's llama.cpp server, a local server preset's id, and 'custom' for anything else.
 */
export function telemetryProvider(providerId: string, providers: readonly ProviderConfig[]): string {
  if (providerId === LOCAL_PROVIDER_ID) return 'local'
  const config = providers.find((p) => p.id === providerId)
  if (!config) return CUSTOM
  if (LOCAL_SERVERS.has(providerId)) return providerId
  const url = KNOWN_URLS.get(providerId)
  return url && trimUrl(url) === trimUrl(config.baseUrl) ? providerId : CUSTOM
}

/** Provider and model as share info sends them; see `telemetryProvider`. */
export function telemetryModel(ref: ModelRef, providers: readonly ProviderConfig[]): { provider: string; model: string } {
  const provider = telemetryProvider(ref.providerId, providers)
  if (provider === 'local') {
    // Only the app's own curated downloads are named; anything else could be the user's file.
    const curated = CURATED_MODELS.find((m) => m.id === ref.modelId)
    return { provider, model: curated ? curated.weights.file : CUSTOM }
  }
  if (provider === CUSTOM || LOCAL_SERVERS.has(provider)) return { provider, model: CUSTOM }
  const id = ref.modelId.trim()
  return { provider, model: MODEL_ID.test(id) && !PRIVATE_MODEL.test(id) ? id : CUSTOM }
}

// ---------------------------------------------------------------- the setup snapshot

export interface SystemInfo {
  /** The OS's own version ("15.1.0", "10.0.22631", a Linux kernel release). */
  osVersion?: string
  /** "tr-TR", "en_US", "en". */
  locale?: string
  ramBytes?: number
  cpus?: number
  /** The primary display's size in points. */
  screen?: { width: number; height: number }
}

/** What the host knows that settings don't. */
export interface SetupCounts {
  /** Providers that are on and have a key (or need none). */
  connectedProviders: number
  plugins: number
  skills: number
  /** Downloaded models for the app's llama.cpp server. */
  localModels: number
  /** A voice input engine is set up and on. */
  voice: boolean
  packaged: boolean
}

/** Major.minor only. */
export function osVersionBucket(v: string | undefined): string {
  const m = /^(\d{1,5})(?:\.(\d{1,5}))?/.exec(String(v ?? '').trim())
  return m ? `${m[1]}.${m[2] ?? '0'}` : 'unknown'
}

/** Language and region ("tr-TR"); just the language when there's no region. */
export function localeBucket(l: string | undefined): string {
  const m = /^([A-Za-z]{2,3})(?:[-_]([A-Za-z]{2}|\d{3}))?(?:[-_.@]|$)/.exec(String(l ?? '').trim())
  if (!m) return 'unknown'
  return m[2] ? `${m[1].toLowerCase()}-${m[2].toUpperCase()}` : m[1].toLowerCase()
}

export function ramBucket(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return 'unknown'
  const gb = bytes / 1024 ** 3
  return gb < 6 ? '4' : gb < 12 ? '8' : gb < 24 ? '16' : '32+'
}

export function cpuBucket(n: number | undefined): string {
  if (!n || !Number.isFinite(n)) return 'unknown'
  return n <= 2 ? '2' : n <= 4 ? '4' : n <= 8 ? '8' : n <= 12 ? '12' : '16+'
}

/** By width: the common laptop and desktop steps. */
export function screenBucket(s: SystemInfo['screen']): string {
  const w = s?.width
  if (!w || !Number.isFinite(w)) return 'unknown'
  return w < 1280 ? '<1280' : w < 1440 ? '1280' : w < 1920 ? '1440' : w < 2560 ? '1920' : '2560+'
}

/** The features `app.snapshot` reports as on, in this order. */
export const SNAPSHOT_FEATURES = ['bots', 'voice', 'tts', 'memory', 'moa', 'fallbacks', 'local_models', 'imessage', 'whatsapp', 'schedules'] as const

/**
 * The `app.snapshot` props: system buckets, the shape of the settings (counts, choices from fixed
 * lists, on/off) and the onboarding role and experience. On/off features are one comma-separated
 * `features` list so the event stays under the server's 20 props.
 */
export function appSnapshot(settings: Settings, system: SystemInfo, counts: SetupCounts): TelemetryProps {
  const on: Record<(typeof SNAPSHOT_FEATURES)[number], boolean> = {
    bots: settings.botOptions.enabled && settings.bots.some((b) => b.enabled),
    voice: counts.voice,
    tts: settings.voice.tts.readAloud,
    memory: settings.memory.enabled,
    moa: settings.moa.enabled && settings.moa.proposers.length >= 2 && !!settings.moa.aggregator,
    fallbacks: settings.models.fallbacks.length > 0,
    local_models: counts.localModels > 0,
    imessage: settings.gateways.imessage.enabled,
    whatsapp: settings.gateways.whatsapp.enabled,
    schedules: settings.schedules.some((s) => s.enabled),
  }
  const role = settings.profile.role
  const experience = settings.profile.experience
  return {
    os_version: osVersionBucket(system.osVersion),
    locale: localeBucket(system.locale),
    ram: ramBucket(system.ramBytes),
    cpus: cpuBucket(system.cpus),
    screen: screenBucket(system.screen),
    packaged: counts.packaged,
    layout: settings.appearance.layout,
    theme: settings.appearance.theme,
    mode: settings.permissions.mode,
    provider: telemetryProvider(settings.models.default.providerId, settings.providers),
    providers: count(counts.connectedProviders),
    mcp: settings.mcp.servers.length,
    plugins: count(counts.plugins),
    skills: count(counts.skills),
    bots: settings.bots.length,
    features: SNAPSHOT_FEATURES.filter((f) => on[f]).join(','),
    role: role && (PROFILE_ROLES as readonly string[]).includes(role) ? role : 'unset',
    experience: experience && (PROFILE_EXPERIENCE as readonly string[]).includes(experience) ? experience : 'unset',
  }
}

const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

/** `app.session`, sent on quit. */
export function appSession(startedAt: number, now: number, chats: number): TelemetryProps {
  return { minutes: Math.max(0, Math.round((now - startedAt) / 60_000)), chats: count(chats) }
}
