import { modelMaker } from '@harness/core/catalog'

// Marks from LobeHub icons (MIT), named by provider or model-maker id. Monochrome ones use
// currentColor so they follow the theme; ones with gradients render as images, because inline
// copies of the same gradient id break when the first copy is hidden.
const FILES = import.meta.glob<string>('../assets/providers/*.svg', { eager: true, query: '?raw', import: 'default' })
const LOGOS: Record<string, string> = Object.fromEntries(Object.entries(FILES).map(([path, svg]) => [path.replace(/^.*\/|\.svg$/g, ''), svg]))
const ALIASES: Record<string, string> = { 'ollama-cloud': 'ollama', 'ollama-local': 'ollama' }

/** Provider or model-maker mark, or the name's first letter when there's no logo. Decorative: a name is always shown next to it. */
export function ProviderLogo({ id, name, size = 14, letter = true }: { id: string; name?: string; size?: number; letter?: boolean }) {
  const svg = LOGOS[ALIASES[id] ?? id]
  const style = { width: size, height: size, fontSize: Math.round(size * 0.7) }
  if (svg?.includes('url(#')) return <img className="provider-logo" style={style} alt="" src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} />
  if (svg) return <span className="provider-logo" style={style} aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />
  if (!letter) return null
  return (
    <span className="provider-logo letter" style={style} aria-hidden>
      {(name ?? id).charAt(0).toUpperCase()}
    </span>
  )
}

/** The logo of the company that made a model, when it's known and differs from the provider serving it. */
export function MakerLogo({ modelId, providerId, size = 14 }: { modelId: string; providerId: string; size?: number }) {
  const maker = modelMaker(modelId)
  if (!maker || maker === (ALIASES[providerId] ?? providerId)) return null
  return <ProviderLogo id={maker} size={size} letter={false} />
}
